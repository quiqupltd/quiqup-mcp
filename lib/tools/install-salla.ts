/**
 * `install_salla` — fetch the Salla OAuth install URL from
 * platform-api.quiqup.com (Phase 2 / INTG-20).
 *
 * Endpoint: GET https://platform-api.quiqup.com/integrations/install/salla
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json
 *
 * Response shape (per source-doc lines 4337-4338, authoritative):
 *   { url: string } — Salla OAuth URL.
 *
 * Companion-tool path:
 *   - The merchant must be redirected to the returned `url` to grant the Quiqup
 *     connector access to their Salla store. After they complete the OAuth flow
 *     Salla calls back into the Quiqup platform (NOT this MCP server), which
 *     then creates the connection. Poll `list_integration_connections` to
 *     confirm the connection landed; then call `get_salla_connection` with the
 *     new id to read its details.
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

const inputSchema = z.object({
  environment: environmentField,
});

// Response is the simple `{ url }` shape — tightened vs the generic passthrough.
const outputSchema = z.object({ url: z.string().url() });

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "install_salla",
  description:
    "Returns the Salla OAuth install URL via GET /integrations/install/salla " +
    "on platform-api.quiqup.com. Response shape: `{ url: string }`. " +
    "The merchant must be redirected to this URL to grant the Quiqup connector " +
    "access to their Salla store. After they complete the OAuth flow Salla " +
    "calls back into the Quiqup platform (NOT this MCP server), which then " +
    "creates the connection. " +
    "Companion-tool path: poll `list_integration_connections` to confirm the " +
    "connection landed (filter source==='salla'); then call " +
    "`get_salla_connection` with the new id to read its details. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 5xx → upstream " +
    "temporarily unavailable, retry. " +
    'Example: `{ "environment": "production" }`.',
  inputSchema,
  outputSchema,
  // 02-REVIEW WR-03: this tool initiates an OAuth handshake — pattern-match
  // it to a write rather than a pure read. `audit: true` captures every
  // install attempt; a modest 10/min rate-limit bounds runaway agents that
  // would otherwise consume Salla-side `state` tokens at 10/sec. No
  // idempotency key — the upstream returns the same flow URL for repeated
  // calls within a session.
  guardrails: {
    rateLimit: { capacity: 10, refillPerSec: 10 / 60 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("install_salla requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const res = await fetch(
      `${platformApiBase}/integrations/install/salla`,
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

    const data = await res.json();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
};
