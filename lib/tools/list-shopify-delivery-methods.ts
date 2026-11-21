/**
 * `list_shopify_delivery_methods` — fetch the LIVE Shopify delivery-method
 * catalog for a shop from platform-api.quiqup.com (Phase 2 / INTG-08).
 *
 * Endpoint: GET https://platform-api.quiqup.com/shopify/delivery-methods?shop_name=<>
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json
 *
 * Per source-doc lines 1455-1469 `shop_name` is a REQUIRED query param. The
 * response is the catalog of delivery methods the Shopify storefront
 * currently offers — distinct from the SAVED mapping returned by
 * `get_shopify_config.delivery_methods`.
 *
 * Response shape:
 *   { delivery_methods: [{ code, shipping_method_id, title }] }
 *
 * Companion-tool path:
 *   - Use to discover what delivery options the Shopify storefront currently
 *     offers when building an `update_shopify_config` payload.
 *   - Pair with `list_shopify_locations` (same query-param shape) for ship-from
 *     locations.
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
  name: "list_shopify_delivery_methods",
  description:
    "Fetch the LIVE Shopify delivery-method catalog for a shop via " +
    "GET /shopify/delivery-methods?shop_name= on platform-api.quiqup.com. " +
    "Response shape: `{ delivery_methods: [{ code, shipping_method_id, title }] }`. " +
    "This is the LIVE delivery-method catalog from Shopify (the methods the " +
    "storefront currently offers) — NOT the saved mapping; the saved mapping " +
    "is in `get_shopify_config.delivery_methods`. " +
    "Use this to discover what delivery options the Shopify storefront " +
    "currently offers when building an `update_shopify_config` payload. " +
    "Pair with `list_shopify_locations` (same query-param shape) for the " +
    "ship-from-location catalog. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 404 → " +
    "shop_name unknown (verify against `list_integration_connections`); " +
    "5xx → upstream temporarily unavailable, retry. " +
    'Example: `{ "shop_name": "acme-store", "environment": "production" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error(
        "list_shopify_delivery_methods requires an authenticated user",
      );
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const url = new URL(`${platformApiBase}/shopify/delivery-methods`);
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
