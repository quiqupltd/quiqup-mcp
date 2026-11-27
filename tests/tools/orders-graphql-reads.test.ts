/**
 * MSW-mocked Vitest suite for the two Phase-3 / Wave-1 Orders Core GraphQL
 * read tools (ORDL-02 `lookup_orders_ids`, ORDL-03 `bulk_orders_lookup`).
 *
 * Coverage contract per tool:
 *   1. Happy path — content[0].text contains the mocked JSON body shape.
 *   2. Variable forwarding — outbound POST body carries the LLM-supplied
 *      args on the GraphQL `variables` envelope (not concatenated into the
 *      `query` string — T-03-08).
 *   3. GraphQL `errors[]` in a 200 response are surfaced verbatim to the
 *      caller (partial-success contract, anchor invariant of the GraphQL
 *      client layer).
 *   4. Missing `auth.userId` — handler throws a plain Error before any
 *      fetch (BL-04: server-derived identity only).
 *   5. Upstream HTTP 401 → handler throws QuiqupHttpError (registerTool
 *      wrapper catches it in production; this suite calls the handler
 *      directly so it sees the raw throw).
 *   6. Schema-parse rejection of out-of-range inputs (page-size caps,
 *      id-array caps, orderBy field literal).
 *
 * Per WR-05: `QUIQUP_ORDERS_GRAPH_URL` AND `QUIQUP_ORDERS_GRAPH_STAGING_URL`
 * are deleted in beforeEach so a developer with the var set in their shell
 * does not silently route fetches around MSW (the handlers bind to the
 * canonical production host).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup/msw";
import { QuiqupHttpError } from "../../lib/clients/quiqup-lastmile";

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

const ORDERS_GRAPH = "https://orders-api.quiqup.com/graph";

// Per WR-05: clear both prod + staging override vars so MSW catches the
// canonical orders-graph host. Restore originals in afterEach so other
// suites are unaffected.
const originalProdUrl = process.env.QUIQUP_ORDERS_GRAPH_URL;
const originalStagingUrl = process.env.QUIQUP_ORDERS_GRAPH_STAGING_URL;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.QUIQUP_ORDERS_GRAPH_URL;
  delete process.env.QUIQUP_ORDERS_GRAPH_STAGING_URL;
});

afterEach(() => {
  if (originalProdUrl === undefined) {
    delete process.env.QUIQUP_ORDERS_GRAPH_URL;
  } else {
    process.env.QUIQUP_ORDERS_GRAPH_URL = originalProdUrl;
  }
  if (originalStagingUrl === undefined) {
    delete process.env.QUIQUP_ORDERS_GRAPH_STAGING_URL;
  } else {
    process.env.QUIQUP_ORDERS_GRAPH_STAGING_URL = originalStagingUrl;
  }
});

describe("lookup_orders_ids", () => {
  it("happy path: returns data + totalCount in the text content", async () => {
    server.use(
      http.post(ORDERS_GRAPH, () =>
        HttpResponse.json({
          data: {
            orders: {
              edges: [{ node: { clientOrderID: 1 } }],
              pageInfo: {
                hasNextPage: false,
                hasPreviousPage: false,
                startCursor: "s",
                endCursor: "e",
              },
              totalCount: 1,
            },
          },
        }),
      ),
    );

    const mod = await import("../../lib/tools/lookup-orders-ids");
    const result = await mod.spec.handler(auth, {
      where: { stateIn: ["pending"] },
      first: 50,
      environment: "production",
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain('"totalCount": 1');
    expect(text).toContain('"clientOrderID": 1');
  });

  // sc-34635: Orders Core rejected the query with 422 GRAPHQL_VALIDATION_FAILED
  // because it declared `$after/$before: String` and `$orderBy: OrderByInput`.
  // The schema types are `Cursor` and `OrderOrder` (Quiqdash-v3
  // app/graphql/schema.graphql, `orders(... orderBy: OrderOrder)`).
  it("declares the Orders Core variable types Cursor and OrderOrder (sc-34635)", async () => {
    let captured: { query: string } | null = null;
    server.use(
      http.post(ORDERS_GRAPH, async ({ request }) => {
        captured = (await request.json()) as { query: string };
        return HttpResponse.json({
          data: { orders: { edges: [], pageInfo: {}, totalCount: 0 } },
        });
      }),
    );

    const mod = await import("../../lib/tools/lookup-orders-ids");
    await mod.spec.handler(auth, {
      where: { stateIn: ["delivery_complete"] },
      first: 5,
      environment: "production",
    });

    const q = (captured as unknown as { query: string }).query;
    expect(q).toMatch(/\$after: Cursor\b/);
    expect(q).toMatch(/\$before: Cursor\b/);
    expect(q).toMatch(/\$orderBy: OrderOrder\b/);
    expect(q).not.toContain("OrderByInput");
    expect(q).not.toMatch(/\$after: String/);
  });

  // sc-34635: OrderWhereInput has submittedAtGTE/LTE, not submittedAtBetween,
  // scheduledForBetween or search. The description is what the model copies,
  // so naming keys Orders Core rejects recreates the 422.
  it("describes only OrderWhereInput keys Orders Core accepts (sc-34635)", async () => {
    const mod = await import("../../lib/tools/lookup-orders-ids");
    const d = mod.spec.description;
    expect(d).not.toMatch(/Between/);
    expect(d).toContain("submittedAtGTE");
    expect(d).not.toMatch(/"live"|\\"live\\"/);
  });

  it("forwards where + first + orderBy as GraphQL variables (not in query string)", async () => {
    let captured: { query: unknown; variables: unknown } | null = null;
    server.use(
      http.post(ORDERS_GRAPH, async ({ request }) => {
        captured = (await request.json()) as {
          query: unknown;
          variables: unknown;
        };
        return HttpResponse.json({
          data: {
            orders: { edges: [], pageInfo: {}, totalCount: 0 },
          },
        });
      }),
    );

    const mod = await import("../../lib/tools/lookup-orders-ids");
    await mod.spec.handler(auth, {
      where: { stateIn: ["pending"] },
      first: 50,
      orderBy: { field: "SUBMITTED_AT", direction: "DESC" },
      environment: "production",
    });

    expect(captured).not.toBeNull();
    const c = captured as unknown as { query: string; variables: Record<string, unknown> };
    expect(typeof c.query).toBe("string");
    // The query is an inline constant — the LLM-supplied filter MUST live
    // on the variables envelope, never concatenated into the query text.
    expect(c.query).not.toContain("pending");
    expect(c.variables.first).toBe(50);
    const where = c.variables.where as { stateIn: string[] };
    expect(where.stateIn).toEqual(["pending"]);
    const orderBy = c.variables.orderBy as {
      field: string;
      direction: string;
    };
    expect(orderBy.field).toBe("SUBMITTED_AT");
    expect(orderBy.direction).toBe("DESC");
  });

  it("surfaces GraphQL errors[] in a 200 response (partial-success contract)", async () => {
    server.use(
      http.post(ORDERS_GRAPH, () =>
        HttpResponse.json({
          data: null,
          errors: [{ message: "field 'badField' not found", path: ["orders"] }],
        }),
      ),
    );

    const mod = await import("../../lib/tools/lookup-orders-ids");
    const result = await mod.spec.handler(auth, {
      where: { badField: true },
      environment: "production",
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain('"errors"');
    expect(text).toContain("field 'badField' not found");
  });

  it("rejects unauthenticated callers (missing auth.userId)", async () => {
    const mod = await import("../../lib/tools/lookup-orders-ids");
    await expect(
      mod.spec.handler(authAnon, { environment: "production" }),
    ).rejects.toThrow(/requires an authenticated user/);
  });

  it("maps HTTP 401 to QuiqupHttpError", async () => {
    server.use(
      http.post(ORDERS_GRAPH, () =>
        HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );

    const mod = await import("../../lib/tools/lookup-orders-ids");
    let thrown: unknown = null;
    try {
      await mod.spec.handler(auth, { environment: "production" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(QuiqupHttpError);
    expect((thrown as QuiqupHttpError).status).toBe(401);
  });

  it("rejects first > 500 (page-size cap)", async () => {
    const mod = await import("../../lib/tools/lookup-orders-ids");
    const parsed = mod.spec.inputSchema.safeParse({ first: 501 });
    expect(parsed.success).toBe(false);
  });

  it("rejects mixing forward and backward cursor modes (first+before)", async () => {
    const mod = await import("../../lib/tools/lookup-orders-ids");
    await expect(
      mod.spec.handler(auth, {
        first: 10,
        before: "cursor-x",
        environment: "production",
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it("rejects mixing forward and backward cursor modes (last+after)", async () => {
    const mod = await import("../../lib/tools/lookup-orders-ids");
    await expect(
      mod.spec.handler(auth, {
        last: 10,
        after: "cursor-x",
        environment: "production",
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it("rejects orderBy.field other than SUBMITTED_AT (literal locked)", async () => {
    const mod = await import("../../lib/tools/lookup-orders-ids");
    const parsed = mod.spec.inputSchema.safeParse({
      orderBy: { field: "EVENT_AT", direction: "ASC" },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("bulk_orders_lookup", () => {
  it("forwards client_order_ids as where.clientOrderIDIn on the variables envelope", async () => {
    let captured: { query: unknown; variables: unknown } | null = null;
    server.use(
      http.post(ORDERS_GRAPH, async ({ request }) => {
        captured = (await request.json()) as {
          query: unknown;
          variables: unknown;
        };
        return HttpResponse.json({
          data: { orders: { edges: [] } },
        });
      }),
    );

    const mod = await import("../../lib/tools/bulk-orders-lookup");
    await mod.spec.handler(auth, {
      client_order_ids: [12345, 12346, 12347],
      environment: "production",
    });

    expect(captured).not.toBeNull();
    const c = captured as unknown as {
      query: string;
      variables: { where: { clientOrderIDIn: number[] } };
    };
    expect(c.variables.where.clientOrderIDIn).toEqual([12345, 12346, 12347]);
    // IDs MUST go on the variables envelope, not the query text.
    expect(c.query).not.toContain("12345");
  });

  it("rejects empty client_order_ids (min 1)", async () => {
    const mod = await import("../../lib/tools/bulk-orders-lookup");
    const parsed = mod.spec.inputSchema.safeParse({ client_order_ids: [] });
    expect(parsed.success).toBe(false);
  });

  it("rejects > 200 ids (upstream first:200 hard-cap mirrored)", async () => {
    const mod = await import("../../lib/tools/bulk-orders-lookup");
    const ids = Array.from({ length: 201 }, (_, i) => i + 1);
    const parsed = mod.spec.inputSchema.safeParse({ client_order_ids: ids });
    expect(parsed.success).toBe(false);
  });

  it("rejects unauthenticated callers (missing auth.userId)", async () => {
    const mod = await import("../../lib/tools/bulk-orders-lookup");
    await expect(
      mod.spec.handler(authAnon, {
        client_order_ids: [1, 2, 3],
        environment: "production",
      }),
    ).rejects.toThrow(/requires an authenticated user/);
  });

  it("happy path returns items with weights", async () => {
    server.use(
      http.post(ORDERS_GRAPH, () =>
        HttpResponse.json({
          data: {
            orders: {
              edges: [
                {
                  node: {
                    id: "ord_1",
                    uuid: "uuid-1",
                    clientOrderID: 12345,
                    state: "pending",
                    items: [
                      {
                        id: "it_1",
                        name: "Widget",
                        parcelBarcode: "PB-001",
                        parcelBarcodeGeneratedBy: "quiqup",
                        quantity: 2,
                        weight: 0.5,
                      },
                    ],
                  },
                },
              ],
            },
          },
        }),
      ),
    );

    const mod = await import("../../lib/tools/bulk-orders-lookup");
    const result = await mod.spec.handler(auth, {
      client_order_ids: [12345],
      environment: "production",
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain('"weight"');
    expect(text).toContain("0.5");
    expect(text).toContain('"parcelBarcode"');
  });

  it("surfaces GraphQL errors[] in a 200 response", async () => {
    server.use(
      http.post(ORDERS_GRAPH, () =>
        HttpResponse.json({
          data: null,
          errors: [{ message: "lookup failed", path: ["orders"] }],
        }),
      ),
    );

    const mod = await import("../../lib/tools/bulk-orders-lookup");
    const result = await mod.spec.handler(auth, {
      client_order_ids: [1, 2, 3],
      environment: "production",
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain('"errors"');
    expect(text).toContain("lookup failed");
  });

  it("query selection set includes pageInfo { hasNextPage } + totalCount (03-REVIEW WR-03)", async () => {
    // 03-REVIEW WR-03 lockdown: if a future maintainer drops `pageInfo`
    // or `totalCount` from the BULK_ORDERS_LOOKUP_QUERY selection set,
    // this assertion trips. Orders Core treats GraphQL query text as
    // the response contract, so dropping these from the selection
    // would mean the response no longer carries them — and an agent
    // pairing this tool with `lookup_orders_ids` (which DOES request
    // both) would see asymmetric responses and could mistake a
    // truncation for an empty result.
    let captured: { query: string } | null = null;
    server.use(
      http.post(ORDERS_GRAPH, async ({ request }) => {
        const body = (await request.json()) as { query: string };
        captured = { query: body.query };
        return HttpResponse.json({
          data: {
            orders: {
              edges: [],
              pageInfo: { hasNextPage: false },
              totalCount: 0,
            },
          },
        });
      }),
    );
    const mod = await import("../../lib/tools/bulk-orders-lookup");
    await mod.spec.handler(auth, {
      client_order_ids: [1],
      environment: "production",
    });
    expect(captured).not.toBeNull();
    const q = (captured as unknown as { query: string }).query;
    expect(q).toContain("pageInfo");
    expect(q).toContain("hasNextPage");
    expect(q).toContain("totalCount");
  });

  it("surfaces pageInfo + totalCount in the response (03-REVIEW WR-03)", async () => {
    server.use(
      http.post(ORDERS_GRAPH, () =>
        HttpResponse.json({
          data: {
            orders: {
              edges: [
                {
                  node: {
                    id: "ord_1",
                    uuid: "uuid-1",
                    clientOrderID: 12345,
                    state: "pending",
                    items: [],
                  },
                },
              ],
              pageInfo: { hasNextPage: false },
              totalCount: 1,
            },
          },
        }),
      ),
    );
    const mod = await import("../../lib/tools/bulk-orders-lookup");
    const result = await mod.spec.handler(auth, {
      client_order_ids: [12345],
      environment: "production",
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain('"totalCount"');
    expect(text).toContain('"pageInfo"');
    expect(text).toContain('"hasNextPage"');
  });
});
