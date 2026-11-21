/**
 * `upsert_woocommerce_config` — upsert the mapping / config for a WooCommerce
 * site on platform-api.quiqup.com (Phase 2 / INTG-18).
 *
 * Endpoint: PUT https://platform-api.quiqup.com/woocommerce/settings/config/upsert
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json, Content-Type: application/json
 *
 * Body shape (per source-doc lines 1659-1678, authoritative):
 *   { auto_mark_as_rfc, country_filter[], delivery_method[], initial_order_state,
 *     initial_order_states[], is_manual_international_order_confirmed, location,
 *     site_url, states[], sync_products, tracking_link, wms_delay_minutes }
 *
 * Upsert semantics:
 *   The upstream endpoint CREATES the config row if no mapping exists yet for
 *   the given `site_url`, otherwise PARTIAL-UPDATES the existing row. Only
 *   the keys supplied are forwarded upstream (skip-undefined pattern).
 *
 * Source-of-truth lookups for legal mapping values:
 *   - `states[].quiqup_state` MUST be one of the strings returned by
 *     `list_woocommerce_states` (the canonical Quiqup-side enum).
 *   - `states[].woocommerce_state` is free-form (whatever statuses the
 *     storefront actually uses).
 *   - `delivery_method[].woocommerce` shape comes from
 *     `list_woocommerce_shipping_lines` — pass through whatever that tool
 *     returned for the corresponding method.
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform`).
 *   - 404       → site_url does not match an existing connection — verify
 *                 against `list_woocommerce_connections`.
 *   - 422       → upstream validation failure (inspect attribute_errors[]).
 *   - 5xx       → upstream temporarily unavailable; retry.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl, iso3166Alpha2 } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({
  site_url: z
    .string()
    .url()
    .describe(
      "Full WooCommerce site URL — matches `list_woocommerce_connections[].site_url`.",
    ),
  delivery_method: z
    .array(
      z.object({
        quiqup_name: z.string(),
        shipping_profile_id: z.string(),
        woocommerce: z
          .record(z.string(), z.unknown())
          .describe(
            "WooCommerceDeliveryMethodConfig blob — pass through whatever " +
              "`list_woocommerce_shipping_lines` returned for the corresponding " +
              "method.",
          ),
      }),
    )
    .optional()
    .describe(
      "Mapping from Quiqup delivery method (quiqup_name + shipping_profile_id) " +
        "to a WooCommerce shipping-method blob. Discover legal `woocommerce` " +
        "shapes via `list_woocommerce_shipping_lines`.",
    ),
  states: z
    .array(
      z.object({
        quiqup_state: z
          .string()
          .describe(
            "MUST be one of the values returned by `list_woocommerce_states`.",
          ),
        woocommerce_state: z
          .string()
          .describe(
            "Free-form WooCommerce-side status — whatever the storefront uses.",
          ),
      }),
    )
    .optional()
    .describe(
      "Mapping from canonical Quiqup order state to a WooCommerce-side status. " +
        "`quiqup_state` values come from `list_woocommerce_states`; " +
        "`woocommerce_state` is free-form.",
    ),
  // 02-REVIEW WR-01: enforce ISO-3166 alpha-2 via regex (was length(2) which
  // admitted "12", "  ", lowercase, etc.).
  country_filter: z
    .array(iso3166Alpha2)
    .optional()
    .describe(
      "ISO-3166 alpha-2 country codes; orders from countries not in this list " +
        "are filtered out. Each entry MUST be two uppercase ASCII letters " +
        "(e.g. AE, SA).",
    ),
  initial_order_state: z.string().optional(),
  initial_order_states: z.array(z.string()).optional(),
  location: z.string().optional(),
  auto_mark_as_rfc: z.boolean().optional(),
  is_manual_international_order_confirmed: z.boolean().optional(),
  sync_products: z.boolean().optional(),
  tracking_link: z.string().optional(),
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
  name: "upsert_woocommerce_config",
  description:
    "Upsert the mapping / config for a WooCommerce site via " +
    "PUT /woocommerce/settings/config/upsert on platform-api.quiqup.com. " +
    "Response shape: `{ message }`. " +
    "Upsert semantics: CREATES the config row if no mapping exists yet for " +
    "the given `site_url`, otherwise PARTIAL-UPDATES the existing row — only " +
    "the keys supplied are forwarded upstream. " +
    "Source-of-truth lookups for legal mapping values: " +
    "`states[].quiqup_state` MUST be one of the strings returned by " +
    "`list_woocommerce_states` (canonical Quiqup-side enum); " +
    "`states[].woocommerce_state` is free-form (whatever the storefront " +
    "uses). `delivery_method[].woocommerce` shape comes from " +
    "`list_woocommerce_shipping_lines` — pass through whatever that tool " +
    "returned for the corresponding method. " +
    "`country_filter[]` is ISO-3166 alpha-2 (exactly 2 chars per entry). " +
    "`wms_delay_minutes` is bounded to [0, 10080] (1 week). " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 404 → " +
    "site_url unknown (verify against `list_woocommerce_connections`); 422 → " +
    "upstream validation failure (inspect attribute_errors[]); 5xx → upstream " +
    "temporarily unavailable, retry. " +
    'Example: `{ "site_url": "https://acme.example.com", ' +
    '"country_filter": ["AE", "SA"], "wms_delay_minutes": 30, ' +
    '"states": [{ "quiqup_state": "delivered", "woocommerce_state": "completed" }] }`.',
  inputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 10, refillPerSec: 10 / 60 },
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error(
        "upsert_woocommerce_config requires an authenticated user",
      );
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);

    // Build body from only the fields the caller actually supplied —
    // idempotency_key + environment are tool-level and must NOT leak upstream.
    const body: Record<string, unknown> = { site_url: args.site_url };
    if (args.delivery_method !== undefined)
      body.delivery_method = args.delivery_method;
    if (args.states !== undefined) body.states = args.states;
    if (args.country_filter !== undefined)
      body.country_filter = args.country_filter;
    if (args.initial_order_state !== undefined)
      body.initial_order_state = args.initial_order_state;
    if (args.initial_order_states !== undefined)
      body.initial_order_states = args.initial_order_states;
    if (args.location !== undefined) body.location = args.location;
    if (args.auto_mark_as_rfc !== undefined)
      body.auto_mark_as_rfc = args.auto_mark_as_rfc;
    if (args.is_manual_international_order_confirmed !== undefined)
      body.is_manual_international_order_confirmed =
        args.is_manual_international_order_confirmed;
    if (args.sync_products !== undefined) body.sync_products = args.sync_products;
    if (args.tracking_link !== undefined) body.tracking_link = args.tracking_link;
    if (args.wms_delay_minutes !== undefined)
      body.wms_delay_minutes = args.wms_delay_minutes;

    const res = await fetch(
      `${platformApiBase}/woocommerce/settings/config/upsert`,
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

    const data = await res.json();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
};
