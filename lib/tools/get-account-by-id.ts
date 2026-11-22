/**
 * `get_account_by_id` — resolve an account by Salesforce id from
 * platform-api.quiqup.com (Phase 1 / AUTH-06).
 *
 * Endpoint: GET https://platform-api.quiqup.com/accounts/{id}
 * The QuiqDash UI calls this via `useGetAccountBySFID` from admin tools.
 *
 * Authorization is enforced upstream — Platform API is the source of truth on
 * whether the caller may read another partner's account (T-01-03 in PLAN.md
 * is `accept` with rationale: upstream 403s when the caller lacks scope).
 *
 * The `id` arg is path-interpolated and `encodeURIComponent`-escaped (mitigates
 * threat T-01-02).
 *
 * Resolves an account by Salesforce id; used in admin / impersonation contexts.
 * For the signed-in account use `get_account` instead.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({
  id: z.string().min(1).describe("Salesforce account id."),
  environment: environmentField,
});
const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "get_account_by_id",
  description:
    "Resolve an account by Salesforce id; used in admin / impersonation contexts. " +
    "For the signed-in account use `get_account`. " +
    "Endpoint: GET /accounts/{id} on platform-api.quiqup.com. Upstream enforces " +
    "scope/role — non-admin callers will receive a 403 if they lack permission to " +
    "read the requested account. " +
    "Distinct from `get_account` (signed-in partner, no id), from " +
    "`get_account_capabilities` (capability-flag subset), and from `whoami_platform` " +
    "(/me — different endpoint, different payload). " +
    "Error modes: 401/403 → auth or scope issue (run `whoami_platform`); 404 → no " +
    "such account; 5xx → upstream temporarily unavailable, retry. " +
    'Example: `{ "id": "0035g000xyz", "environment": "production" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("get_account_by_id requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const res = await fetch(
      `${platformApiBase}/accounts/${encodeURIComponent(args.id)}`,
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
