/**
 * The agent-door tool allowlist, driven through the same orchestrator
 * registerTool uses (rate limit, idempotency, audit), with a platform-token
 * AuthContext. No Clerk is mocked on purpose: platform callers must never
 * reach it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { z } from "zod";
import { server } from "../setup/msw";
import { _invokeWithGuardrailsForTests, type ToolSpec } from "@/lib/tools/register";
import { _resetForTests as resetIdempotency } from "@/lib/middleware/idempotency";
import { _resetForTests as resetRateLimit } from "@/lib/middleware/rate-limit";
import { PLATFORM, TOKEN, captureAudit, platformAuth, textOf } from "./helpers";

import { spec as findOrder } from "@/lib/tools/find-order-by-id-or-barcode";
import { spec as listReasons } from "@/lib/tools/list-partner-cancellation-reasons";
import { spec as cancel } from "@/lib/tools/cancel-lastmile-orders-batch";
import { spec as sendForCollection } from "@/lib/tools/send-orders-for-collection";
import { agentSpec as unpool } from "@/lib/tools/unpool-order";
import { agentSpec as repair } from "@/lib/tools/repair-integration-orders";

let audit: ReturnType<typeof captureAudit>;
beforeEach(() => {
  resetIdempotency();
  resetRateLimit();
  delete process.env.QUIQUP_PLATFORM_API_BASE_URL;
  audit = captureAudit();
});
afterEach(() => audit.restore());

/** Platform order list that "owns" the given ids. */
function ownList(ids: Array<number | string>, onCall?: () => void) {
  return http.get(`${PLATFORM}/quiqdash/orders`, () => {
    onCall?.();
    return HttpResponse.json({ results: ids.map((id) => ({ id, uuid: `u-${id}` })) });
  });
}
const REASONS = http.get(`${PLATFORM}/orders/partner-cancellation-reasons`, () =>
  HttpResponse.json({
    reasons: [
      { id: 1, name: "Customer request", tooltip: "" },
      { id: 2, name: "Wrong address", tooltip: "" },
    ],
  }),
);

describe("find_order_by_id_or_barcode", () => {
  it("happy path: forwards the platform token as-is and audits agent + merchant", async () => {
    let seenAuth: string | null = null;
    let seenUrl: URL | undefined;
    server.use(
      http.get(`${PLATFORM}/quiqdash/orders/find_by_id_or_barcode`, ({ request }) => {
        seenAuth = request.headers.get("authorization");
        seenUrl = new URL(request.url);
        return HttpResponse.json({ found_by: "id", order: { id: 123, state: "pending" } });
      }),
    );
    const r = await _invokeWithGuardrailsForTests(
      findOrder,
      platformAuth(),
      { value: "123", intention: "set_cancelled" },
    );
    expect(r.isError).toBeFalsy();
    expect(textOf(r as never)).toContain('"state": "pending"');
    expect(seenAuth).toBe(`Bearer ${TOKEN}`);
    expect(seenUrl!.searchParams.get("value")).toBe("123");
    // Read tool, no guardrails block: still audited on the agent door.
    const recs = audit.records();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      tool: "find_order_by_id_or_barcode",
      userId: "platform:001ABC",
      agent: "carol",
      salesforceId: "001ABC",
      environment: "production",
      ok: true,
    });
  });

  it("error path: upstream 500 comes back as an isError result and is audited ok:false", async () => {
    server.use(
      http.get(
        `${PLATFORM}/quiqdash/orders/find_by_id_or_barcode`,
        () => new HttpResponse("boom", { status: 500 }),
      ),
    );
    const r = await _invokeWithGuardrailsForTests(findOrder, platformAuth(), {
      value: "1",
      intention: "set_cancelled",
    });
    expect(r.isError).toBe(true);
    expect(textOf(r as never)).toContain("HTTP 500");
    expect(audit.records()[0]).toMatchObject({ ok: false, agent: "carol" });
  });

  it("a staging merchant token goes to the staging host", async () => {
    let hit = false;
    server.use(
      http.get("https://platform-api.staging.quiqup.com/quiqdash/orders/find_by_id_or_barcode", () => {
        hit = true;
        return HttpResponse.json({ order: {} });
      }),
    );
    await _invokeWithGuardrailsForTests(
      findOrder,
      platformAuth({ platformEnvironment: "staging" }),
      { value: "1", intention: "set_cancelled" },
    );
    expect(hit).toBe(true);
    expect(audit.records()[0]).toMatchObject({ environment: "staging" });
  });

  it("an explicit environment that differs from the token's is refused, no request made", async () => {
    // No handler registered: a request would fail the test via onUnhandledRequest.
    await expect(
      _invokeWithGuardrailsForTests(findOrder, platformAuth(), {
        value: "1",
        intention: "set_cancelled",
        environment: "staging",
      }),
    ).rejects.toThrow(/Environment mismatch/);
    expect(audit.records()[0]).toMatchObject({ ok: false });
  });
});

