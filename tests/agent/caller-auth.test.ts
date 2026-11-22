/**
 * jwtFor (one JWT source) and assertOrderOwned (platform ownership probe).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup/msw";
import { PLATFORM, PLATFORM_STAGING, TOKEN, platformAuth } from "./helpers";
import type { AuthContext } from "@/lib/tools/register";

vi.mock("@/lib/quiqup", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getQuiqupReadyJwt: vi.fn(async (_userId: string) => "clerk-minted-jwt"),
  };
});
vi.mock("@/lib/middleware/scope", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    assertOrderBelongsToUser: vi.fn(async (_id: string, _u: string) => undefined),
  };
});

import { getQuiqupReadyJwt } from "@/lib/quiqup";
import { assertOrderBelongsToUser, ScopeViolationError, ALL_ORDER_STATES } from "@/lib/middleware/scope";
import {
  assertOrderOwned,
  jwtFor,
  lookupOwnedOrderRow,
  PlatformEnvironmentMismatchError,
} from "@/lib/caller-auth";

const clerkAuth: AuthContext = {
  userId: "user_clerk",
  orgId: null,
  sessionId: "sess",
  scopes: [],
  bearerToken: "inbound",
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.QUIQUP_PLATFORM_API_BASE_URL;
  delete process.env.QUIQUP_PLATFORM_API_STAGING_BASE_URL;
});

describe("jwtFor", () => {
  it("platform caller: returns the platform token as-is, never touches Clerk", async () => {
    expect(await jwtFor(platformAuth())).toBe(TOKEN);
    expect(await jwtFor(platformAuth(), "production")).toBe(TOKEN);
    expect(getQuiqupReadyJwt).not.toHaveBeenCalled();
  });

  it("platform caller: environment argument that differs from the verified one is refused", async () => {
    await expect(jwtFor(platformAuth(), "staging")).rejects.toBeInstanceOf(
      PlatformEnvironmentMismatchError,
    );
    await expect(
      jwtFor(platformAuth({ platformEnvironment: "staging" }), "production"),
    ).rejects.toThrow(/Environment mismatch/);
    expect(await jwtFor(platformAuth({ platformEnvironment: "staging" }), "staging")).toBe(TOKEN);
  });

  it("Clerk caller: today's getQuiqupReadyJwt path, environment ignored", async () => {
    expect(await jwtFor(clerkAuth, "staging")).toBe("clerk-minted-jwt");
    expect(getQuiqupReadyJwt).toHaveBeenCalledWith("user_clerk");
  });

  it("Clerk caller without a userId fails closed", async () => {
    await expect(jwtFor({ ...clerkAuth, userId: null })).rejects.toThrow(/authenticated/);
  });
});

describe("assertOrderOwned", () => {
  it("Clerk caller: delegates to the last-mile probe unchanged", async () => {
    await assertOrderOwned(clerkAuth, "123", "production");
    expect(assertOrderBelongsToUser).toHaveBeenCalledWith("123", "user_clerk");
  });

  it("platform caller: owned when the order is in the caller's own platform list", async () => {
    let seen: URL | undefined;
    let seenAuth: string | null = null;
    server.use(
      http.get(`${PLATFORM}/quiqdash/orders`, ({ request }) => {
        seen = new URL(request.url);
        seenAuth = request.headers.get("authorization");
        return HttpResponse.json({ results: [{ id: 123, uuid: "u-123", state: "pending" }] });
      }),
    );
    await expect(assertOrderOwned(platformAuth(), "123")).resolves.toBeUndefined();
    expect(assertOrderBelongsToUser).not.toHaveBeenCalled();
    expect(seenAuth).toBe(`Bearer ${TOKEN}`);
    const q = seen!.searchParams;
    expect(q.get("version")).toBe("v2");
    expect(q.get("page")).toBe("1");
    expect(q.get("per_page")).toBe("1");
    expect(q.get("from")).toBe("2020-01-01");
    expect(q.get("to")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(q.get("filters[order_id]")).toBe("123");
    // pending is hidden without a state filter: every known state is named.
    const states = q.get("filters[state]")!.split(",");
    expect(states).toEqual([...ALL_ORDER_STATES]);
    expect(states).toContain("pending");
    expect(states).toContain("cancelled");
  });

  it("platform caller: the real ex-core v2 envelope { current_page, per_page, results, total, total_pages }", async () => {
    server.use(
      http.get(`${PLATFORM}/quiqdash/orders`, () =>
        HttpResponse.json({
          current_page: 1,
          per_page: 1,
          results: [{ id: 57282, uuid: "u-57282", state: "pending" }],
          total: 1,
          total_pages: 1,
        }),
      ),
    );
    await expect(assertOrderOwned(platformAuth(), "57282")).resolves.toBeUndefined();
    const row = await lookupOwnedOrderRow(platformAuth(), "57282");
    expect(row.uuid).toBe("u-57282");
  });

  it("platform caller: the real envelope with no rows is not ownership", async () => {
    server.use(
      http.get(`${PLATFORM}/quiqdash/orders`, () =>
        HttpResponse.json({ current_page: 1, per_page: 1, results: [], total: 0, total_pages: 0 }),
      ),
    );
    await expect(assertOrderOwned(platformAuth(), "1")).rejects.toBeInstanceOf(ScopeViolationError);
  });

  it("platform caller: a uuid never counts as proof (numeric ids only)", async () => {
    server.use(
      http.get(`${PLATFORM}/quiqdash/orders`, () => HttpResponse.json({ results: [{ id: 9, uuid: "u-abc" }] })),
    );
    await expect(assertOrderOwned(platformAuth(), "u-abc")).rejects.toBeInstanceOf(ScopeViolationError);
  });

  it("probe state list is exactly the 21 known states", () => {
    expect([...ALL_ORDER_STATES]).toEqual([
      "pending", "ready_for_collection", "out_for_collection", "collected", "collection_failed",
      "received_at_depot", "at_depot", "scheduled", "in_transit", "out_for_delivery",
      "delivery_complete", "delivery_failed", "return_to_origin", "out_for_return",
      "returned_to_origin", "cancelled", "on_hold", "error", "picking_started", "wms_on_hold",
      "problematic",
    ]);
  });

  it("platform caller: empty list -> ScopeViolationError", async () => {
    server.use(http.get(`${PLATFORM}/quiqdash/orders`, () => HttpResponse.json({ results: [] })));
    await expect(assertOrderOwned(platformAuth(), "999")).rejects.toBeInstanceOf(ScopeViolationError);
  });

  it("platform caller: a row for a different order is not ownership (no prefix/fuzzy match)", async () => {
    server.use(
      http.get(`${PLATFORM}/quiqdash/orders`, () =>
        HttpResponse.json({ results: [{ id: 1234, uuid: "other" }] }),
      ),
    );
    await expect(assertOrderOwned(platformAuth(), "123")).rejects.toBeInstanceOf(ScopeViolationError);
  });

  it("platform caller: an unrecognised response shape fails closed", async () => {
    server.use(http.get(`${PLATFORM}/quiqdash/orders`, () => HttpResponse.json({ weird: true })));
    await expect(assertOrderOwned(platformAuth(), "123")).rejects.toBeInstanceOf(ScopeViolationError);
  });

  it("platform caller: upstream 500 propagates (not mistaken for 'not owned')", async () => {
    server.use(
      http.get(`${PLATFORM}/quiqdash/orders`, () => new HttpResponse("boom", { status: 500 })),
    );
    await expect(assertOrderOwned(platformAuth(), "123")).rejects.toMatchObject({ status: 500 });
  });

  it("platform caller: uses the staging host when the token was verified on staging", async () => {
    let hit = false;
    server.use(
      http.get(`${PLATFORM_STAGING}/quiqdash/orders`, () => {
        hit = true;
        return HttpResponse.json({ results: [{ id: 5 }] });
      }),
    );
    await assertOrderOwned(platformAuth({ platformEnvironment: "staging" }), "5");
    expect(hit).toBe(true);
  });

  it("platform caller: environment mismatch is refused before any request", async () => {
    await expect(assertOrderOwned(platformAuth(), "5", "staging")).rejects.toBeInstanceOf(
      PlatformEnvironmentMismatchError,
    );
  });
});
