/**
 * `list_order_audit_events` — fetch an order's field-level audit-event
 * timeline from the Quiqup Audit service (Phase 3 / ORDS-05).
 *
 * Endpoint: GET {AUDIT_BASE_URL}/events?resourceID.eq={orderUuid} on the
 *   Audit service host (audit.quiqup.com / audit.staging.quiqup.com).
 *
 * Auth: the caller's Clerk session JWT is forwarded to Audit as a Bearer
 * token, like every other Quiqup-side tool (see lib/clients/audit.ts). Audit
 * scopes the result: Quiqup staff see every event, merchants only events for
 * their own account's orders.
 *
 * Disambiguation: this tool returns the FIELD-LEVEL audit log (who edited
 * the address, when, before/after values, etc). For the STATE-TRANSITION
 * timeline (state changes over time with associated operator/reasons), use
 * `get_order_history` — those are two different upstream services
 * (Audit vs Quiqup REST) with different payload shapes.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { AuditClient } from "@/lib/clients/audit";
import { getQuiqupReadyJwt } from "@/lib/quiqup";
import { environmentField } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({
  order_uuid: z
    .string()
    .uuid()
    .describe(
      "The order UUID (NOT the clientOrderID — these are different). " +
        "Get it from the order details payload's `uuid` field (e.g. " +
        "`get_lastmile_order` response, or `bulk_orders_lookup[].uuid`).",
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "list_order_audit_events",
  description:
    "Fetch the field-level audit-event timeline for a Quiqup order. " +
    "Endpoint: GET {AUDIT_BASE_URL}/events?resourceID.eq={orderUuid} " +
    "(Audit service host — audit.quiqup.com). " +
    "Returns `{ events: [{ eventID, resourceID, occurredAt, actor, action, changes }] }`. " +
    "The frontend stores this whole response without parsing — fields beyond " +
    "the documented set may appear. " +
    "When to use which: for the FIELD-LEVEL audit log (who edited the " +
    "address, when, before/after diff), use this tool. For the " +
    "STATE-TRANSITION timeline (state changes over time with associated " +
    "operator/reasons), use `get_order_history` instead. These are " +
    "different upstream services (Audit vs Quiqup REST) with different " +
    "payload shapes. " +
    "PII warning: Audit records contain `actor.email`. Surfacing them is " +
    "expected; M6 audit-log redaction handles the at-rest layer. " +
    "Auth posture: the signed-in user's Clerk session token is forwarded to " +
    "Audit as a Bearer token. Audit scopes the result to the caller: Quiqup " +
    "staff see every order's events, merchants only their own account's, so " +
    "an order that belongs to someone else returns an empty `events` list. " +
    "Do not pass any `token`, `bearer`, or `jwt` fields — the tool surface " +
    "deliberately has none. " +
    "Error modes: 401 → the session token is missing or invalid (run " +
    "`whoami_platform` to confirm the JWT resolves); 403 → the user is " +
    "neither Quiqup staff nor linked to an account; other 4xx → upstream " +
    "config issue (wrong base URL? AUDIT_BASE_URL env var unset in this " +
    "environment?); 5xx → upstream temporarily unavailable. " +
    'Example: `{ "order_uuid": "6d0c2ad3-4dcf-4e3a-aa72-89e6f6c2a9b5", "environment": "production" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error(
        "list_order_audit_events requires an authenticated user",
      );
    }

    // Same V3b same-IdP exchange as the other Quiqup-side tools: Audit
    // verifies the Clerk "default" template token that Quiqdash sends too.
    const jwt = await getQuiqupReadyJwt(auth.userId);
    const client = new AuditClient({ jwt, environment: args.environment });

    // Dotted query-key (resourceID.eq) per source-doc §19 B line 4259.
    // URLSearchParams round-trips the literal `.` intact.
    const data = await client.request("GET", "/events", {
      query: { "resourceID.eq": args.order_uuid },
    });

    return {
      content: [
        { type: "text" as const, text: JSON.stringify(data, null, 2) },
      ],
    };
  },
};
