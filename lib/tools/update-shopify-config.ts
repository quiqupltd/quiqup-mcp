/**
 * `update_shopify_config` — update a Shopify shop's saved config + mapping on
 * platform-api.quiqup.com (Phase 2 / INTG-10).
 *
 * Endpoint: PUT https://platform-api.quiqup.com/shopify/config
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json, Content-Type: application/json
 *
 * Body shape (per source-doc lines 1487-1515, authoritative):
 *   { shop_name, delivery_methods?, locations?, auto_mark_as_rfc?,
 *     fulfillment_state?, is_manual_international_order_confirmed?,
 *     wms_delay_minutes? }
 *
 * Companion reads:
 *   - `get_shopify_config` → returns the current SAVED mapping (start here
 *     to see what's already configured).
 *   - `list_shopify_delivery_methods` + `list_shopify_locations` → the LIVE
 *     Shopify catalogs (use to discover the codes/ids the storefront accepts
 *     when building the `delivery_methods[]` / `locations[]` arrays).
 *
 * Sibling write: `update_shopify_connection` updates the connection
 * CREDENTIALS (code + token + is_fulfillment). Use this tool for the mapping
 * / config (delivery methods, locations, fulfillment state, wms delay) — the
 * two endpoints are intentionally separate upstream.
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform`).
 *   - 404       → shop_name does not match an existing connection — verify
 *                 against `list_integration_connections`.
 *   - 422       → upstream validation failure (inspect attribute_errors).
 *   - 5xx       → upstream temporarily unavailable; retry.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({
  shop_name: z
    .string()
    .min(1)
    .describe(
      "Shopify shop short name. MUST match an existing connection — verify " +
        "via `list_integration_connections`; upstream returns 404 otherwise.",
    ),
  delivery_methods: z
    .array(
      z.object({
        quiqup_name: z.string(),
        shipping_method_id: z.string(),
        shipping_profile_id: z.string(),
        shopify_name: z.string(),
      }),
    )
    .optional()
    .describe(
      "Mapping from Quiqup delivery method (quiqup_name) to Shopify " +
        "delivery method (shopify_name) — include shipping_method_id + " +
        "shipping_profile_id from the live catalog (list_shopify_delivery_methods). " +
        "ARRAY-REPLACE semantics (02-REVIEW WR-08): if you supply this field, " +
        "the upstream replaces the whole `delivery_methods[]` list with what " +
        "you send. Read the current list first via `get_shopify_config`, " +
        "splice / modify the items locally, then PUT the full updated array " +
        "back. Each item MUST carry all four fields (the schema enforces this).",
    ),
  locations: z
    .array(
      z.object({
        quiqup_location: z.string(),
        shopify_location: z.string(),
      }),
    )
    .optional()
    .describe(
      "Mapping from Quiqup ship-from location to Shopify location code. " +
        "Discover valid `shopify_location` values via `list_shopify_locations`. " +
        "ARRAY-REPLACE semantics (02-REVIEW WR-08): same shape as " +
        "delivery_methods[] — supplying this field replaces the whole list. " +
        "Read with `get_shopify_config`, modify locally, PUT back in full.",
    ),
  auto_mark_as_rfc: z.boolean().optional(),
  fulfillment_state: z.string().optional(),
  is_manual_international_order_confirmed: z.boolean().optional(),
  wms_delay_minutes: z
    .number()
    .int()
    .min(0)
    .max(10080)
    .optional()
    .describe(
      "Delay in minutes before WMS picks up the order; capped at 1 week (10080).",
    ),
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
  name: "update_shopify_config",
  description:
    "Update a Shopify shop's saved config + mapping via PUT /shopify/config " +
    "on platform-api.quiqup.com. " +
    "Response shape: `{ message, resolved_inventory_item_id? }`. " +
    "All fields except `shop_name` are optional — only the keys supplied are " +
    "forwarded upstream (partial update at the TOP LEVEL). " +
    "Note (02-REVIEW WR-08): the `delivery_methods[]` and `locations[]` " +
    "arrays use ARRAY-REPLACE semantics when supplied — read the current " +
    "list via `get_shopify_config` first, modify it locally, then PUT the " +
    "full updated array back. " +
    "Companion reads: `get_shopify_config` (current SAVED mapping); " +
    "`list_shopify_delivery_methods` + `list_shopify_locations` (LIVE Shopify " +
    "catalogs — use to discover codes/ids when building delivery_methods[] / " +
    "locations[] arrays). " +
    "Sibling write: use `update_shopify_connection` for connection CREDENTIALS " +
    "(code + token + is_fulfillment); use THIS tool for mapping/config. " +
    "shop_name MUST match an existing connection (run `list_integration_connections` " +
    "to verify) — upstream returns 404 otherwise. wms_delay_minutes is bounded " +
    "to [0, 10080] (1 week). " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 404 → shop_name " +
    "unknown; 422 → upstream validation failure (inspect attribute_errors); 5xx " +
    "→ upstream temporarily unavailable, retry. " +
    'Example: `{ "shop_name": "acme-store", "auto_mark_as_rfc": true, "wms_delay_minutes": 30 }`.',
  inputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 10, refillPerSec: 10 / 60 },
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("update_shopify_config requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);

    // Build body from only the fields the caller actually supplied —
    // idempotency_key + environment are tool-level and must NOT leak upstream.
    const body: Record<string, unknown> = { shop_name: args.shop_name };
    if (args.delivery_methods !== undefined)
      body.delivery_methods = args.delivery_methods;
    if (args.locations !== undefined) body.locations = args.locations;
    if (args.auto_mark_as_rfc !== undefined)
      body.auto_mark_as_rfc = args.auto_mark_as_rfc;
    if (args.fulfillment_state !== undefined)
      body.fulfillment_state = args.fulfillment_state;
    if (args.is_manual_international_order_confirmed !== undefined)
      body.is_manual_international_order_confirmed =
        args.is_manual_international_order_confirmed;
    if (args.wms_delay_minutes !== undefined)
      body.wms_delay_minutes = args.wms_delay_minutes;

    const res = await fetch(`${platformApiBase}/shopify/config`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new QuiqupHttpError(res.status, await res.text());
    }

    const data = await res.json();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
};
