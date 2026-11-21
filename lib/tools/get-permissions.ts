/**
 * `get_permissions` — read the signed-in user's permission list from
 * platform-api.quiqup.com (Phase 1 / AUTH-04).
 *
 * Endpoint: GET https://platform-api.quiqup.com/permissions
 * Headers:  Authorization: Bearer <session-JWT>,
 *           Accept: application/json,
 *           x-api-version: 1   (REQUIRED — omitting it historically returned the
 *                               legacy shape; see threat T-01-07 in PLAN.md).
 *
 * The QuiqDash UI consumes these via `usePermissions` → `usePermissionsStore`,
 * and `<PermissionGuard>` gates routes off the resulting list. The MCP agent
 * should call this to know which capabilities the current session may exercise
 * (e.g. before attempting a write that may 403 downstream).
 *
 * Error modes:
 *   - 401 / 403 → auth issue. Run `whoami_platform` first.
 *   - 5xx       → upstream temporarily unavailable; retry.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({ environment: environmentField });
const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "get_permissions",
  description:
    "Read the signed-in user's permission list from platform-api.quiqup.com " +
    "(GET /permissions, x-api-version: 1). Returns a permissions list used by the " +
    "QuiqDash UI's <PermissionGuard> to gate routes — agents can use it to decide " +
    "whether a write tool will succeed before calling it. " +
    "Distinct from `get_account` (which returns the partner profile, not auth scopes) " +
    "and from `whoami_platform` (which returns identity via /me — different endpoint, " +
    "different payload). " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 5xx → upstream " +
    "temporarily unavailable, retry. " +
    'Example: `{ "environment": "production" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("get_permissions requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const res = await fetch(`${platformApiBase}/permissions`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/json",
        "x-api-version": "1",
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
