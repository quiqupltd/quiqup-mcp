/**
 * `get_quiqdash_init` — read the QuiqDash app-boot bundle from
 * platform-api.quiqup.com (Phase 1 / AUTH-09).
 *
 * Endpoint: GET https://platform-api.quiqup.com/quiqdash/init
 * The QuiqDash UI calls this via `useUserConfig` → `useUserConfigStore`; the
 * resulting object drives both downstream analytics and the UI feature toggles
 * across the dashboard.
 *
 * Bundle contents (per source-doc lines 123-128): roles, feature toggles,
 * currency. Agents should call this once per session and cache locally — the
 * payload is stable across a session and re-fetching it on every action wastes
 * upstream capacity (rate-limiting is upstream's concern per threat T-01-05 in
 * PLAN.md, but the polite default is "cache").
 *
 * Distinct from `get_account` (account profile, no UI config), from
 * `get_permissions` (permission list specifically, not feature toggles), and
 * from `whoami_platform` (/me identity probe).
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({ environment: environmentField });
const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "get_quiqdash_init",
  description:
    "Read the QuiqDash app-boot config bundle from platform-api.quiqup.com " +
    "(GET /quiqdash/init). Returns roles, feature toggles, and currency — the same " +
    "object that powers the QuiqDash dashboard's `useUserConfigStore` and gates UI " +
    "feature visibility. Agents are recommended to call this ONCE per session and " +
    "cache the result; the payload is stable across a session. " +
    "Distinct from `get_account` (account profile only, no UI config), from " +
    "`get_permissions` (permission scopes, not feature toggles), and from " +
    "`whoami_platform` (/me identity probe — different endpoint, different payload). " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 5xx → upstream " +
    "temporarily unavailable, retry. " +
    'Example: `{ "environment": "production" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("get_quiqdash_init requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const res = await fetch(`${platformApiBase}/quiqdash/init`, {
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
