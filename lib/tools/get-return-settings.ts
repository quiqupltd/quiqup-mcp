/**
 * `get_return_settings` — read the partner's return-policy settings on
 * platform-api.quiqup.com (Phase 1 / AUTH-11).
 *
 * Endpoint: GET https://platform-api.quiqup.com/api/accounts/{accountID}/return-settings
 * Headers:  Authorization: Bearer <session-JWT>, Accept: application/json
 *
 * NOTE on path prefix:
 *   This endpoint uses /api/accounts/{accountID}/return-settings — NOT
 *   /accounts/{id}/... like AUTH-05 (`get_account_capabilities`). The
 *   source-doc (lines 134-141) is authoritative; mirror the prefix exactly.
 *
 * Twin write: `update_return_settings` (AUTH-12) PUTs the same resource.
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform`).
 *   - 404       → no return-settings record for that account id.
 *   - 5xx       → upstream temporarily unavailable; retry.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({
  account_id: z
    .string()
    .min(1)
    .default("me")
    .describe(
      'Account id; "me" resolves to the signed-in partner. Pass an explicit ' +
        "Salesforce id only in admin / impersonation contexts.",
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "get_return_settings",
  description:
    "Read the partner's return-policy settings (window, allowed reasons, " +
    "open settings blob) via GET /api/accounts/{account_id}/return-settings " +
    "on platform-api.quiqup.com. The default `account_id: \"me\"` resolves to " +
    "the signed-in partner. " +
    "Path prefix note: this endpoint lives under /api/accounts/... (NOT the " +
    "/accounts/... prefix used by `get_account_capabilities`). " +
    "Twin write: `update_return_settings` (AUTH-12) mutates the same resource. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 404 → no " +
    "return-settings record for that account id; 5xx → retry. " +
    'Example: `{ "account_id": "me" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("get_return_settings requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const accountId = args.account_id ?? "me";
    const url = `${platformApiBase}/api/accounts/${encodeURIComponent(accountId)}/return-settings`;

    const res = await fetch(url, {
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
