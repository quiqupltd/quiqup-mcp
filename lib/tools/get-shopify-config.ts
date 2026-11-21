/**
 * `get_shopify_config` — read a Shopify shop's saved config + mapping from
 * platform-api.quiqup.com (Phase 2 / INTG-07).
 *
 * Endpoint: GET https://platform-api.quiqup.com/shopify/config/{shopName}
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json
 *
 * Response shape (per source-doc lines 1430-1453, authoritative):
 *   { shop_name, delivery_methods[], locations[], auto_mark_as_rfc,
 *     is_fulfillment, fulfillment_state,
 *     is_manual_international_order_confirmed, wms_delay_minutes, user_id }
 *
 * Companion-tool path:
 *   - Use `list_integration_connections` first to discover which shop_name
 *     values exist for this account (filter by source === 'shopify'); then
 *     read THIS tool for the shop's saved mapping/config.
 *   - The LIVE catalogs (current Shopify delivery methods + locations the
 *     storefront actually offers) come from `list_shopify_delivery_methods`
 *     and `list_shopify_locations` — NOT from this tool. This tool returns
 *     the SAVED mapping; the live catalogs feed updates via
 *     `update_shopify_config`.
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform`).
 *   - 404       → shop_name unknown — verify against `list_integration_connections`.
 *   - 5xx       → upstream temporarily unavailable; retry after a few seconds.
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
      "Shopify shop subdomain or short name (the value returned by " +
        "`list_integration_connections[].shop_name` where source==='shopify'). " +
        "Example: 'acme-store'.",
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "get_shopify_config",
  description:
    "Read a Shopify shop's SAVED config + mapping via " +
    "GET /shopify/config/{shop_name} on platform-api.quiqup.com. " +
    "Response shape: `{ shop_name, delivery_methods[], locations[], " +
    "auto_mark_as_rfc, is_fulfillment, fulfillment_state, " +
    "is_manual_international_order_confirmed, wms_delay_minutes, user_id }`. " +
    "Use `list_integration_connections` first to discover which shop_name " +
    "values exist for this account (filter source==='shopify'); then read " +
    "this tool for the shop's saved mapping/config. " +
    "The LIVE catalogs (current Shopify delivery methods + locations the " +
    "storefront actually offers) come from `list_shopify_delivery_methods` " +
    "and `list_shopify_locations` — NOT from this tool. This tool returns " +
    "the SAVED mapping; pair with the live catalogs when building an " +
    "`update_shopify_config` payload. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 404 → " +
    "shop_name unknown (verify against `list_integration_connections`); " +
    "5xx → upstream temporarily unavailable, retry. " +
    'Example: `{ "shop_name": "acme-store", "environment": "production" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("get_shopify_config requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const res = await fetch(
      `${platformApiBase}/shopify/config/${encodeURIComponent(args.shop_name)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/json",
        },
      },
    );

    if (!res.ok) {
      throw new QuiqupHttpError(res.status, await res.text());
    }

    const data = await res.json();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
};