describe("list_partner_cancellation_reasons", () => {
  it("happy path returns the reason list with the platform token", async () => {
    let seenAuth: string | null = null;
    server.use(
      http.get(`${PLATFORM}/orders/partner-cancellation-reasons`, ({ request }) => {
        seenAuth = request.headers.get("authorization");
        return HttpResponse.json({ reasons: [{ id: 1, name: "Customer request" }] });
      }),
    );
    const r = await _invokeWithGuardrailsForTests(listReasons, platformAuth(), {});
    expect(textOf(r as never)).toContain("Customer request");
    expect(seenAuth).toBe(`Bearer ${TOKEN}`);
  });

  it("error path: 403 is surfaced with the auth hint", async () => {
    server.use(
      http.get(`${PLATFORM}/orders/partner-cancellation-reasons`, () => new HttpResponse("no", { status: 403 })),
    );
    const r = await _invokeWithGuardrailsForTests(listReasons, platformAuth(), {});
    expect(r.isError).toBe(true);
    expect(textOf(r as never)).toContain("HTTP 403");
  });
});

describe("cancel_lastmile_orders_batch on the agent door", () => {
  it("with a valid reason: validates the reason, checks ownership on platform-api, PUTs {orderIds, reason}", async () => {
    let body: unknown;
    let putAuth: string | null = null;
    server.use(
      REASONS,
      ownList([123, 124]),
      http.put(`${PLATFORM}/quiqdash/orders/batch/set_cancelled`, async ({ request }) => {
        body = await request.json();
        putAuth = request.headers.get("authorization");
        return HttpResponse.json([{ id: 123 }, { id: 124 }], { status: 201 });
      }),
    );
    const r = await _invokeWithGuardrailsForTests(cancel, platformAuth(), {
      order_ids: ["123", "124"],
      reason: "Customer request",
    });
    expect(r.isError).toBeFalsy();
    expect(textOf(r as never)).toContain("Cancelled 2 order(s)");
    expect(body).toEqual({ orderIds: ["123", "124"], reason: "Customer request" });
    expect(putAuth).toBe(`Bearer ${TOKEN}`);
    expect(audit.records()[0]).toMatchObject({
      tool: "cancel_lastmile_orders_batch",
      ok: true,
      agent: "carol",
      salesforceId: "001ABC",
    });
  });

  it("reason is required on the agent door: refused, zero upstream traffic", async () => {
    const r = await _invokeWithGuardrailsForTests(cancel, platformAuth(), { order_ids: ["123"] });
    expect(r.isError).toBe(true);
    expect(textOf(r as never)).toContain("`reason` is required on /agent/mcp");
  });

  it("an invalid reason is refused with the allowed names, and no PUT is attempted", async () => {
    let puts = 0;
    server.use(
      REASONS,
      ownList([123]),
      http.put(`${PLATFORM}/quiqdash/orders/batch/set_cancelled`, () => {
        puts += 1;
        return HttpResponse.json([]);
      }),
    );
    const r = await _invokeWithGuardrailsForTests(cancel, platformAuth(), {
      order_ids: ["123"],
      reason: "Because I said so",
    });
    expect(r.isError).toBe(true);
    const t = textOf(r as never);
    expect(t).toContain("not a partner cancellation reason");
    expect(t).toContain("Customer request | Wrong address");
    expect(puts).toBe(0);
  });

  it("an order outside the merchant's own list refuses the whole batch, no PUT", async () => {
    let puts = 0;
    server.use(
      REASONS,
      // The list only ever returns the caller's own orders: 555 is not there.
      http.get(`${PLATFORM}/quiqdash/orders`, ({ request }) => {
        const id = new URL(request.url).searchParams.get("filters[order_id]");
        return HttpResponse.json({ results: id === "123" ? [{ id: 123 }] : [] });
      }),
      http.put(`${PLATFORM}/quiqdash/orders/batch/set_cancelled`, () => {
        puts += 1;
        return HttpResponse.json([]);
      }),
    );
    const r = await _invokeWithGuardrailsForTests(cancel, platformAuth(), {
      order_ids: ["123", "555"],
      reason: "Customer request",
    });
    expect(r.isError).toBe(true);
    expect(textOf(r as never)).toContain("555");
    expect(puts).toBe(0);
  });

  it("202 pending_projection is reported as recorded-not-readable, do not retry", async () => {
    server.use(
      REASONS,
      ownList([123]),
      http.put(`${PLATFORM}/quiqdash/orders/batch/set_cancelled`, () =>
        HttpResponse.json({ order_ids: ["123"], status: "pending_projection" }, { status: 202 }),
      ),
    );
    const r = await _invokeWithGuardrailsForTests(cancel, platformAuth(), {
      order_ids: ["123"],
      reason: "Customer request",
    });
    expect(r.isError).toBeFalsy();
    const t = textOf(r as never);
    expect(t).toContain("pending_projection");
    expect(t).toContain("Do NOT retry");
  });

  it("422 (non-cancellable) is returned as an isError result with the upstream body", async () => {
    server.use(
      REASONS,
      ownList([123]),
      http.put(
        `${PLATFORM}/quiqdash/orders/batch/set_cancelled`,
        () => new HttpResponse('{"error":"order cannot be cancelled"}', { status: 422 }),
      ),
    );
    const r = await _invokeWithGuardrailsForTests(cancel, platformAuth(), {
      order_ids: ["123"],
      reason: "Customer request",
    });
    expect(r.isError).toBe(true);
    expect(textOf(r as never)).toContain("HTTP 422");
    expect(audit.records()[0]).toMatchObject({ ok: false });
  });
});

