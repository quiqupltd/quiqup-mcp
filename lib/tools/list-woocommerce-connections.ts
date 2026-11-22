/**
 * `list_woocommerce_connections` — list the partner's WooCommerce connections
 * on platform-api.quiqup.com (Phase 2 / INTG-13).
 *
 * Endpoint: GET https://platform-api.quiqup.com/woocommerce/connections
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json
 *
 * Response shape (per source-doc lines 1553-1573, authoritative):
 *   { connections: [{ shop_name, site_url, is_fulfillment, token,
 *     user_id, order_created_webhook_id, order_created_webhook_secret,
 *     order_updated_webhook_id, order_updated_webhook_secret, webhooks,
 *     created_at, updated_at }] }
 *
 * Companion-tool path:
 *   - This is the WooCommerce-only catalog. For a cross-family view (Shopify +
 *     WooCommerce + Salla in one list) use `list_integration_connections`.
 *   - Pair with `get_woocommerce_config` for the saved mapping/config per
 *     site, and with `list_woocommerce_shipping_lines` for live shipping
 *     methods.
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform`).
 *   - 5xx       → upstream temporarily unavailable; retry after a few seconds.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({ environment: environmentField });
const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "list_woocommerce_connections",
  description:
    "List the partner's WooCommerce connections via " +
    "GET /woocommerce/connections on platform-api.quiqup.com. " +
    "Response shape: `{ connections: [{ shop_name, site_url, is_fulfillment, " +
    "token, user_id, order_created_webhook_id, order_created_webhook_secret, " +
    "order_updated_webhook_id, order_updated_webhook_secret, webhooks, " +
    "created_at, updated_at }] }`. " +
    "This is the WooCommerce-only catalog. For a cross-family view " +
    "(Shopify + WooCommerce + Salla in one list) use " +
    "`list_integration_connections`. " +
    "Pair with `get_woocommerce_config` (saved mapping per site) and " +
    "`list_woocommerce_shipping_lines` (live shipping methods per site). " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 5xx → " +
    "upstream temporarily unavailable, retry. " +
    'Example: `{ "environment": "production" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error(
        "list_woocommerce_connections requires an authenticated user",
      );
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const res = await fetch(`${platformApiBase}/woocommerce/connections`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      throw new QuiqupHttpError(res.status, await res.text());
    }

    // Strip credentials defensively before the response reaches the LLM
    // (02-REVIEW BL-01, WR-06). The WooCommerce webhook secrets in particular
    // are higher-impact than `token`: a leaked signing secret lets an attacker
    // forge `order.created` / `order.updated` events into the platform.
    const SENSITIVE_KEYS = new Set([
      "token",
      "order_created_webhook_secret",
      "order_updated_webhook_secret",
    ]);
    const body = (await res.json()) as {
      connections?: Array<Record<string, unknown>>;
    };
    const connectionsSafe = (body.connections ?? []).map((c) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(c)) {
        if (!SENSITIVE_KEYS.has(k)) out[k] = v;
      }
      return out;
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ connections: connectionsSafe }, null, 2),
        },
      ],
    };
  },
};
