/**
 * `send_orders_for_collection` — release pending orders to operations via
 * `PUT /quiqdash/orders/batch/set_ready_for_collection` on platform-api.
 *
 * This is the merchant app's "Mark as ready for collection" action, in bulk
 * (1 to 10 orders). It is the route a server agent uses, as the merchant,
 * to send a pending order on to ops. Body: `{ orderIds: string[] }`
 * (camelCase on the platform route, unlike the ex-core `order_ids` shape the
 * other ORDT batch tools send; see `bodyKey` in the factory).
 *
 * Distinct from `mark_ready_for_collection`, which is the single-order
 * last-mile route (`PUT /orders/{id}/ready_for_collection` on api-ae).
 *
 * The confirm gate, per-order ownership check, dry-run shape, per-caller
 * rate limit (3 batches / minute), idempotency (15 min) and audit all come
 * from the batch-transition factory.
 */

import { defineBatchTransition } from "./_batch-transition-factory";

export const spec = defineBatchTransition({
  name: "send_orders_for_collection",
  path: "/quiqdash/orders/batch/set_ready_for_collection",
  bodyKey: "orderIds",
  description:
    "Send pending orders on to Quiqup operations (merchant action 'Mark as " +
    "ready for collection'): PUT /quiqdash/orders/batch/set_ready_for_collection " +
    "on platform-api with body { orderIds }. The orders enter live dispatch " +
    "and can no longer be cancelled freely. May be refused if the merchant has " +
    "no payment method on file. Up to 10 orders per call.",
});
