/**
 * `get_order_history` — fetch an order's full state-transition timeline
 * from the Quiqup REST public API (Phase 3 / ORDS-02).
 *
 * Endpoint: GET /orders/{id}/history on the Quiqup REST host
 *   (api.quiqup.com / api.staging.quiqup.com).
 *
 * Auth: Standard V3b Clerk → Quiqup session-JWT bridge — IDENTICAL to
 * every other Quiqup-side read tool. The Bearer header is minted by
 * `getQuiqupReadyJwt(auth.userId)`; the handler refuses to run when
 * `auth.userId` is null (BL-04 server-derived identity gate).
 *
 * Disambiguation: this tool returns the STATE-TRANSITION timeline (when
 * did the order go from `pending` → `live` → `delivered`, by which
 * operator, with which on-hold/return reason). For the FIELD-LEVEL audit
 * log (who edited the address, when, before/after), use
 * `list_order_audit_events` — those are two different upstream services
 * (Quiqup REST vs Audit) with different payload shapes.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupRestClient } from "@/lib/clients/quiqup-rest";
import { environmentField } from "@/lib/clients/quiqup-env";
import { getQuiqupReadyJwt } from "@/lib/quiqup";

const inputSchema = z.object({
  order_id: z
    .string()
    .min(1)
    .describe(
      "Quiqup clientOrderID (rendered as string by the upstream — see app/lib/orders.ts:478). " +
        "Find via `lookup_orders_ids` or `recent_orders`.",
    ),
  environment: environmentField,
});

const outputSchema = z
  .object({
    history: z.array(z.unknown()),
  })
  .passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "get_order_history",
  description:
    "Fetch the full state-transition history of a Quiqup order. " +
    "Endpoint: GET /orders/{id}/history (Quiqup REST host — api.quiqup.com). " +
    "Returns `{ history: [{ to_state, occurred_at, author { email, fullname, role } | null, " +
    "custodian { custodian_name, custodian_type }, delivery_metrics { calls, messages }, " +
    "on_hold_reason, reason, return_to_origin_reason, " +
    "internal_order { id, type, job_id, delivery_failure_reason, mission, origin, destination } | null, " +
    "events }] }`. " +
    "When to use which: `list_order_audit_events` is the better default for " +
    "'who did X to this order' — it also captures state-transition events " +
    "(e.g. `marked_as_ready_for_collection`, `marked_as_cancelled`) with full " +
    "actor info and field-level before/after diffs (Audit service), and is " +
    "more reliable than this endpoint. Reach for `get_order_history` " +
    "specifically when you need the state-transition-specific metadata that " +
    "the Audit service does not carry: `on_hold_reason`, " +
    "`return_to_origin_reason`, `delivery_metrics`, custodian transitions, " +
    "or the `internal_order` linkage. " +
    "PII warning: Response includes `history[].author.email` for operator actors. " +
    "Audit-log middleware redacts emails at-rest; the agent sees them in the tool result. " +
    "Error modes: 401/403 → run `whoami_platform` to confirm the JWT resolves; " +
    "404 → verify the clientOrderID with `lookup_orders_ids`; " +
    "5xx → upstream temporarily unavailable, retry in a few seconds; " +
    "`fetch failed` with no HTTP status → upstream timeout or transport error. " +
    "This endpoint is heavier than `get_lastmile_order` (joins state transitions, " +
    "custodians, delivery_metrics, internal_order) and can exceed the MCP transport " +
    "timeout, especially on the first call in a session (serverless cold start). " +
    "Retry at most once with a brief delay; if the second attempt also fails, fall " +
    "back to `list_order_audit_events` (using the order's `uuid` from " +
    "`get_lastmile_order`) rather than retrying further — it carries the same " +
    "actor + state-transition data for cancellation/state-change queries. " +
    "Only insist on `get_order_history` when you specifically need `on_hold_reason`, " +
    "`return_to_origin_reason`, `delivery_metrics`, or `internal_order` fields. " +
    'Example: `{ "order_id": "12345", "environment": "production" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("get_order_history requires an authenticated user");
    }

    const jwt = await getQuiqupReadyJwt(auth.userId);
    const client = new QuiqupRestClient({ jwt, environment: args.environment });

    // encodeURIComponent for path-param hygiene (T-03-10 — prevents
    // injection of `/` or `?` characters into the URL path).
    const data = await client.request(
      "GET",
      `/orders/${encodeURIComponent(args.order_id)}/history`,
    );

    return {
      content: [
        { type: "text" as const, text: JSON.stringify(data, null, 2) },
      ],
    };
  },
};
