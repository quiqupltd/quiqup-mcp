/**
 * orders-graphql-v1 — first eval dataset for the Phase-3 Orders Core GraphQL
 * family (lookup_orders_ids + bulk_orders_lookup).
 *
 * Each item: a natural-language merchant question + the canonical Phase-3
 * Orders-Core-GraphQL tool call. Scored by ../score-orders-graphql.ts.
 *
 * The dataset spans the family's disambiguation surface:
 *   - lookup_orders_ids   → clientOrderID-only listing, where-filtered,
 *                            cursor-paginated.
 *   - bulk_orders_lookup  → per-item weights + parcel barcodes for a known
 *                            set of clientOrderIDs, capped at 200.
 *
 * No real merchant data — clientOrderIDs are obvious placeholders.
 *
 * Tool-side reference (lib/tools/*.ts):
 *   lookup_orders_ids   — { first?, last?, after?, before?, where?, orderBy?, environment? }
 *   bulk_orders_lookup  — { client_order_ids: number[], environment? }
 */

export const TODAY = "2026-05-19";

export interface OrdersGraphqlInput {
  request: string;
}

export interface OrdersGraphqlExpected {
  tool: "lookup_orders_ids" | "bulk_orders_lookup";
  args: Record<string, unknown>;
}

export interface OrdersGraphqlItem {
  input: OrdersGraphqlInput;
  expectedOutput: OrdersGraphqlExpected;
}

export const items: OrdersGraphqlItem[] = [
  {
    input: {
      request:
        "Get me only the IDs of pending orders submitted in the last week, 100 per page.",
    },
    expectedOutput: {
      tool: "lookup_orders_ids",
      args: {
        first: 100,
        where: {
          stateIn: ["pending"],
        },
      },
    },
  },
  {
    input: {
      request:
        "Bulk-fetch weights for orders 12345, 12346, 12347 so I can recompute totals.",
    },
    expectedOutput: {
      tool: "bulk_orders_lookup",
      args: {
        client_order_ids: [12345, 12346, 12347],
      },
    },
  },
  {
    input: {
      request: "Show me the first 50 cancelled orders sorted newest-first.",
    },
    expectedOutput: {
      tool: "lookup_orders_ids",
      args: {
        first: 50,
        where: {
          stateIn: ["cancelled"],
        },
        orderBy: { field: "SUBMITTED_AT", direction: "DESC" },
      },
    },
  },
  {
    input: {
      request:
        "Re-fetch parcel barcodes for these clientOrderIDs: 9001, 9002, 9003, 9004, 9005.",
    },
    expectedOutput: {
      tool: "bulk_orders_lookup",
      args: {
        client_order_ids: [9001, 9002, 9003, 9004, 9005],
      },
    },
  },
  {
    input: {
      request:
        "Page through delivered orders — give me the next page after cursor 'YXJyYXljb25uZWN0aW9uOjEwMA=='.",
    },
    expectedOutput: {
      tool: "lookup_orders_ids",
      args: {
        first: 100,
        after: "YXJyYXljb25uZWN0aW9uOjEwMA==",
        where: {
          stateIn: ["delivery_complete"],
        },
      },
    },
  },
  {
    input: {
      request:
        "I need the IDs of every order whose source is 'shopify' from May 1st through May 19th 2026.",
    },
    expectedOutput: {
      tool: "lookup_orders_ids",
      args: {
        where: {
          sourceIn: ["shopify"],
          submittedAtGTE: "2026-05-01T00:00:00Z",
          submittedAtLTE: "2026-05-19T00:00:00Z",
        },
      },
    },
  },
  {
    input: {
      request:
        "Bulk-look-up orders 7777 and 8888 — I need their parcel barcodes for the bulk weight modal.",
    },
    expectedOutput: {
      tool: "bulk_orders_lookup",
      args: {
        client_order_ids: [7777, 8888],
      },
    },
  },
];
