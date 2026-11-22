/**
 * `get_account_capabilities` — read account capability flags from
 * platform-api.quiqup.com (Phase 1 / AUTH-05).
 *
 * Endpoint: GET https://platform-api.quiqup.com/accounts/{id}/capabilities
 * The QuiqDash UI calls this with id="me" on app boot (`useGetAccountCapabilitiesOnLoad`)
 * and with a Salesforce id in the admin-tools mutation form (`useGetAccountCapabilities`).
 *
 * Representative capability flags (per source-doc lines 102-106):
 *   - fulfillment_enabled — partner has the WMS / Fulfilment add-on.
 *   - wms_setup_complete  — onboarding finished; gates Inventory tools.
 *
 * The `id` arg is path-interpolated and `encodeURIComponent`-escaped (mitigates
 * threat T-01-02 in PLAN.md — Salesforce ids contain no reserved chars, but the
 * encoding makes injection impossible by construction).
 *
 * See also: `get_account` (current partner profile), `whoami_platform` (/me),
 * `get_account_by_id` (full account by SFID — capabilities is a strict subset).
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
    .default("me")
    .describe(
      'Account id — "me" resolves to the signed-in partner, or pass a Salesforce id.',
    ),
  environment: environmentField,
});
const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "get_account_capabilities",
  description:
    "Read account capability flags from platform-api.quiqup.com " +
    '(GET /accounts/{id}/capabilities). Pass `id="me"` (default) for the signed-in ' +
    "partner, or a Salesforce id in admin/impersonation contexts. Returns flags such " +
    "as `fulfillment_enabled` and `wms_setup_complete` that drive QuiqDash feature " +
    "gates — agents can use them to decide whether Inventory / Fulfilment tools will " +
    "be productive before calling them. " +
    "Distinct from `get_account` (full profile, not just capability bits), from " +
    "`get_account_by_id` (the full account record by SFID — capabilities is a strict " +
    "subset), and from `whoami_platform` (/me — different endpoint). " +
    "Error modes: 401/403 → auth or scope issue (run `whoami_platform`); 5xx → " +
    "upstream temporarily unavailable, retry. " +
    'Example: `{ "id": "me", "environment": "production" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("get_account_capabilities requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const id = args.id ?? "me";
    const res = await fetch(
      `${platformApiBase}/accounts/${encodeURIComponent(id)}/capabilities`,
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