describe("send_orders_for_collection", () => {
  const run = (args: Record<string, unknown>, auth = platformAuth()) =>
    _invokeWithGuardrailsForTests(sendForCollection, auth, args);

  it("uses the platform route set_ready_for_collection with body {orderIds}", async () => {
    let body: unknown;
    let hitPath = "";
    server.use(
      ownList([7, 8]),
      http.put(`${PLATFORM}/quiqdash/orders/batch/set_ready_for_collection`, async ({ request }) => {
        body = await request.json();
        hitPath = new URL(request.url).pathname;
        return HttpResponse.json([{ id: 7 }, { id: 8 }]);
      }),
    );
    const r = await run({ order_ids: ["7", "8"], confirm: true });
    expect(r.isError).toBeFalsy();
    expect(hitPath).toBe("/quiqdash/orders/batch/set_ready_for_collection");
    expect(body).toEqual({ orderIds: ["7", "8"] });
    expect(audit.records()[0]).toMatchObject({ tool: "send_orders_for_collection", ok: true });
  });

  it("confirm gate: no confirm -> refused, zero upstream traffic", async () => {
    const r = await run({ order_ids: ["7"] });
    expect(r.isError).toBe(true);
    expect(textOf(r as never)).toContain("confirm: true");
  });

  it("dry_run previews without the PUT", async () => {
    let puts = 0;
    server.use(
      ownList([7]),
      http.put(`${PLATFORM}/quiqdash/orders/batch/set_ready_for_collection`, () => {
        puts += 1;
        return HttpResponse.json([]);
      }),
    );
    const r = await run({ order_ids: ["7"], confirm: true, dry_run: true });
    expect(textOf(r as never)).toContain('"dryRun": true');
    expect(puts).toBe(0);
  });

  it("accepts at most 10 ids and at least 1", () => {
    const shape = sendForCollection.inputSchema as z.ZodObject<z.ZodRawShape>;
    expect(shape.safeParse({ order_ids: [] }).success).toBe(false);
    expect(shape.safeParse({ order_ids: Array.from({ length: 11 }, (_, i) => String(i + 1)) }).success).toBe(
      false,
    );
    expect(shape.safeParse({ order_ids: ["1"] }).success).toBe(true);
  });

  it("out-of-scope id: refused, no PUT", async () => {
    let puts = 0;
    server.use(
      http.get(`${PLATFORM}/quiqdash/orders`, () => HttpResponse.json({ results: [] })),
      http.put(`${PLATFORM}/quiqdash/orders/batch/set_ready_for_collection`, () => {
        puts += 1;
        return HttpResponse.json([]);
      }),
    );
    const r = await run({ order_ids: ["999"], confirm: true });
    expect(r.isError).toBe(true);
    expect(textOf(r as never)).toContain("999");
    expect(puts).toBe(0);
  });

  it("upstream 422 (e.g. no payment method) surfaces as isError", async () => {
    server.use(
      ownList([7]),
      http.put(
        `${PLATFORM}/quiqdash/orders/batch/set_ready_for_collection`,
        () => new HttpResponse('{"error":"payment method required"}', { status: 422 }),
      ),
    );
    const r = await run({ order_ids: ["7"], confirm: true });
    expect(r.isError).toBe(true);
    expect(textOf(r as never)).toContain("payment method required");
  });
});

