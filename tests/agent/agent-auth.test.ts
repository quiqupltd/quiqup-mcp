/**
 * Verifier for /agent/mcp: platform token as bearer, validated on /me.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup/msw";
import {
  verifyAgentRequest,
  VERIFY_CACHE_TTL_MS,
  _resetAgentAuthCacheForTests,
  _agentAuthCacheSnapshotForTests,
} from "@/lib/agent-auth";
import { PLATFORM, PLATFORM_STAGING, TOKEN } from "./helpers";

const ME_OK = {
  id: "u1",
  email: "merchant@example.com",
  salesforce_id: "001ABC",
  core_api_user_id: 4242,
  admin: false,
  csr: false,
  roles: ["partner"],
};

function req(headers: Record<string, string | undefined> = {}) {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) h[k] = v;
  return new Request("http://localhost/agent/mcp", { method: "POST", headers: h });
}
const good = { Authorization: `Bearer ${TOKEN}`, "X-Quiqup-Agent": "carol" };

const saved = {
  prod: process.env.QUIQUP_PLATFORM_API_BASE_URL,
  stg: process.env.QUIQUP_PLATFORM_API_STAGING_BASE_URL,
};
beforeEach(() => {
  _resetAgentAuthCacheForTests();
  delete process.env.QUIQUP_PLATFORM_API_BASE_URL;
  delete process.env.QUIQUP_PLATFORM_API_STAGING_BASE_URL;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (saved.prod !== undefined) process.env.QUIQUP_PLATFORM_API_BASE_URL = saved.prod;
  if (saved.stg !== undefined) process.env.QUIQUP_PLATFORM_API_STAGING_BASE_URL = saved.stg;
});

describe("verifyAgentRequest", () => {
  it("valid token: calls /me with the token and returns the platform AuthInfo", async () => {
    let seenAuth: string | null = null;
    server.use(
      http.get(`${PLATFORM}/me`, ({ request }) => {
        seenAuth = request.headers.get("authorization");
        return HttpResponse.json(ME_OK);
      }),
    );
    const r = await verifyAgentRequest(req(good));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(seenAuth).toBe(`Bearer ${TOKEN}`);
    expect(r.authInfo.clientId).toBe("agent:carol");
    expect(r.authInfo.extra).toEqual({
      platform: {
        jwt: TOKEN,
        environment: "production",
        salesforceId: "001ABC",
        coreUserId: 4242,
        email: "merchant@example.com",
        agent: "carol",
      },
    });
  });

  it("invalid token (platform-api 401) -> 401", async () => {
    server.use(http.get(`${PLATFORM}/me`, () => new HttpResponse("nope", { status: 401 })));
    const r = await verifyAgentRequest(req(good));
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it("platform-api 403 -> 401 as well", async () => {
    server.use(http.get(`${PLATFORM}/me`, () => new HttpResponse("nope", { status: 403 })));
    expect(await verifyAgentRequest(req(good))).toMatchObject({ ok: false, status: 401 });
  });

  it("missing bearer -> 401, no /me call", async () => {
    // No handler registered: an unexpected fetch would fail the test.
    const r = await verifyAgentRequest(req({ "X-Quiqup-Agent": "carol" }));
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it("admin token is refused with 403", async () => {
    server.use(http.get(`${PLATFORM}/me`, () => HttpResponse.json({ ...ME_OK, admin: true })));
    const r = await verifyAgentRequest(req(good));
    expect(r).toMatchObject({ ok: false, status: 403, error: "forbidden" });
  });

  it("csr token is refused with 403", async () => {
    server.use(http.get(`${PLATFORM}/me`, () => HttpResponse.json({ ...ME_OK, csr: true })));
    expect(await verifyAgentRequest(req(good))).toMatchObject({ ok: false, status: 403 });
  });

  it("a cached admin identity is still refused on the second request", async () => {
    let hits = 0;
    server.use(
      http.get(`${PLATFORM}/me`, () => {
        hits += 1;
        return HttpResponse.json({ ...ME_OK, admin: true });
      }),
    );
    await verifyAgentRequest(req(good));
    expect(await verifyAgentRequest(req(good))).toMatchObject({ ok: false, status: 403 });
    expect(hits).toBe(1);
  });

  it("missing X-Quiqup-Agent -> 400 before any /me call", async () => {
    const r = await verifyAgentRequest(req({ Authorization: `Bearer ${TOKEN}` }));
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it.each(["Carol", "1carol", "car ol", "", "a".repeat(33), "carol_x"])(
    "bad agent label %j -> 400",
    async (label) => {
      const r = await verifyAgentRequest(
        req({ Authorization: `Bearer ${TOKEN}`, "X-Quiqup-Agent": label }),
      );
      expect(r).toMatchObject({ ok: false, status: 400 });
    },
  );

  it("accepts a 32-char label and hyphens", async () => {
    server.use(http.get(`${PLATFORM}/me`, () => HttpResponse.json(ME_OK)));
    const label = "c" + "a-b".repeat(10) + "x"; // 32 chars
    expect(label).toHaveLength(32);
    const r = await verifyAgentRequest(
      req({ Authorization: `Bearer ${TOKEN}`, "X-Quiqup-Agent": label }),
    );
    expect(r.ok).toBe(true);
  });

  it("X-Quiqup-Environment: staging verifies against the staging host", async () => {
    let stagingHit = false;
    server.use(
      http.get(`${PLATFORM_STAGING}/me`, () => {
        stagingHit = true;
        return HttpResponse.json(ME_OK);
      }),
    );
    const r = await verifyAgentRequest(req({ ...good, "X-Quiqup-Environment": "staging" }));
    expect(stagingHit).toBe(true);
    expect(r.ok && (r.authInfo.extra as { platform: { environment: string } }).platform.environment).toBe(
      "staging",
    );
  });

  it("defaults to production and rejects an unknown environment with 400", async () => {
    server.use(http.get(`${PLATFORM}/me`, () => HttpResponse.json(ME_OK)));
    const ok = await verifyAgentRequest(req(good));
    expect(ok.ok && (ok.authInfo.extra as { platform: { environment: string } }).platform.environment).toBe(
      "production",
    );
    const bad = await verifyAgentRequest(req({ ...good, "X-Quiqup-Environment": "prod" }));
    expect(bad).toMatchObject({ ok: false, status: 400 });
  });

  it("a token with no salesforce_id cannot be keyed per merchant -> 401", async () => {
    server.use(
      http.get(`${PLATFORM}/me`, () => HttpResponse.json({ ...ME_OK, salesforce_id: undefined })),
    );
    expect(await verifyAgentRequest(req(good))).toMatchObject({ ok: false, status: 401 });
  });

  it("platform-api 5xx -> 503 (not cached)", async () => {
    let hits = 0;
    server.use(
      http.get(`${PLATFORM}/me`, () => {
        hits += 1;
        return new HttpResponse("boom", { status: 502 });
      }),
    );
    expect(await verifyAgentRequest(req(good))).toMatchObject({ ok: false, status: 503 });
    await verifyAgentRequest(req(good));
    expect(hits).toBe(2);
  });

  it("network failure -> 503", async () => {
    server.use(http.get(`${PLATFORM}/me`, () => HttpResponse.error()));
    expect(await verifyAgentRequest(req(good))).toMatchObject({ ok: false, status: 503 });
  });
});

describe("verification cache", () => {
  it("reuses a valid verification inside the TTL, then re-verifies", async () => {
    let hits = 0;
    server.use(
      http.get(`${PLATFORM}/me`, () => {
        hits += 1;
        return HttpResponse.json(ME_OK);
      }),
    );
    const t0 = 1_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    await verifyAgentRequest(req(good));
    await verifyAgentRequest(req(good));
    expect(hits).toBe(1);
    now.mockReturnValue(t0 + VERIFY_CACHE_TTL_MS - 1);
    await verifyAgentRequest(req(good));
    expect(hits).toBe(1);
    now.mockReturnValue(t0 + VERIFY_CACHE_TTL_MS + 1);
    await verifyAgentRequest(req(good));
    expect(hits).toBe(2);
  });

  it("TTL is at most 50 seconds", () => {
    expect(VERIFY_CACHE_TTL_MS).toBeLessThanOrEqual(50_000);
  });

  it("is keyed per environment: a staging verification is not reused for production", async () => {
    let prod = 0;
    let stg = 0;
    server.use(
      http.get(`${PLATFORM}/me`, () => {
        prod += 1;
        return HttpResponse.json(ME_OK);
      }),
      http.get(`${PLATFORM_STAGING}/me`, () => {
        stg += 1;
        return HttpResponse.json(ME_OK);
      }),
    );
    await verifyAgentRequest(req({ ...good, "X-Quiqup-Environment": "staging" }));
    await verifyAgentRequest(req(good));
    expect([prod, stg]).toEqual([1, 1]);
  });

  it("never stores the raw token, as a key or in a value", async () => {
    server.use(http.get(`${PLATFORM}/me`, () => HttpResponse.json(ME_OK)));
    await verifyAgentRequest(req(good));
    const snap = _agentAuthCacheSnapshotForTests();
    expect(snap).toHaveLength(1);
    for (const { key, value } of snap) {
      expect(key).not.toContain(TOKEN);
      expect(value).not.toContain(TOKEN);
      expect(key).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
    }
  });

  it("does not log the token", async () => {
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
    ];
    server.use(http.get(`${PLATFORM}/me`, () => new HttpResponse("nope", { status: 401 })));
    await verifyAgentRequest(req(good));
    server.use(http.get(`${PLATFORM}/me`, () => HttpResponse.error()));
    await verifyAgentRequest(req(good));
    for (const s of spies) {
      expect(JSON.stringify(s.mock.calls)).not.toContain(TOKEN);
    }
  });
});
