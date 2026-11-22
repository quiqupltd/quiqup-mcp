/**
 * `get_woocommerce_config` — read a WooCommerce site's saved config + mapping
 * from platform-api.quiqup.com (Phase 2 / INTG-14).
 *
 * Endpoint: GET https://platform-api.quiqup.com/woocommerce/config/{siteName}
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json
 *
 * Response shape (per source-doc lines 1575-1606, authoritative):
 *   { auto_mark_as_rfc, country_filter[], delivery_method[], initial_order_state,
 *     initial_order_states[], is_manual_international_order_confirmed, location,
 *     site_url, states[], sync_products, tracking_link, updated_at, user_id,
 *     wms_delay_minutes, created_at }
 *
 * Companion-tool path:
 *   - Use `list_integration_connections` (filter source==='woocommerce') or
 *     `list_woocommerce_connections` first to discover which site_name values
 *     exist for this account; then read THIS tool for the SAVED mapping/config.
 *   - The LIVE shipping-method catalog (the methods the WooCommerce storefront
 *     currently exposes) comes from `list_woocommerce_shipping_lines` —
 *     NOT from this tool.
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform`).
 *   - 404       → site_name unknown — verify against `list_integration_connections`.
 *   - 5xx       → upstream temporarily unavailable; retry after a few seconds.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({
  site_name: z
    .string()
    .min(1)
    .describe(
      "WooCommerce site identifier (matches " +
        "`list_woocommerce_connections[].shop_name`; this is the site " +
        "short-name, NOT the full site_url).",
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "get_woocommerce_config",
  description:
    "Read a WooCommerce site's SAVED config + mapping via " +
    "GET /woocommerce/config/{site_name} on platform-api.quiqup.com. " +
    "Response shape: `{ auto_mark_as_rfc, country_filter[], delivery_method[], " +
    "initial_order_state, initial_order_states[], " +
    "is_manual_international_order_confirmed, location, site_url, states[], " +
    "sync_products, tracking_link, wms_delay_minutes, updated_at, " +
    "created_at, user_id }`. " +
    "Use `list_integration_connections` (filter source==='woocommerce') or " +
    "`list_woocommerce_connections` first to discover which site_name values " +
    "exist for this account; then read this tool for the saved mapping/config. " +
    "The LIVE shipping-method catalog (the methods the WooCommerce storefront " +
    "currently exposes) comes from `list_woocommerce_shipping_lines` — NOT " +
    "from this tool. This tool returns the SAVED mapping; pair with the live " +
    "catalog when building an `upsert_woocommerce_config` payload. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 404 → " +
    "site_name unknown (verify against `list_integration_connections`); " +
    "5xx → upstream temporarily unavailable, retry. " +
    'Example: `{ "site_name": "acme-store", "environment": "production" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("get_woocommerce_config requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const res = await fetch(
      `${platformApiBase}/woocommerce/config/${encodeURIComponent(args.site_name)}`,
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