describe("unpool_order on the agent door (numeric id, uuid looked up)", () => {
  const rows = (r: Array<Record<string, unknown>>) =>
    http.get(`${PLATFORM}/quiqdash/orders`, () =>
      HttpResponse.json({ current_page: 1, per_page: 1, results: r, total: r.length, total_pages: 1 }),
    );

  it("owned order: unpools with the uuid from the looked-up row, token forwarded", async () => {
    let putAuth: string | null = null;
    let q: URL | undefined;
    server.use(
      http.get(`${PLATFORM}/quiqdash/orders`, ({ request }) => {
        q = new URL(request.url);
        return HttpResponse.json({
          current_page: 1,
          per_page: 1,
          results: [{ id: 57282, uuid: "11111111-aaaa" }],
          total: 1,
          total_pages: 1,
        });
      }),
      http.put(`${PLATFORM}/quiqdash/missions/unpool/orders/11111111-aaaa`, ({ request }) => {
        putAuth = request.headers.get("authorization");
        return HttpResponse.json({ ok: true });
      }),
    );
    const r = await _invokeWithGuardrailsForTests(unpool, platformAuth(), {
      order_id: "57282",
      confirm: true,
    });
    expect(r.isError).toBeFalsy();
    expect(textOf(r as never)).toContain("uuid 11111111-aaaa");
    expect(q!.searchParams.get("filters[order_id]")).toBe("57282");
    expect(putAuth).toBe(`Bearer ${TOKEN}`);
  });

  it("not owned: refuses and sends nothing", async () => {
    let puts = 0;
    server.use(
      rows([]),
      http.put(`${PLATFORM}/quiqdash/missions/unpool/orders/:uuid`, () => {
        puts += 1;
        return HttpResponse.json({});
      }),
    );
    const r = await _invokeWithGuardrailsForTests(unpool, platformAuth(), {
      order_id: "999",
      confirm: true,
    });
    expect(r.isError).toBe(true);
    expect(textOf(r as never)).toContain("not in your order list");
    expect(puts).toBe(0);
  });

  it("row without a uuid: refuses and sends nothing", async () => {
    let puts = 0;
    server.use(
      rows([{ id: 57282 }]),
      http.put(`${PLATFORM}/quiqdash/missions/unpool/orders/:uuid`, () => {
        puts += 1;
        return HttpResponse.json({});
      }),
    );
    const r = await _invokeWithGuardrailsForTests(unpool, platformAuth(), {
      order_id: "57282",
      confirm: true,
    });
    expect(r.isError).toBe(true);
    expect(textOf(r as never)).toContain("no uuid");
    expect(puts).toBe(0);
  });

  it("order_id must be 1 to 12 digits (a uuid is not accepted)", () => {
    const schema = unpool.inputSchema as z.ZodObject<z.ZodRawShape>;
    expect(schema.safeParse({ order_id: "57282" }).success).toBe(true);
    expect(schema.safeParse({ order_id: "1".repeat(12) }).success).toBe(true);
    expect(schema.safeParse({ order_id: "1".repeat(13) }).success).toBe(false);
    expect(schema.safeParse({ order_id: "" }).success).toBe(false);
    expect(schema.safeParse({ order_id: "11111111-aaaa-bbbb" }).success).toBe(false);
    expect(Object.keys(schema.shape)).not.toContain("order_uuid");
  });

  it("confirm gate and dry_run (dry run does the lookup but no PUT)", async () => {
    let puts = 0;
    server.use(
      rows([{ id: 5, uuid: "u5" }]),
      http.put(`${PLATFORM}/quiqdash/missions/unpool/orders/:uuid`, () => {
        puts += 1;
        return HttpResponse.json({});
      }),
    );
    const noConfirm = await _invokeWithGuardrailsForTests(unpool, platformAuth(), { order_id: "5" });
    expect(noConfirm.isError).toBe(true);
    const dry = await _invokeWithGuardrailsForTests(unpool, platformAuth(), {
      order_id: "5",
      confirm: true,
      dry_run: true,
    });
    expect(textOf(dry as never)).toContain('"orderUuid": "u5"');
    expect(puts).toBe(0);
  });
});

