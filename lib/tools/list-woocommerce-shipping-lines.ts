/**
 * `list_woocommerce_shipping_lines` — fetch the LIVE WooCommerce shipping-line
 * catalog for a site from platform-api.quiqup.com (Phase 2 / INTG-16).
 *
 * Endpoint: GET https://platform-api.quiqup.com/woocommerce/shipping-lines?site_url=<>
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json
 *
 * Per source-doc lines 1617-1639 `site_url` is a REQUIRED query param. The
 * response is the catalog of shipping methods the WooCommerce storefront
 * currently exposes — distinct from the SAVED mapping returned by
 * `get_woocommerce_config.delivery_method`.
 *
 * Response shape:
 *   { shipping_methods: [{ enabled, id, instance_id, method_description,
 *     method_id, method_title, order, settings, title, zone_id, zone_name }] }
 *
 * Companion-tool path:
 *   - Pair with `upsert_woocommerce_config` when building `delivery_method[]`
 *     mappings — the upstream `method_id` values here are the legal
 *     `delivery_method[].woocommerce.method_id` values.
 *
 * SSRF note: `site_url` is a LOOKUP KEY against Quiqup's saved connections —
 * Quiqup does NOT fetch the URL. SSRF is structurally impossible here, but
 * the schema still bounds the value to z.string().url() to reject obvious
 * misuse.
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform`).
 *   - 404       → site_url unknown — verify against `list_woocommerce_connections`.
 *   - 5xx       → upstream temporarily unavailable; retry after a few seconds.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({
  site_url: z
    .string()
    .url()
    .describe(
      "Full WooCommerce site URL, e.g. https://acme.example.com — matches " +
        "`list_woocommerce_connections[].site_url`.",
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "list_woocommerce_shipping_lines",
  description:
    "Fetch the LIVE WooCommerce shipping-line catalog for a site via " +
    "GET /woocommerce/shipping-lines?site_url= on platform-api.quiqup.com. " +
    "Response shape: `{ shipping_methods: [{ id, instance_id, method_id, " +
    "method_title, method_description, title, enabled, order, settings, " +
    "zone_id, zone_name }] }`. " +
    "This is the LIVE shipping-method catalog from WooCommerce (the methods " +
    "the storefront currently exposes) — NOT the saved mapping; the saved " +
    "mapping is in `get_woocommerce_config.delivery_method`. " +
    "Pair with `upsert_woocommerce_config` when building `delivery_method[]` " +
    "mappings — the upstream `method_id` values returned here are the legal " +
    "`delivery_method[].woocommerce.method_id` values. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 404 → " +
    "site_url unknown (verify against `list_woocommerce_connections`); 5xx → " +
    "upstream temporarily unavailable, retry. " +
    'Example: `{ "site_url": "https://acme.example.com", "environment": "production" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error(
        "list_woocommerce_shipping_lines requires an authenticated user",
      );
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const url = new URL(`${platformApiBase}/woocommerce/shipping-lines`);
    url.searchParams.set("site_url", args.site_url);

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
