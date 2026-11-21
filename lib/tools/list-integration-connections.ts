/**
 * `list_integration_connections` — read the partner's cross-family
 * integration-connection catalog from platform-api.quiqup.com
 * (Phase 2 / INTG-01).
 *
 * Endpoint: GET https://platform-api.quiqup.com/integrations/connections
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json
 *
 * Why this tool exists in Phase 2 / Wave 1 (substrate):
 *   This is the single cross-family integrations catalog. Every family-specific
 *   tool (get_shopify_config, list_woocommerce_connections, get_salla_connection,
 *   etc.) takes a connection id or shop_name — they all assume the caller has
 *   already discovered which connections exist on the account. Calling this
 *   first is cheaper than guessing and saves an LLM round-trip on "I don't know
 *   which Shopify store you mean" cases.
 *
 * Response shape (per source-doc lines 1080-1099, authoritative):
 *   { connections: Array<{
 *       id: string,
 *       shop_name: string,
 *       site_url: string,
 *       source: 'shopify' | 'woocommerce' | 'salla' | …,
 *       is_fulfillment: boolean,
 *       token: string,
 *       user_id: string,
 *       created_at: string /* date-time *\/,
 *       updated_at: string /* date-time *\/,
 *   }> }
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform` to confirm the JWT resolves).
 *   - 5xx       → upstream temporarily unavailable; retry after a few seconds.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({ environment: environmentField });

// Passthrough — the response envelope is { connections: [...] } per source-doc;
// keep the contract loose while letting tests still .safeParse for sanity.
const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "list_integration_connections",
  description:
    "List every integration connection (Shopify, WooCommerce, Salla, …) " +
    "configured on the signed-in partner's account via " +
    "GET /integrations/connections on platform-api.quiqup.com. " +
    "Response shape: `{ connections: [{ id, shop_name, site_url, source " +
    "('shopify' | 'woocommerce' | 'salla' | …), is_fulfillment, token, " +
    "user_id, created_at, updated_at }] }` (per the upstream OpenAPI). " +
    "This is the single cross-family integrations catalog — use it BEFORE " +
    "calling any family-specific tool (`get_shopify_config`, " +
    "`list_woocommerce_connections`, `get_salla_connection`) to discover " +
    "which connection ids actually exist for this account. " +
    "Pair with `list_integration_order_reasons` to triage failed orders per " +
    "connection, and with `repair_integration_orders` to retry them. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform` to confirm " +
    "the JWT resolves); 5xx → upstream temporarily unavailable, retry in a " +
    "few seconds. " +
    'Example: `{ "environment": "production" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error(
        "list_integration_connections requires an authenticated user",
      );
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const res = await fetch(`${platformApiBase}/integrations/connections`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      throw new QuiqupHttpError(res.status, await res.text());
    }

    // Drop the upstream per-connection `token` field defensively before it
    // ever reaches the LLM. The cross-family catalog mixes Shopify, WooCommerce
    // and Salla bearer tokens; matching the T-02-29 invariant the Salla family
    // already enforces in `get-salla-connection.ts` (02-REVIEW BL-01).
    const body = (await res.json()) as {
      connections?: Array<Record<string, unknown> & { token?: unknown }>;
    };
    const connectionsSafe = (body.connections ?? []).map(
      ({ token: _token, ...rest }) => rest,
    );

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
