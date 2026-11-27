/**
 * Every Quiqup order state, exactly as GET /quiqup/orders/states returns them
 * (the `list_quiqup_order_states` tool). The last-mile API matches
 * `filters[state]` literally, so a name outside this list silently returns no
 * orders. Before sc-34635 `recent_orders` offered `delivered`, `failed`,
 * `in_progress` and `live`, none of which exist upstream.
 *
 * Kept dependency-free so the eval runner (evals/recent-orders.ts) can import
 * the same list as the tool and the two cannot drift apart.
 */
export const ORDER_STATES = [
  "pending",
  "ready_for_collection",
  "picking_started",
  "out_for_collection",
  "out_for_return",
  "at_depot",
  "received_at_depot",
  "in_transit",
  "out_for_delivery",
  "collection_failed",
  "on_hold",
  "scheduled",
  "return_to_origin",
  "returned_to_origin",
  "cancelled",
  "collected",
  "delivery_complete",
  "delivery_failed",
] as const;

export type OrderState = (typeof ORDER_STATES)[number];
