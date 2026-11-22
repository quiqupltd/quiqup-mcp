/**
 * `update_shopify_connection` — update a Shopify connection's CREDENTIALS on
 * platform-api.quiqup.com (Phase 2 / INTG-11).
 *
 * Endpoint: PUT https://platform-api.quiqup.com/shopify/connection
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json, Content-Type: application/json
 *
 * Body shape (per source-doc lines 1517-1537):
 *   { shop_name, code, is_fulfillment, token, user_id, created_at?, updated_at? }
 *
 * Sensitive payload:
 *   The `token` field is the Shopify access token — treat as a SECRET. The
 *   audit middleware (lib/middleware/audit.ts) automatically redacts any key
 *   named `token` via ALWAYS_REDACT_KEYS before persisting the audit record,
 *   so the actual value never reaches the audit log. Do NOT echo the token
 *   into chat-visible output. The `code` field is the OAuth authorization
 *   code; this endpoint re-stores it on the connection record (vs.
 *   `setup_shopify_callback` which performs the initial OAuth-code exchange).
 *
 * Sibling write: `update_shopify_config` updates the MAPPING / config
 * (delivery methods, locations, fulfillment state, wms delay). Use THIS tool
 * for credential mutations only — the two endpoints are intentionally
 * separate upstream.
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform`).
 *   - 404       → shop_name does not match an existing connection.
 *   - 422       → upstream validation failure (inspect attribute_errors).
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
      "Shopify shop short name. MUST match an existing connection — verify " +
        "via `list_integration_connections`.",
    ),
  code: z
    .string()
    .min(1)
    .describe("OAuth authorization code re-supplied for connection updates."),
  is_fulfillment: z
    .boolean()
    .describe(
      "Whether this connection drives fulfillment for the partner.",
    ),
  token: z
    .string()
    .min(1)
    .describe(
      "Shopify access token. SENSITIVE — treat as a secret; do NOT log or " +
        "echo into chat-visible output. The audit middleware redacts the " +
        "`token` field via ALWAYS_REDACT_KEYS before persisting any record.",
    ),
  // NOTE: `user_id` is intentionally NOT a caller arg (02-REVIEW BL-04). The
  // handler binds it to `auth.userId` server-side from the JWT subject so an
  // LLM cannot smuggle a foreign user_id and rewrite another tenant's
  // connection. The upstream body still receives `user_id`; the LLM just
  // doesn't get to choose its value.
  created_at: z
    .string()
    .optional()
    .describe(
      "ISO-8601 date-time; if omitted, upstream preserves the existing value.",
    ),
  updated_at: z
    .string()
    .optional()
    .describe(
      "ISO-8601 date-time; if omitted, upstream preserves the existing value.",
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
  name: "update_shopify_connection",
  description:
    "Update a Shopify connection's CREDENTIALS via PUT /shopify/connection " +
    "on platform-api.quiqup.com. " +
    "Response shape: `{ message, resolved_inventory_item_id? }`. " +
    "The `token` field is the Shopify access token and is treated as a SENSITIVE " +
    "secret upstream — the audit middleware automatically redacts the `token` " +
    "key (and other ALWAYS_REDACT_KEYS entries) before persisting any audit " +
    "record; do NOT paste it into chat logs or echo it back to the user. " +
    "When to call this vs `update_shopify_config`: use this tool to mutate the " +
    "connection CREDENTIALS (code + token + is_fulfillment + " +
    "created_at/updated_at); use `update_shopify_config` for the MAPPING / " +
    "config (delivery methods, locations, fulfillment state, wms delay). " +
    "shop_name MUST match an existing connection (verify via " +
    "`list_integration_connections`). " +
    "Owner identity: the upstream `user_id` is BOUND server-side to the " +
    "authenticated JWT subject — there is no caller arg for it (02-REVIEW BL-04). " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 404 → shop_name " +
    "unknown; 422 → upstream validation failure (inspect attribute_errors); 5xx " +
    "→ upstream temporarily unavailable, retry. " +
    'Example: `{ "shop_name": "acme-store", "code": "oauth_code_xyz", ' +
    '"is_fulfillment": true, "token": "<REDACTED>" }`.',
  inputSchema,
  outputSchema,
  // Tight burst limit (5 / minute) — connection-credential mutations should
  // be rare; rapid-fire calls almost certainly indicate misuse. Idempotency
  // key dedupes legitimate retries. Audit on every call so token-swap
  // attempts are traceable (the token value itself is redacted).
  guardrails: {
    rateLimit: { capacity: 5, refillPerSec: 5 / 60 },
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error(
        "update_shopify_connection requires an authenticated user",
      );
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);

    // Build body from only the fields the caller actually supplied —
    // idempotency_key + environment are tool-level and must NOT leak upstream.
    // `user_id` is BOUND to auth.userId server-side (02-REVIEW BL-04): the
    // JWT subject is the canonical owner identity, so allowing an LLM to
    // re-supply it would be a cross-tenant write vector.
    const body: Record<string, unknown> = {
      shop_name: args.shop_name,
      code: args.code,
      is_fulfillment: args.is_fulfillment,
      token: args.token,
      user_id: auth.userId,
    };
    if (args.created_at !== undefined) body.created_at = args.created_at;
    if (args.updated_at !== undefined) body.updated_at = args.updated_at;

    const res = await fetch(`${platformApiBase}/shopify/connection`, {
      method: "PUT",
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
