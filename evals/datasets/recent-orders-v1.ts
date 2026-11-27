/**
 * recent-orders-v1 — first eval dataset for the recent_orders MCP tool.
 *
 * Each item: a natural-language merchant question + a hand-authored canonical
 * `recent_orders` tool call. Scored by ../score-recent-orders.ts.
 *
 * Relative-date handling: the dataset is anchored to a frozen TODAY so that
 * "last 3 days" / "last week" expectations stay stable. The runner passes
 * `TODAY` to Claude in the system prompt so its `from`/`to` arithmetic uses
 * the same anchor — otherwise the eval would drift with wall-clock time and
 * scores would be unrepeatable.
 *
 * Tool-side reference (lib/tools/recent-orders.ts):
 *   state: one of ORDER_STATES in lib/order-states.ts (default pending)
 *   from / to: YYYY-MM-DD (defaults: 7 days ago / today UTC)
 *   limit: 1..50 (default 5)
 */

export const TODAY = "2026-05-14";

// Helper for authoring: derive YYYY-MM-DD `daysAgo` days before TODAY (UTC).
// Inlined at module-eval time so expected values are literal strings in the
// emitted dataset — no runtime drift.
function daysAgo(days: number): string {
  const base = new Date(`${TODAY}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() - days);
  return base.toISOString().slice(0, 10);
}

export interface RecentOrdersInput {
  request: string;
}

export interface RecentOrdersExpected {
  tool: "recent_orders";
  args: Record<string, unknown>;
}

export interface RecentOrdersItem {
  input: RecentOrdersInput;
  expectedOutput: RecentOrdersExpected;
}

export const items: RecentOrdersItem[] = [
  {
    input: { request: "What orders are pending right now? Show me 5." },
    expectedOutput: {
      tool: "recent_orders",
      args: {
        state: "pending",
        limit: 5,
      },
    },
  },
  {
    input: {
      request:
        "Show me the orders whose delivery failed in the last 3 days. Up to 10 of them.",
    },
    expectedOutput: {
      tool: "recent_orders",
      args: {
        state: "delivery_failed",
        from: daysAgo(3),
        to: daysAgo(0),
        limit: 10,
      },
    },
  },
  {
    input: {
      request: "List delivered orders from the past week, max 20.",
    },
    expectedOutput: {
      tool: "recent_orders",
      args: {
        state: "delivery_complete",
        from: daysAgo(7),
        to: daysAgo(0),
        limit: 20,
      },
    },
  },
  {
    input: { request: "Any cancelled orders yesterday? Just the top 3." },
    expectedOutput: {
      tool: "recent_orders",
      args: {
        state: "cancelled",
        from: daysAgo(1),
        to: daysAgo(1),
        limit: 3,
      },
    },
  },
  {
    input: {
      request:
        "Give me everything out for delivery from the last 14 days, up to 50 orders.",
    },
    expectedOutput: {
      tool: "recent_orders",
      args: {
        state: "out_for_delivery",
        from: daysAgo(14),
        to: daysAgo(0),
        limit: 50,
      },
    },
  },
  {
    input: {
      request: "Show orders sitting at the depot from the last 2 days. Limit 15.",
    },
    expectedOutput: {
      tool: "recent_orders",
      args: {
        state: "at_depot",
        from: daysAgo(2),
        to: daysAgo(0),
        limit: 15,
      },
    },
  },
];
