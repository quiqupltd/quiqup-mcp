/**
 * `setup_shopify_callback` — complete the Shopify OAuth dance for a new
 * Shopify connection (Phase 2 / INTG-12).
 *
 * Endpoint: POST https://platform-api.quiqup.com/shopify/callback?shop_name=&code=&is_fulfillment=
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json
 *
 * Per source-doc lines 1539-1551 this endpoint takes 3 REQUIRED query params
 * (shop_name, code, is_fulfillment) and has NO request body.
 *
 * Response shape:
 *   { success_url: string }
 *
 * SINGLE-USE OAuth code semantics:
 *   `code` is the OAuth authorization code Shopify sent to the redirect URI.
 *   Shopify rejects re-use and the upstream returns 422 on a replayed code.
 *   The guardrails.idempotency configuration dedupes legitimate retries within
 *   15 minutes — but a NEW user-supplied `code` cannot bypass Shopify's
 *   one-shot rule. If you do not have a fresh code, send the partner through
 *   Shopify's app-install flow first to obtain one.
 *
 * Sibling write: `update_shopify_connection` updates credentials on an
 * existing connection. Use THIS tool only for the initial OAuth completion.
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform`).
 *   - 422       → typically a replayed OAuth code, or invalid shop_name/code
 *                 combo — inspect the body's attribute_errors[].
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
    .describe("Shopify shop short name."),
  code: z
    .string()
    .min(1)
    .describe(
      "OAuth authorization code from Shopify's redirect. SINGLE-USE — " +
        "Shopify rejects re-use, and the upstream returns 422 on a replayed " +
        "code. If you do not have a fresh code, send the partner through " +
        "Shopify's app-install flow first to obtain one.",
    ),
  is_fulfillment: z
    .boolean()
    .describe(
      "Whether this connection should drive fulfillment for the partner. " +
        "Cannot be changed after callback completes — use " +
        "`update_shopify_connection` to flip later.",
    ),
  idempotency_key: z
    .string()
    .optional()
    .describe(
      "Optional caller-supplied key to dedupe retries within a 15-minute " +
        "window. Note: this dedupes a re-call of THIS tool only; it cannot " +
        "rescue a single-use OAuth code that Shopify has already consumed.",
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "setup_shopify_callback",
  description:
    "Complete the Shopify OAuth dance for a new Shopify connection via " +
    "POST /shopify/callback on platform-api.quiqup.com. " +
    "Required QUERY params: shop_name, code, is_fulfillment. NO request body. " +
    "Response shape: `{ success_url }` — where the UI redirects the partner " +
    "after the connection lands. " +
    "This is the OAuth completion handoff. `code` MUST be the SINGLE-USE " +
    "authorization code that Shopify just sent to your redirect URI; Shopify " +
    "rejects re-use, and the upstream returns 422 on a replayed code. If you " +
    "do not have a fresh single-use code, send the partner through Shopify's " +
    "app-install flow first to obtain one. " +
    "Sibling write: `update_shopify_connection` updates credentials on an " +
    "existing connection — use THIS tool only for the initial OAuth completion. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 422 → typically " +
    "a replayed (already-used) single-use OAuth code, or invalid shop_name/code " +
    "combo (inspect attribute_errors[]); 5xx → upstream temporarily unavailable, " +
    "retry. " +
    'Example: `{ "shop_name": "acme-store", "code": "oauth_code_xyz", "is_fulfillment": true }`.',
  inputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 5, refillPerSec: 5 / 60 },
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("setup_shopify_callback requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);

    // Build query params deterministically. Cast is_fulfillment to "true" /
    // "false" — Rails-side query parsing is happy with the string form and
    // it keeps the URL stable for the idempotency key.
    const url = new URL(`${platformApiBase}/shopify/callback`);
    url.searchParams.set("shop_name", args.shop_name);
    url.searchParams.set("code", args.code);
    url.searchParams.set("is_fulfillment", String(args.is_fulfillment));

    const res = await fetch(url.toString(), {
      method: "POST",
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
