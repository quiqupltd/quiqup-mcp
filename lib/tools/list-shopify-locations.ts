/**
 * `list_shopify_locations` — fetch the LIVE Shopify ship-from-location catalog
 * for a shop from platform-api.quiqup.com (Phase 2 / INTG-09).
 *
 * Endpoint: GET https://platform-api.quiqup.com/shopify/locations?shop_name=<>
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json
 *
 * Per source-doc lines 1471-1485 `shop_name` is a REQUIRED query param. The
 * response is the catalog of ship-from locations the Shopify storefront
 * currently exposes — distinct from the SAVED mapping returned by
 * `get_shopify_config.locations`.
 *
 * Response shape:
 *   { locations: [{ code, shipping_method_id, title }] }
 *
 * Companion-tool path:
 *   - Use to discover what ship-from locations the Shopify storefront
 *     currently exposes when building an `update_shopify_config` payload.
 *   - Pair with `list_shopify_delivery_methods` (same query-param shape) for
 *     the delivery-method catalog.
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
      "Shopify shop short name — same value used by `get_shopify_config`.",
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "list_shopify_locations",
  description:
    "Fetch the LIVE Shopify ship-from-location catalog for a shop via " +
    "GET /shopify/locations?shop_name= on platform-api.quiqup.com. " +
    "Response shape: `{ locations: [{ code, shipping_method_id, title }] }`. " +
    "This is the LIVE ship-from-location catalog from Shopify (the locations " +
    "the storefront currently exposes) — NOT the saved mapping; the saved " +
    "mapping is in `get_shopify_config.locations`. " +
    "Use this to discover what ship-from locations the Shopify storefront " +
    "currently exposes when building the `locations[]` mapping in an " +
    "`update_shopify_config` payload. " +
    "Pair with `list_shopify_delivery_methods` (same query-param shape) for " +
    "the delivery-method catalog. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 404 → " +
    "shop_name unknown (verify against `list_integration_connections`); " +
    "5xx → upstream temporarily unavailable, retry. " +
    'Example: `{ "shop_name": "acme-store", "environment": "production" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("list_shopify_locations requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const url = new URL(`${platformApiBase}/shopify/locations`);
    url.searchParams.set("shop_name", args.shop_name);

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/json",
      },
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
