/**
 * `setup_woocommerce_connection` — create a new WooCommerce connection on
 * platform-api.quiqup.com (Phase 2 / INTG-17).
 *
 * Endpoint: POST https://platform-api.quiqup.com/woocommerce/connection
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json, Content-Type: application/json
 *
 * Body shape (per source-doc lines 1641-1657, authoritative):
 *   { is_fulfillment, shop_name, site_url, token }
 *
 * WooCommerce vs Shopify connection-setup semantics:
 *   Unlike Shopify (`setup_shopify_callback`), WooCommerce does NOT do an OAuth
 *   redirect dance. Instead, the merchant generates a REST API consumer key /
 *   secret directly inside their WooCommerce admin (WooCommerce → Settings →
 *   Advanced → REST API) and pastes the resulting `token` here. There is no
 *   single-use code, no callback step.
 *
 * Sensitive payload:
 *   The `token` field is the WooCommerce REST consumer secret — treat as a
 *   SECRET. The audit middleware (lib/middleware/audit.ts) automatically
 *   redacts any key named `token` via ALWAYS_REDACT_KEYS before persisting
 *   the audit record, so the actual value never reaches the audit log. Do
 *   NOT echo the token into chat-visible output.
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform`).
 *   - 422       → upstream validation failure (inspect attribute_errors[]) —
 *                 commonly a malformed site_url or a token that does not
 *                 authenticate against the WooCommerce REST API.
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
      "WooCommerce shop short name (a partner-chosen label that becomes the " +
        "`shop_name` returned by `list_woocommerce_connections`).",
    ),
  site_url: z
    .string()
    .url()
    .describe(
      "Full WooCommerce site URL, e.g. https://acme.example.com.",
    ),
  token: z
    .string()
    .min(1)
    .describe(
      "WooCommerce REST API consumer secret. SENSITIVE — do NOT log; the audit " +
        "middleware redacts the `token` key via ALWAYS_REDACT_KEYS before " +
        "persisting any audit record. The merchant generates this inside " +
        "WooCommerce → Settings → Advanced → REST API.",
    ),
  is_fulfillment: z
    .boolean()
    .describe(
      "Whether this connection drives fulfillment for the partner.",
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
  name: "setup_woocommerce_connection",
  description:
    "Create a new WooCommerce connection via POST /woocommerce/connection " +
    "on platform-api.quiqup.com. " +
    "Body shape: `{ shop_name, site_url, token, is_fulfillment }`. " +
    "Response shape: `{ message }`. " +
    "Unlike `setup_shopify_callback`, WooCommerce does NOT do an OAuth " +
    "redirect dance — the merchant generates a REST API consumer key/secret " +
    "directly inside their WooCommerce admin (WooCommerce → Settings → " +
    "Advanced → REST API) and pastes the resulting consumer secret here as " +
    "`token`. There is no single-use code and no callback step. " +
    "The `token` field is the WooCommerce REST consumer secret and is " +
    "treated as a SENSITIVE secret upstream — the audit middleware " +
    "automatically redacts the `token` key via ALWAYS_REDACT_KEYS before " +
    "persisting any audit record; do NOT paste it into chat logs or echo it " +
    "back to the user. " +
    "Pair with `upsert_woocommerce_config` after the connection lands to " +
    "configure the mapping (states, delivery methods, country filter). " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 422 → " +
    "upstream validation failure (inspect attribute_errors[]) — commonly a " +
    "malformed site_url or a token that does not authenticate against the " +
    "WooCommerce REST API; 5xx → upstream temporarily unavailable, retry. " +
    'Example: `{ "shop_name": "acme", "site_url": "https://acme.example.com", ' +
    '"token": "<REDACTED>", "is_fulfillment": true }`.',
  inputSchema,
  outputSchema,
  // Tight burst limit (5 / minute) — connection setup should be rare; rapid
  // calls almost certainly indicate misuse. Idempotency key dedupes retries.
  // Audit on every call so token-supply attempts are traceable (the token
  // value itself is redacted).
  guardrails: {
    rateLimit: { capacity: 5, refillPerSec: 5 / 60 },
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error(
        "setup_woocommerce_connection requires an authenticated user",
      );
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);

    // Body is exactly the 4 documented fields — idempotency_key + environment
    // are tool-level and must NOT leak upstream.
    const body = {
      shop_name: args.shop_name,
      site_url: args.site_url,
      token: args.token,
      is_fulfillment: args.is_fulfillment,
    };

    const res = await fetch(`${platformApiBase}/woocommerce/connection`, {
      method: "POST",
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
