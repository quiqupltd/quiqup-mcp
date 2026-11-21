/**
 * cancel_lastmile_orders_batch for a CLERK caller (/mcp): without `reason`
 * it is the original last-mile call; with `reason` it uses the merchant
 * app's platform route. (The agent-door cases live in tests/agent.)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./setup/msw";

vi.mock("@/lib/quiqup", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getQuiqupReadyJwt: vi.fn(async () => "clerk-minted-jwt") };
});
vi.mock("@/lib/middleware/scope", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, assertOrderBelongsToUser: vi.fn(async () => undefined) };
});

import { spec } from "@/lib/tools/cancel-lastmile-orders-batch";

const auth = { userId: "user_c", orgId: null, sessionId: "s", scopes: [], bearerToken: "t" };
const LASTMILE = "https://api-ae.quiqup.com";
const PLATFORM = "https://platform-api.quiqup.com";

beforeEach(() => {
  delete process.env.QUIQUP_LASTMILE_BASE_URL;
  delete process.env.QUIQUP_PLATFORM_API_BASE_URL;
});

describe("cancel_lastmile_orders_batch (Clerk caller)", () => {
  it("without reason: unchanged last-mile PUT with { order_ids }, Clerk-minted JWT, no platform calls", async () => {
    let body: unknown;
    let bearer: string | null = null;
    server.use(
      http.put(`${LASTMILE}/orders/batch/set_cancelled`, async ({ request }) => {
        body = await request.json();
        bearer = request.headers.get("authorization");
        return HttpResponse.json({ ok: true });
      }),
    );
    const r = await spec.handler(auth, { order_ids: ["1", "2"], environment: "production" });
    expect(r.isError).toBeFalsy();
    expect(body).toEqual({ order_ids: ["1", "2"] });
    expect(bearer).toBe("Bearer clerk-minted-jwt");
  });

  it("with a valid reason: platform set_cancelled with { orderIds, reason }", async () => {
    let body: unknown;
    server.use(
      http.get(`${PLATFORM}/orders/partner-cancellation-reasons`, () =>
        HttpResponse.json({ reasons: [{ id: 1, name: "Customer request" }] }),
      ),
      http.put(`${PLATFORM}/quiqdash/orders/batch/set_cancelled`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json([{ id: 1 }], { status: 201 });
      }),
    );
    const r = await spec.handler(auth, {
      order_ids: ["1"],
      reason: "Customer request",
      environment: "production",
    });
    expect(r.isError).toBeFalsy();
    expect(body).toEqual({ orderIds: ["1"], reason: "Customer request" });
  });

  it("with an invalid reason: refused, no cancel of either kind", async () => {
    server.use(
      http.get(`${PLATFORM}/orders/partner-cancellation-reasons`, () =>
        HttpResponse.json({ reasons: [{ id: 1, name: "Customer request" }] }),
      ),
    );
    const r = await spec.handler(auth, {
      order_ids: ["1"],
      reason: "nope",
      environment: "production",
    });
    expect(r.isError).toBe(true);
    const first = r.content[0];
    expect(first.type === "text" && first.text).toContain("Allowed names: Customer request");
  });

  it("reason must be non-empty", () => {
    expect(spec.inputSchema.safeParse({ order_ids: ["1"], reason: "" }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ order_ids: ["1"] }).success).toBe(true);
  });
});
