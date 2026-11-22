/**
 * `update_salla_config` — UPSERT a Salla connection's saved config + mapping
 * on platform-api.quiqup.com (Phase 2 / INTG-26).
 *
 * Endpoint: PUT https://platform-api.quiqup.com/integrations/configs/{connectionId}
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json, Content-Type: application/json
 *
 * Body shape (per source-doc lines 4408-4416, authoritative — the body is the
 * UNWRAPPED config shape; the write endpoint does NOT use a `{ config }`
 * envelope):
 *   {
 *     delivery_methods?: [{ platform_method, platform_method_id, service_kind, shipping_profile_id? }],
 *     locations?:        [{ platform_location_id, warehouse_id }],
 *     initial_order_states?: string[],
 *     awb_trigger?: "pending" | "ready_for_collection" | "at_depot" |
 *                   "out_for_delivery" | "on_shipment_webhook" |
 *                   "ready_for_collection_or_webhook",
 *     country_filter?: string[],      // ISO-3166 alpha-2
 *     sync_products?: boolean,
 *     auto_mark_as_rfc?: boolean,
 *     wms_delay_minutes?: number,     // [0, 10080] (1 week)
 *     is_manual_international_order_confirmed?: boolean
 *   }
 *
 * Response shape: empty (upstream returns no body). This MCP layer synthesizes
 * a structured echo `{ ok: true, connection_id }`.
 *
 * UPSERT semantic: if NO config exists for this connection yet, the upstream
 * CREATES one; otherwise it PARTIAL-UPDATES (only the supplied keys are
 * mutated, undefined keys preserve their existing values).
 *
 * Companion tools:
 *   - `get_salla_config` — returns the SAVED mapping (start here to see
 *     what's already configured; on a 404 it returns `{ config: null }`).
 *   - `get_salla_platform_data` — returns the LIVE catalog (use to discover
 *     valid `delivery_methods[].platform_method_id` from `shipping_methods[].id`
 *     and `locations[].platform_location_id` from `locations[].id`).
 *   - `list_service_kinds` (Phase 1 AUTH-08) — the canonical service_kind
 *     enum; passing a value not in that list is upstream-rejected with 422.
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform`).
 *   - 422       → upstream validation failure (e.g. unknown service_kind);
 *                 inspect attribute_errors in the response body.
 *   - 5xx       → upstream temporarily unavailable; retry.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl, iso3166Alpha2 } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({
  connection_id: z
    .string()
    .min(1)
    .describe(
      "Salla connection id (same value used by `get_salla_connection`).",
    ),
  delivery_methods: z
    .array(
      z.object({
        platform_method: z.string(),
        platform_method_id: z.string(),
        service_kind: z
          .string()
          .describe(
            "Quiqup service kind — MUST be one of the values returned by " +
              "`list_service_kinds` (Phase 1 AUTH-08). Upstream rejects " +
              "arbitrary strings with 422.",
          ),
        shipping_profile_id: z.string().optional(),
      }),
    )
    .optional()
    .describe(
      "Mapping from Salla shipping method (platform_method + platform_method_id " +
        "from `get_salla_platform_data.shipping_methods[]`) to Quiqup service " +
        "kind (from `list_service_kinds`).",
    ),
  locations: z
    .array(
      z.object({
        platform_location_id: z.string(),
        warehouse_id: z.string(),
      }),
    )
    .optional()
    .describe(
      "Mapping from Salla location (platform_location_id from " +
        "`get_salla_platform_data.locations[].id`) to Quiqup warehouse_id.",
    ),
  initial_order_states: z.array(z.string()).optional(),
  awb_trigger: z
    .enum([
      "pending",
      "ready_for_collection",
      "at_depot",
      "out_for_delivery",
      "on_shipment_webhook",
      "ready_for_collection_or_webhook",
    ])
    .optional()
    .describe(
      "When Quiqup should request the AWB from Salla — see source-doc enum " +
        "values. 'on_shipment_webhook' defers AWB-request until Salla webhooks " +
        "the shipment event; 'ready_for_collection_or_webhook' is the OR of " +
        "the rfc state and the webhook arrival.",
    ),
  // 02-REVIEW WR-01: enforce ISO-3166 alpha-2 via regex (was length(2) which
  // admitted "12", "  ", lowercase, etc.).
  country_filter: z
    .array(iso3166Alpha2)
    .optional()
    .describe(
      "ISO-3166 alpha-2 country codes — orders shipped to countries NOT in " +
        "this list are filtered out. Empty / omitted = no filter.",
    ),
  sync_products: z.boolean().optional(),
  auto_mark_as_rfc: z.boolean().optional(),
  wms_delay_minutes: z
    .number()
    .int()
    .min(0)
    .max(10080)
    .optional()
    .describe(
      "Delay in minutes before WMS picks up the order; capped at 1 week (10080).",
    ),
  is_manual_international_order_confirmed: z.boolean().optional(),
  idempotency_key: z
    .string()
    .optional()
    .describe(
      "Optional caller-supplied key to dedupe retries within a 15-minute window.",
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "update_salla_config",
  description:
    "UPSERT a Salla connection's saved config + mapping via PUT " +
    "/integrations/configs/{connection_id} on platform-api.quiqup.com. " +
    "Body shape (UNWRAPPED — the write endpoint does NOT use a `{ config }` " +
    "envelope): `{ delivery_methods?, locations?, initial_order_states?, " +
    "awb_trigger?, country_filter?, sync_products?, auto_mark_as_rfc?, " +
    "wms_delay_minutes?, is_manual_international_order_confirmed? }`. " +
    "Upstream response is empty; this tool synthesizes a structured echo " +
    "`{ ok: true, connection_id }`. " +
    "UPSERT semantic: if no config exists yet, upstream CREATES one; otherwise " +
    "it PARTIAL-UPDATES (only the keys you supply are mutated, undefined keys " +
    "preserve their existing values). Pair with `get_salla_config` for the " +
    "post-state. " +
    "awb_trigger ∈ 'pending' | 'ready_for_collection' | 'at_depot' | " +
    "'out_for_delivery' | 'on_shipment_webhook' | 'ready_for_collection_or_webhook'. " +
    "Per Phase 1 AUTH-08, `delivery_methods[].service_kind` MUST be a value " +
    "from `list_service_kinds` — passing an arbitrary string is upstream-" +
    "rejected with 422. " +
    "Companion reads: `get_salla_config` (current SAVED mapping); " +
    "`get_salla_platform_data` (LIVE catalog — source platform_method_id from " +
    "shipping_methods[].id and platform_location_id from locations[].id); " +
    "`list_service_kinds` (canonical service_kind enum). " +
    "country_filter entries are ISO-3166 alpha-2 (length-2); " +
    "wms_delay_minutes is bounded to [0, 10080] (1 week). " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 422 → upstream " +
    "validation failure (inspect attribute_errors — typical cause: unknown " +
    "service_kind); 5xx → upstream temporarily unavailable, retry. " +
    'Example: `{ "connection_id": "conn_abc123", "awb_trigger": "ready_for_collection", "wms_delay_minutes": 30 }`.',
  inputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 10, refillPerSec: 10 / 60 },
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("update_salla_config requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);

    // Build body from only the fields the caller actually supplied —
    // connection_id is path-only; idempotency_key + environment are tool-level
    // and must NOT leak upstream.
    const body: Record<string, unknown> = {};
    if (args.delivery_methods !== undefined)
      body.delivery_methods = args.delivery_methods;
    if (args.locations !== undefined) body.locations = args.locations;
    if (args.initial_order_states !== undefined)
      body.initial_order_states = args.initial_order_states;
    if (args.awb_trigger !== undefined) body.awb_trigger = args.awb_trigger;
    if (args.country_filter !== undefined)
      body.country_filter = args.country_filter;
    if (args.sync_products !== undefined)
      body.sync_products = args.sync_products;
    if (args.auto_mark_as_rfc !== undefined)
      body.auto_mark_as_rfc = args.auto_mark_as_rfc;
    if (args.wms_delay_minutes !== undefined)
      body.wms_delay_minutes = args.wms_delay_minutes;
    if (args.is_manual_international_order_confirmed !== undefined)
      body.is_manual_international_order_confirmed =
        args.is_manual_international_order_confirmed;

    const res = await fetch(
      `${platformApiBase}/integrations/configs/${encodeURIComponent(args.connection_id)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    if (!res.ok) {
      throw new QuiqupHttpError(res.status, await res.text());
    }

    // Upstream response is empty per source-doc — synthesize an echo.
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { ok: true, connection_id: args.connection_id },
            null,
            2,
          ),
        },
      ],
    };
  },
};
