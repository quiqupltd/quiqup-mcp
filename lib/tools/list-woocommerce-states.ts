/**
 * `list_woocommerce_states` — fetch the canonical QUIQUP order-state taxonomy
 * used by the WooCommerce mapping (Phase 2 / INTG-15).
 *
 * Endpoint: GET https://platform-api.quiqup.com/woocommerce/states
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json
 *
 * Response shape (per source-doc lines 1608-1615):
 *   { states: string[] }
 *
 * Quiqup-vs-WooCommerce state disambiguation:
 *   The `states[]` strings returned here are the CANONICAL QUIQUP order-state
 *   enum values used inside the WooCommerce mapping — NOT WooCommerce's own
 *   native order statuses. They are the legal values for
 *   `upsert_woocommerce_config.states[].quiqup_state`. The WooCommerce-side
 *   values come from the storefront and live in `states[].woocommerce_state`
 *   — that side is free-form (whatever statuses the store has configured).
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
  name: "list_woocommerce_states",
  description:
    "Returns the canonical QUIQUP order-state taxonomy used by the " +
    "WooCommerce mapping (NOT WooCommerce's own native order statuses). " +
    "The `states[]` values returned here are the legal values for " +
    "`upsert_woocommerce_config.states[].quiqup_state`. The WooCommerce-side " +
    "values come from the storefront and live in `states[].woocommerce_state` " +
    "— that side is free-form (whatever statuses the store has configured). " +
    "Endpoint: GET /woocommerce/states on platform-api.quiqup.com. " +
    "Response shape: `{ states: string[] }`. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 5xx → " +
    "upstream temporarily unavailable, retry. " +
    'Example: `{ "environment": "production" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("list_woocommerce_states requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const res = await fetch(`${platformApiBase}/woocommerce/states`, {
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
