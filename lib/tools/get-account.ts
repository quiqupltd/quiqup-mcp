/**
 * `get_account` — read the signed-in partner's account profile from
 * platform-api.quiqup.com (Phase 1 / AUTH-03).
 *
 * Endpoint: GET https://platform-api.quiqup.com/account
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json
 *           (no `x-api-version` — /account does not require it, unlike /me + /permissions)
 *
 * When to use which (canonical disambiguation — locked in by the
 * tests/tools/auth-account-reads.test.ts assertions):
 *   - `get_account`        → read the signed-in partner's account profile (this tool).
 *   - `whoami_platform`    → auth-vs-payload triage against /me (different endpoint,
 *                            different payload — confirms the JWT resolves at all).
 *   - `get_account_by_id`  → resolve an account by Salesforce id (admin / impersonation
 *                            contexts).
 *
 * Twin write endpoint: AUTH-07 will PUT /accounts to update the same resource,
 * and FIN-05 (Phase 10) will add a constrained bank-details-only PUT variant.
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

// Account payloads are large and partner-shape dependent; passthrough keeps
// the contract loose while letting tests still .safeParse for sanity.
const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "get_account",
  description:
    "Read the signed-in partner's account profile from platform-api.quiqup.com " +
    "(GET /account). Returns the account id, name, settings, and service offering " +
    "(headline fields per the QuiqDash app-boot useAccount hook). " +
    "When to use which: use `get_account` to read the signed-in partner's account " +
    "profile; use `whoami_platform` only for auth-vs-payload triage against /me " +
    "(different endpoint, different payload); use `get_account_by_id` to resolve " +
    "an account by Salesforce id (admin / impersonation contexts). " +
    "Twin write: AUTH-07 PUTs the same resource, and the future FIN-05 (Phase 10) " +
    "will add a constrained bank-details-only PUT variant. " +
    "Error modes: 401/403 indicate an auth issue (run `whoami_platform` to confirm " +
    "the JWT resolves); 5xx is upstream-unavailable — retry in a few seconds. " +
    'Example: `{ "environment": "production" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("get_account requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const res = await fetch(`${platformApiBase}/account`, {
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
