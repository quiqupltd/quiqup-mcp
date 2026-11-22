/**
 * `get_salla_connection` — read a Salla connection by id from
 * platform-api.quiqup.com (Phase 2 / INTG-21).
 *
 * Endpoint: GET https://platform-api.quiqup.com/integrations/connections/{id}
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json
 *
 * Response shape (per source-doc lines 4341-4356, authoritative):
 *   { connection: { id, shop_name, site_url, source: "salla", user_id,
 *                   is_fulfillment, created_at, updated_at } }
 *
 * The BE response ALSO includes a `token` field (the Salla access token). This
 * MCP tool deliberately STRIPS that field BEFORE returning anything to the
 * caller — it is destructured into a discard binding and dropped. The output
 * schema is .strict(), so any future leakage of `token` (or a typo'd
 * passthrough) would fail tsc / Zod validation.
 *
 * Companion tools:
 *   - `list_integration_connections` — discover connection ids by source ===
 *     "salla". The `id` argument to THIS tool comes from
 *     `list_integration_connections[].id`.
 *   - `get_salla_config` / `update_salla_config` / `toggle_salla_fulfillment`
 *     — act on the Salla store as the merchant. These use the Clerk→Quiqup
 *     JWT bridge upstream rather than exposing the token; the LLM never sees
 *     or needs the Salla token directly.
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform`).
 *   - 404       → connection id unknown — verify via `list_integration_connections`.
 *   - 5xx       → upstream temporarily unavailable; retry after a few seconds.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe(
      "Salla connection id — get it from `list_integration_connections[].id` " +
        "where source==='salla'.",
    ),
  environment: environmentField,
});

// strict() — any future upstream field addition surfaces in tests rather than
// being silently passed through, which is the key invariant for the
// token-omission contract (T-02-29).
const outputSchema = z
  .object({
    id: z.string(),
    shop_name: z.string(),
    site_url: z.string(),
    source: z.literal("salla"),
    user_id: z.string(),
    is_fulfillment: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "get_salla_connection",
  description:
    "Read a Salla connection by id via GET /integrations/connections/{id} on " +
    "platform-api.quiqup.com. " +
    "Response shape (envelope unwrapped on this MCP layer): " +
    "`{ id, shop_name, site_url, source: 'salla', user_id, is_fulfillment, " +
    "created_at, updated_at }`. " +
    "The upstream payload also includes a Salla access `token` — this tool " +
    "STRIPS it before returning, so the LLM can never see or leak it. To act " +
    "on the Salla store as the merchant, use the higher-level " +
    "`get_salla_config` / `update_salla_config` / `toggle_salla_fulfillment` " +
    "tools, which use the JWT-bridge upstream rather than exposing the token. " +
    "Companion-tool path: source the `id` argument from " +
    "`list_integration_connections[].id` (filter source==='salla'). " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 404 → " +
    "connection id unknown (verify via `list_integration_connections`); 5xx " +
    "→ upstream temporarily unavailable, retry. " +
    'Example: `{ "id": "conn_abc123", "environment": "production" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("get_salla_connection requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const res = await fetch(
      `${platformApiBase}/integrations/connections/${encodeURIComponent(args.id)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/json",
        },
      },
    );

    if (!res.ok) {
      throw new QuiqupHttpError(res.status, await res.text());
    }

    // Unwrap the `{ connection }` envelope AND drop the upstream `token` field
    // defensively before it ever reaches the LLM (T-02-29).
    const body = (await res.json()) as {
      connection?: Record<string, unknown> & { token?: unknown };
    };
    const connection = body.connection ?? {};
    const { token: _token, ...connectionSafe } = connection;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(connectionSafe, null, 2),
        },
      ],
    };
  },
};