describe("repair_integration_orders (agent variant)", () => {
  it("sends specific ids only: no date range, no user_id, location_id 0", async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.post(`${PLATFORM}/integrations/repair-orders`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ workflow_id: "wf-1", status: "running", started: true });
      }),
    );
    const r = await _invokeWithGuardrailsForTests(repair, platformAuth(), {
      ids: ["#1307"],
      source: "shopify",
    });
    expect(r.isError).toBeFalsy();
    expect(body).toEqual({ source: "shopify", ids: ["#1307"], location_id: 0 });
    expect(Object.keys(body)).not.toContain("start_date");
    expect(Object.keys(body)).not.toContain("end_date");
    expect(Object.keys(body)).not.toContain("user_id");
  });

  it("the schema has no date fields and requires at least one id", () => {
    const schema = repair.inputSchema as z.ZodObject<z.ZodRawShape>;
    expect(Object.keys(schema.shape)).not.toContain("start_date");
    expect(Object.keys(schema.shape)).not.toContain("end_date");
    expect(schema.safeParse({ ids: [], source: "shopify" }).success).toBe(false);
    expect(schema.safeParse({ ids: ["1"], source: "magento" }).success).toBe(false);
  });

  it("upstream 422 surfaces as an isError result", async () => {
    server.use(
      http.post(
        `${PLATFORM}/integrations/repair-orders`,
        () => new HttpResponse('{"error":"no order found with name X"}', { status: 422 }),
      ),
    );
    const r = await _invokeWithGuardrailsForTests(repair, platformAuth(), {
      ids: ["X"],
      source: "shopify",
    });
    expect(r.isError).toBe(true);
    expect(textOf(r as never)).toContain("no order found with name X");
  });
});

describe("per-merchant rate limits and idempotency", () => {
  it("rate limits key on platform:<salesforceId>: one merchant exhausting a tool does not block another", async () => {
    const a = platformAuth({ userId: "platform:001AAA", salesforceId: "001AAA" });
    const b = platformAuth({ userId: "platform:001BBB", salesforceId: "001BBB" });
    // confirm missing -> gate refusal with zero upstream traffic, but each
    // call still consumes one rate-limit token (capacity 3 / burst).
    const call = (auth: typeof a) =>
      _invokeWithGuardrailsForTests(sendForCollection, auth, { order_ids: ["1"] });
    for (let i = 0; i < 3; i++) {
      expect(textOf((await call(a)) as never)).not.toContain("Rate limited");
    }
    expect(textOf((await call(a)) as never)).toContain("Rate limited");
    // Merchant B still has a full bucket.
    expect(textOf((await call(b)) as never)).not.toContain("Rate limited");
    // The rate-limited call was audited with agent + merchant.
    const limited = audit.records().find((r) => String(r.error).startsWith("rate-limited"));
    expect(limited).toMatchObject({ agent: "carol", salesforceId: "001AAA", ok: false });
  });

  it("idempotency keys are per merchant: same key, different merchants -> both run; same merchant -> cached", async () => {
    let posts = 0;
    server.use(
      http.post(`${PLATFORM}/integrations/repair-orders`, () => {
        posts += 1;
        return HttpResponse.json({ workflow_id: `wf-${posts}`, status: "running" });
      }),
    );
    const a = platformAuth({ userId: "platform:001AAA", salesforceId: "001AAA" });
    const b = platformAuth({ userId: "platform:001BBB", salesforceId: "001BBB" });
    const args = { ids: ["#1"], source: "shopify", idempotency_key: "same-key" };
    await _invokeWithGuardrailsForTests(repair, a, args);
    await _invokeWithGuardrailsForTests(repair, b, args);
    expect(posts).toBe(2);
    await _invokeWithGuardrailsForTests(repair, a, args);
    expect(posts).toBe(2);
  });
});

