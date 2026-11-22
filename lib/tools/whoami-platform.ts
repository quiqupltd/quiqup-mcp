/**
 * `whoami_platform` — resolves the identity on platform-api.quiqup.com for
 * the current MCP session.
 *
 * Different lens than `claims_dump`:
 *   - `claims_dump` decodes the *inbound* Clerk OAuth `at+jwt` (pre-exchange).
 *   - `whoami_platform` confirms the *exchanged* session-JWT still resolves
 *     against the actual order-handling API, and surfaces region_code +
 *     roles + admin flags that gate which validators/lanes apply downstream.
 *
 * Use this BEFORE diagnosing order, account, or entitlement issues — it
 * isolates "is auth working?" from "is the payload wrong?" at a cost of a
 * single GET. Added 2026-05-14 in response to the create_lastmile_order
 * HTTP 422 investigation, where confirming the bearer resolved on
 * platform-api ruled out hypothesis #1 (user→partner mapping).
 *
 * Endpoint: GET https://platform-api.quiqup.com/me
 * Required headers (per docs/quiqup-api/references/quiqdash-create-order.md):
 *   Authorization: Bearer <exchanged session-JWT>
 *   x-api-version: 1
 *   Accept: application/json
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({ environment: environmentField });

// Modeled from the response shape verified in the 2026-05-14 bug report.
// passthrough so new fields don't break us; required-required fields are
// kept optional because no field on this endpoint is strictly stable across
// account types (CSR/courier/partner all see different keys populated).
const outputSchema = z
  .object({
    id: z.string().optional(),
    email: z.string().optional(),
    salesforce_id: z.string().optional(),
    firstname: z.string().optional(),
    lastname: z.string().optional(),
    display_name: z.string().optional(),
    roles: z.array(z.string()).optional(),
    core_api_user_id: z.number().optional(),
    admin: z.boolean().optional(),
    courier: z.boolean().optional(),
    csr: z.boolean().optional(),
    region_code: z.string().optional(),
  })
  .passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "whoami_platform",
  description:
    "Resolve the current MCP session's identity on platform-api.quiqup.com " +
    "(GET /me). Returns core_api_user_id, email, salesforce_id, region_code " +
    '(e.g. "uae.dubai"), roles, and admin/courier/csr flags. ' +
    "Use BEFORE diagnosing any order, account, or entitlement issue: " +
    "confirms the exchanged session-JWT works against the platform API and " +
    "tells you which region/role context the request will execute under. " +
    "Pairs with `claims_dump` (which shows the *inbound* OAuth token, " +
    "before the same-IdP exchange). " +
    "Note: `whoami_platform` is the auth-triage tool against /me; use " +
    "`get_account` to read the partner's account profile (different " +
    "endpoint, different payload).",
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("whoami_platform requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const res = await fetch(`${platformApiBase}/me`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/json",
        "x-api-version": "1",
      },
    });

    if (!res.ok) {
      // Surface upstream errors via the same path other thin tools use —
      // the registerTool wrapper catches QuiqupHttpError and unwraps the
      // body into a structured tool-result with isError: true.
      throw new QuiqupHttpError(res.status, await res.text());
    }

    const data = await res.json();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
};
