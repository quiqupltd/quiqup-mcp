/**
 * Dedicated MSW-mocked client test suite for `AuditClient`.
 *
 * The critical lockdown lives here: the suite asserts that the outbound
 * request carries the caller's Clerk JWT as a Bearer token. Audit rejects
 * every read without one (sc-30350), so a future "simplification" that
 * drops the header would break order history for everyone.
 *
 * Per WR-05: AUDIT_BASE_URL AND AUDIT_STAGING_BASE_URL are deleted in
 * beforeEach so a developer with the var set in their shell does not
 * silently route fetches around MSW (the handlers bind to the canonical
 * audit.quiqup.com host).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup/msw";
import { AuditClient, AuditError } from "@/lib/clients/audit";

const AUDIT_PROD = "https://audit.quiqup.com";
const AUDIT_STAGING = "https://audit.staging.quiqup.com";

const originalProdUrl = process.env.AUDIT_BASE_URL;
const originalStagingUrl = process.env.AUDIT_STAGING_BASE_URL;

beforeEach(() => {
  // WR-05: clear both env-var families so MSW catches the canonical hosts.
  delete process.env.AUDIT_BASE_URL;
  delete process.env.AUDIT_STAGING_BASE_URL;
});

afterEach(() => {
  if (originalProdUrl === undefined) {
    delete process.env.AUDIT_BASE_URL;
  } else {
    process.env.AUDIT_BASE_URL = originalProdUrl;
  }
  if (originalStagingUrl === undefined) {
    delete process.env.AUDIT_STAGING_BASE_URL;
  } else {
    process.env.AUDIT_STAGING_BASE_URL = originalStagingUrl;
  }
});

describe("AuditClient", () => {
  it("forwards the caller's JWT as a Bearer token", async () => {
    let capturedHeaders: Headers | null = null;
    server.use(
      http.get(`${AUDIT_PROD}/events`, ({ request }) => {
        capturedHeaders = request.headers;
        return HttpResponse.json({ events: [] });
      }),
    );

    const client = new AuditClient({ jwt: "clerk-session-jwt" });
    await client.request("GET", "/events", {
      query: { "resourceID.eq": "uuid-1" },
    });

    expect(capturedHeaders).not.toBeNull();
    const headers = capturedHeaders as unknown as Headers;
    expect(headers.get("Authorization")).toBe("Bearer clerk-session-jwt");
    expect(headers.get("Accept")).toBe("application/json");
  });

  it("surfaces a 401 from Audit as an AuditError", async () => {
    server.use(
      http.get(`${AUDIT_PROD}/events`, () =>
        HttpResponse.json({ message: "Unauthorized" }, { status: 401 }),
      ),
    );

    const client = new AuditClient({ jwt: "expired" });
    await expect(
      client.request("GET", "/events", {
        query: { "resourceID.eq": "uuid-1" },
      }),
    ).rejects.toMatchObject({ name: "AuditError", status: 401 });
  });

  it("appends resourceID.eq via URLSearchParams with dotted key intact", async () => {
    let capturedUrl: string | null = null;
    server.use(
      http.get(`${AUDIT_PROD}/events`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ events: [] });
      }),
    );

    const client = new AuditClient({ jwt: "test-jwt" });
    const uuid = "6d0c2ad3-4dcf-4e3a-aa72-89e6f6c2a9b5";
    await client.request("GET", "/events", {
      query: { "resourceID.eq": uuid },
    });

    expect(capturedUrl).not.toBeNull();
    const parsed = new URL(capturedUrl as unknown as string);
    // Dotted key must round-trip — the upstream filter syntax is literal.
    expect(parsed.searchParams.get("resourceID.eq")).toBe(uuid);
  });

  it("returns parsed JSON on 200", async () => {
    const stub = {
      events: [
        {
          eventID: "evt_1",
          resourceID: "uuid-1",
          occurredAt: "2026-05-19T10:00:00Z",
          actor: { email: "ops@example.com" },
          action: "update",
          changes: { address: { from: "old", to: "new" } },
        },
      ],
    };
    server.use(
      http.get(`${AUDIT_PROD}/events`, () => HttpResponse.json(stub)),
    );

    const client = new AuditClient({ jwt: "test-jwt" });
    const data = await client.request("GET", "/events", {
      query: { "resourceID.eq": "uuid-1" },
    });

    expect(data).toEqual(stub);
  });

  it("throws AuditError on non-2xx", async () => {
    server.use(
      http.get(`${AUDIT_PROD}/events`, () =>
        HttpResponse.json({ error: "boom" }, { status: 503 }),
      ),
    );

    const client = new AuditClient({ jwt: "test-jwt" });
    let caught: unknown = null;
    try {
      await client.request("GET", "/events", {
        query: { "resourceID.eq": "uuid-1" },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AuditError);
    expect((caught as AuditError).status).toBe(503);
  });

  it("honours AUDIT_BASE_URL env override", async () => {
    process.env.AUDIT_BASE_URL = "https://localhost.test";
    let hit = false;
    server.use(
      http.get("https://localhost.test/events", () => {
        hit = true;
        return HttpResponse.json({ events: [] });
      }),
    );

    const client = new AuditClient({ jwt: "test-jwt" });
    await client.request("GET", "/events", {
      query: { "resourceID.eq": "uuid-1" },
    });
    expect(hit).toBe(true);
  });

  it("environment: staging routes to staging cluster", async () => {
    let hit = false;
    server.use(
      http.get(`${AUDIT_STAGING}/events`, () => {
        hit = true;
        return HttpResponse.json({ events: [] });
      }),
    );

    const client = new AuditClient({ jwt: "test-jwt", environment: "staging" });
    await client.request("GET", "/events", {
      query: { "resourceID.eq": "uuid-1" },
    });
    expect(hit).toBe(true);
  });
});
