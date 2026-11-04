/**
 * MSW-mocked Vitest suite for the two Phase-3 / Wave-2 Orders read tools:
 *   - `get_order_history` (ORDS-02) — Quiqup REST host, standard Bearer auth.
 *   - `list_order_audit_events` (ORDS-05) — Audit host, Bearer auth (Audit
 *     requires the caller's Clerk token since sc-30350).
 *
 * Coverage per tool follows the same contract used in
 * `orders-graphql-reads.test.ts` and `auth-account-reads.test.ts`:
 *   - Happy path (text content carries the mocked response shape).
 *   - Boundary-correct auth posture (Bearer present for both Quiqup REST
 *     and Audit — locks it at the tool layer in addition to the
 *     client-layer lockdown in tests/clients/audit.test.ts).
 *   - Missing `auth.userId` — handler throws before any fetch.
 *   - HTTP non-2xx — surfaces as the appropriate error type.
 *   - Path-param / query-param hygiene.
 *
 * Per WR-05: ALL FOUR new env-var families
 *   (QUIQUP_REST_BASE_URL, QUIQUP_REST_STAGING_BASE_URL,
 *    AUDIT_BASE_URL, AUDIT_STAGING_BASE_URL)
 * are deleted in beforeEach so a developer with the var set in their shell
 * does not silently route fetches around MSW (the handlers below bind to
 * the canonical production hosts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup/msw";
import { QuiqupHttpError } from "../../lib/clients/quiqup-lastmile";
import { AuditError } from "../../lib/clients/audit";

vi.mock("@/lib/quiqup", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getQuiqupReadyJwt: vi.fn(async (_userId: string) => "test-jwt-for-msw"),
  };
});

const auth = {
  userId: "user_test",
  orgId: null,
  sessionId: "sess_test",
  scopes: ["read"],
  bearerToken: "inbound_at_jwt_unused_in_v3b",
};

const authAnon = {
  userId: null,
  orgId: null,
  sessionId: null,
  scopes: [],
  bearerToken: null,
};

const QUIQUP_REST = "https://api.quiqup.com";
const AUDIT_PROD = "https://audit.quiqup.com";

// Capture+restore originals so other suites are unaffected.
const originalQuiqupRest = process.env.QUIQUP_REST_BASE_URL;
const originalQuiqupRestStaging = process.env.QUIQUP_REST_STAGING_BASE_URL;
const originalAudit = process.env.AUDIT_BASE_URL;
const originalAuditStaging = process.env.AUDIT_STAGING_BASE_URL;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.QUIQUP_REST_BASE_URL;
  delete process.env.QUIQUP_REST_STAGING_BASE_URL;
  delete process.env.AUDIT_BASE_URL;
  delete process.env.AUDIT_STAGING_BASE_URL;
});

afterEach(() => {
  if (originalQuiqupRest === undefined) {
    delete process.env.QUIQUP_REST_BASE_URL;
  } else {
    process.env.QUIQUP_REST_BASE_URL = originalQuiqupRest;
  }
  if (originalQuiqupRestStaging === undefined) {
    delete process.env.QUIQUP_REST_STAGING_BASE_URL;
  } else {
    process.env.QUIQUP_REST_STAGING_BASE_URL = originalQuiqupRestStaging;
  }
  if (originalAudit === undefined) {
    delete process.env.AUDIT_BASE_URL;
  } else {
    process.env.AUDIT_BASE_URL = originalAudit;
  }
  if (originalAuditStaging === undefined) {
    delete process.env.AUDIT_STAGING_BASE_URL;
  } else {
    process.env.AUDIT_STAGING_BASE_URL = originalAuditStaging;
  }
});

describe("get_order_history", () => {
  const historyStub = {
    history: [
      {
        to_state: "delivered",
        occurred_at: "2026-05-19T09:00:00Z",
        author: { email: "ops@example.com", fullname: "Ops User", role: "ops" },
        custodian: { custodian_name: "rider-1", custodian_type: "rider" },
        delivery_metrics: { calls: 1, messages: 0 },
        on_hold_reason: null,
        reason: null,
        return_to_origin_reason: null,
        internal_order: null,
        events: [],
      },
    ],
  };

  it("happy path returns history[] from Quiqup REST", async () => {
    server.use(
      http.get(`${QUIQUP_REST}/orders/12345/history`, () =>
        HttpResponse.json(historyStub),
      ),
    );

    const mod = await import("../../lib/tools/get-order-history");
    const result = await mod.spec.handler(auth, {
      order_id: "12345",
      environment: "production",
    });

    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain('"to_state"');
    expect(text).toContain("delivered");
  });

  it("encodes order_id in the URL (path-param hygiene)", async () => {
    let capturedUrl: string | null = null;
    // The path matcher needs to be permissive — match any /orders/:id/history
    // so we can observe how the handler encoded the LLM-supplied id.
    server.use(
      http.get(`${QUIQUP_REST}/orders/:id/history`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ history: [] });
      }),
    );

    const mod = await import("../../lib/tools/get-order-history");
    await mod.spec.handler(auth, {
      // A character that MUST be percent-encoded in the path component.
      order_id: "abc/def",
      environment: "production",
    });

    expect(capturedUrl).not.toBeNull();
    // %2F is the canonical encoding for `/` in path components.
    expect(capturedUrl).toContain("/orders/abc%2Fdef/history");
  });

  it("sends Authorization: Bearer header (standard Quiqup REST auth posture)", async () => {
    let capturedHeaders: Headers | null = null;
    server.use(
      http.get(`${QUIQUP_REST}/orders/:id/history`, ({ request }) => {
        capturedHeaders = request.headers;
        return HttpResponse.json({ history: [] });
      }),
    );

    const mod = await import("../../lib/tools/get-order-history");
    await mod.spec.handler(auth, {
      order_id: "12345",
      environment: "production",
    });

    expect(capturedHeaders).not.toBeNull();
    const headers = capturedHeaders as unknown as Headers;
    const authz = headers.get("Authorization");
    expect(authz).not.toBeNull();
    expect(authz?.startsWith("Bearer ")).toBe(true);
  });

  it("rejects unauthenticated callers (missing auth.userId)", async () => {
    const mod = await import("../../lib/tools/get-order-history");
    await expect(
      mod.spec.handler(authAnon, {
        order_id: "12345",
        environment: "production",
      }),
    ).rejects.toThrow(/requires an authenticated user/);
  });

  it("maps HTTP 401 to QuiqupHttpError", async () => {
    server.use(
      http.get(`${QUIQUP_REST}/orders/:id/history`, () =>
        HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );

    const mod = await import("../../lib/tools/get-order-history");
    let thrown: unknown = null;
    try {
      await mod.spec.handler(auth, {
        order_id: "12345",
        environment: "production",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(QuiqupHttpError);
    expect((thrown as QuiqupHttpError).status).toBe(401);
  });

  it("stalled upstream surfaces as TimeoutError (AbortSignal.timeout discipline)", async () => {
    // Asserts that when AbortSignal.timeout() fires under a stalled
    // upstream, the resulting `TimeoutError` propagates verbatim through
    // QuiqupRestClient.request -> tool handler -> caller — i.e., callers
    // see a labelled, agent-actionable error instead of the bare
    // "fetch failed" symptom from the previous session.
    //
    // We assert the propagation pathway directly: stub `fetch` to reject
    // synchronously with the exact error shape `AbortSignal.timeout()`
    // produces at runtime (a DOMException-like object with
    // name === "TimeoutError"). This is robust against vitest's fake-timer
    // semantics, which do NOT mock the internal Node timer that
    // `AbortSignal.timeout()` uses — using real timers here would force a
    // 25s wall-clock wait per run.
    //
    // The plan permits this alternative ("mock `fetch` directly ... assert
    // the same TimeoutError name").
    const originalFetch = globalThis.fetch;
    let observedSignal: AbortSignal | undefined;
    const fetchSpy = vi.fn((_url: string, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      const err = Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError",
      });
      return Promise.reject(err);
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const mod = await import("../../lib/tools/get-order-history");
      let thrown: unknown = null;
      try {
        await mod.spec.handler(auth, {
          order_id: "12345",
          environment: "production",
        });
      } catch (err) {
        thrown = err;
      }
      // 1) The client actually wired an AbortSignal — guards against a
      //    regression where the signal: option is dropped from request().
      expect(observedSignal).toBeInstanceOf(AbortSignal);
      // 2) The labelled TimeoutError propagates verbatim (no rewrap to
      //    QuiqupHttpError, no swallow, no "fetch failed").
      expect(thrown).not.toBeNull();
      expect((thrown as { name?: string }).name).toBe("TimeoutError");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("list_order_audit_events", () => {
  const auditStub = {
    events: [
      {
        eventID: "evt_42",
        resourceID: "6d0c2ad3-4dcf-4e3a-aa72-89e6f6c2a9b5",
        occurredAt: "2026-05-19T10:00:00Z",
        actor: { email: "editor@example.com" },
        action: "update",
        changes: { address: { from: "Old", to: "New" } },
      },
    ],
  };

  it("happy path returns events[] from Audit", async () => {
    server.use(
      http.get(`${AUDIT_PROD}/events`, () => HttpResponse.json(auditStub)),
    );

    const mod = await import("../../lib/tools/list-order-audit-events");
    const result = await mod.spec.handler(auth, {
      order_uuid: "6d0c2ad3-4dcf-4e3a-aa72-89e6f6c2a9b5",
      environment: "production",
    });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain('"eventID"');
    expect(text).toContain("evt_42");
  });

  it("forwards the caller's Clerk JWT as a Bearer token (tool-level lockdown)", async () => {
    let capturedHeaders: Headers | null = null;
    server.use(
      http.get(`${AUDIT_PROD}/events`, ({ request }) => {
        capturedHeaders = request.headers;
        return HttpResponse.json({ events: [] });
      }),
    );

    const mod = await import("../../lib/tools/list-order-audit-events");
    await mod.spec.handler(auth, {
      order_uuid: "6d0c2ad3-4dcf-4e3a-aa72-89e6f6c2a9b5",
      environment: "production",
    });

    expect(capturedHeaders).not.toBeNull();
    const headers = capturedHeaders as unknown as Headers;
    // The mocked getQuiqupReadyJwt returns "test-jwt-for-msw". Audit 401s
    // any read without a valid token (sc-30350), so the handler must mint
    // and forward it rather than build a header-less client.
    expect(headers.get("Authorization")).toBe("Bearer test-jwt-for-msw");
  });

  it("appends resourceID.eq with the UUID", async () => {
    let capturedUrl: string | null = null;
    server.use(
      http.get(`${AUDIT_PROD}/events`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ events: [] });
      }),
    );

    const uuid = "6d0c2ad3-4dcf-4e3a-aa72-89e6f6c2a9b5";
    const mod = await import("../../lib/tools/list-order-audit-events");
    await mod.spec.handler(auth, {
      order_uuid: uuid,
      environment: "production",
    });

    expect(capturedUrl).not.toBeNull();
    const parsed = new URL(capturedUrl as unknown as string);
    expect(parsed.searchParams.get("resourceID.eq")).toBe(uuid);
  });

  it("rejects unauthenticated callers (missing auth.userId)", async () => {
    const mod = await import("../../lib/tools/list-order-audit-events");
    await expect(
      mod.spec.handler(authAnon, {
        order_uuid: "6d0c2ad3-4dcf-4e3a-aa72-89e6f6c2a9b5",
        environment: "production",
      }),
    ).rejects.toThrow(/requires an authenticated user/);
  });

  it("rejects non-UUID order_uuid at the schema layer", async () => {
    const mod = await import("../../lib/tools/list-order-audit-events");
    const parsed = mod.spec.inputSchema.safeParse({
      order_uuid: "not-a-uuid",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects HTTP errors via AuditError", async () => {
    server.use(
      http.get(`${AUDIT_PROD}/events`, () =>
        HttpResponse.json({ error: "boom" }, { status: 502 }),
      ),
    );

    const mod = await import("../../lib/tools/list-order-audit-events");
    let thrown: unknown = null;
    try {
      await mod.spec.handler(auth, {
        order_uuid: "6d0c2ad3-4dcf-4e3a-aa72-89e6f6c2a9b5",
        environment: "production",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AuditError);
    expect((thrown as AuditError).status).toBe(502);
  });
});
