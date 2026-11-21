/**
 * `toggle_salla_fulfillment` — flip the `is_fulfillment` flag on a Salla
 * connection on platform-api.quiqup.com (Phase 2 / INTG-23).
 *
 * Endpoint: PUT https://platform-api.quiqup.com/integrations/connections/{id}/fulfillment
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json, Content-Type: application/json
 *
 * Body shape (per source-doc lines 4361-4364, authoritative):
 *   { is_fulfillment: boolean }
 *
 * Response shape: empty (upstream returns no body). This MCP layer synthesizes
 * a structured echo `{ ok: true, is_fulfillment, id }` so the agent sees a
 * confirmation rather than an empty string.
 *
 * Companion read: `get_salla_connection` returns the post-state
 * (`is_fulfillment` field reflects the current value).
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform`).
 *   - 404       → connection id unknown — verify via `list_integration_connections`.
 *   - 422       → upstream validation failure (inspect body).
 *   - 5xx       → upstream temporarily unavailable; retry.
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
      "Salla connection id (same value used by `get_salla_connection`). " +
        "Source from `list_integration_connections[].id` where source==='salla'.",
    ),
  is_fulfillment: z
    .boolean()
    .describe(
      "true = Quiqup drives fulfillment for this Salla shop; false = Salla " +
        "retains fulfillment.",
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
  name: "toggle_salla_fulfillment",
  description:
    "Toggle the `is_fulfillment` flag on a Salla connection via PUT " +
    "/integrations/connections/{id}/fulfillment on platform-api.quiqup.com. " +
    "Body shape: `{ is_fulfillment: boolean }`. Upstream response is empty; " +
    "this tool synthesizes a structured echo `{ ok: true, is_fulfillment, id }` " +
    "so the agent has a positive confirmation. " +
    "Semantic: `true` = Quiqup drives fulfillment for this Salla shop (orders " +
    "flow into the Quiqup WMS); `false` = Salla retains fulfillment. " +
    "Companion read: pair with `get_salla_connection` to confirm the " +
    "post-state (`is_fulfillment` field reflects the current value). " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 404 → " +
    "connection id unknown (verify via `list_integration_connections`); 422 → " +
    "upstream validation failure (inspect body); 5xx → upstream temporarily " +
    "unavailable, retry. " +
    'Example: `{ "id": "conn_abc123", "is_fulfillment": true, "environment": "production" }`.',
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
        "toggle_salla_fulfillment requires an authenticated user",
      );
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const res = await fetch(
      `${platformApiBase}/integrations/connections/${encodeURIComponent(args.id)}/fulfillment`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ is_fulfillment: args.is_fulfillment }),
      },
    );

    if (!res.ok) {
      throw new QuiqupHttpError(res.status, await res.text());
    }

    // Upstream response is empty per source-doc — synthesize an echo so the
    // agent sees structured confirmation rather than an empty string.
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { ok: true, is_fulfillment: args.is_fulfillment, id: args.id },
            null,
            2,
          ),
        },
      ],
    };
  },
};