describe("audit is always on for agent calls", () => {
  const stubSchema = z.object({ order_id: z.string() });
  const stub = (
    handler: ToolSpec<typeof stubSchema, z.ZodTypeAny>["handler"],
    guardrails?: ToolSpec<typeof stubSchema, z.ZodTypeAny>["guardrails"],
  ): ToolSpec<typeof stubSchema, z.ZodTypeAny> => ({
    name: "stub_tool",
    description: "stub",
    inputSchema: stubSchema,
    outputSchema: z.object({}).passthrough(),
    handler,
    guardrails,
  });

  it("audits even when the tool says guardrails.audit:false, on success and on throw", async () => {
    const ok = stub(async () => ({ content: [{ type: "text" as const, text: "ok" }] }), { audit: false });
    await _invokeWithGuardrailsForTests(ok, platformAuth(), { order_id: "1" });
    const boom = stub(
      async () => {
        throw new Error("kaput");
      },
      { audit: false },
    );
    await expect(_invokeWithGuardrailsForTests(boom, platformAuth(), { order_id: "1" })).rejects.toThrow(
      "kaput",
    );
    const recs = audit.records();
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({ ok: true, agent: "carol", salesforceId: "001ABC", environment: "production" });
    expect(recs[1]).toMatchObject({ ok: false, error: "kaput", agent: "carol" });
  });

  it("a Clerk caller is unchanged: audit stays opt-in and carries no agent fields", async () => {
    const quiet = stub(async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    await _invokeWithGuardrailsForTests(
      quiet,
      { userId: "user_c", orgId: null, sessionId: "s", scopes: [], bearerToken: "t" },
      { order_id: "1" },
    );
    expect(audit.records()).toHaveLength(0);
    const loud = stub(async () => ({ content: [{ type: "text" as const, text: "ok" }] }), { audit: true });
    await _invokeWithGuardrailsForTests(
      loud,
      { userId: "user_c", orgId: null, sessionId: "s", scopes: [], bearerToken: "t" },
      { order_id: "1" },
    );
    const rec = audit.records()[0];
    expect(rec.agent).toBeUndefined();
    expect(rec.salesforceId).toBeUndefined();
    expect(rec.environment).toBeUndefined();
  });

  it("the token never appears in an audit line, and customer fields stay redacted", async () => {
    server.use(
      http.post(`${PLATFORM}/integrations/repair-orders`, () => HttpResponse.json({ status: "running" })),
    );
    await _invokeWithGuardrailsForTests(repair, platformAuth(), {
      ids: ["#1"],
      source: "shopify",
      shop_name: "Acme Customer Shop",
      site_url: "https://acme.example",
    });
    const raw = audit.raw().join("");
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain("Acme Customer Shop");
    expect(raw).not.toContain("acme.example");
  });
});

describe("on_behalf_of_email is never honoured for platform-token callers", () => {
  it("is refused (handler never runs, no Clerk/impersonation lookup) and audited", async () => {
    const handler = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }] }));
    const spec: ToolSpec<z.ZodObject<{ order_id: z.ZodString }>, z.ZodTypeAny> = {
      name: "stub_tool",
      description: "stub",
      inputSchema: z.object({ order_id: z.string() }),
      outputSchema: z.object({}).passthrough(),
      handler,
    };
    const r = await _invokeWithGuardrailsForTests(spec, platformAuth(), {
      order_id: "1",
      on_behalf_of_email: "someone@example.com",
    });
    expect(r.isError).toBe(true);
    expect(textOf(r as never)).toContain("not supported on /agent/mcp");
    expect(handler).not.toHaveBeenCalled();
    expect(audit.records()[0]).toMatchObject({
      ok: false,
      error: "on_behalf_of_email-refused-for-platform-token",
      agent: "carol",
    });
  });
});
