/**
 * `list_service_kinds` — fetch the canonical Quiqup service-kind enum from
 * platform-api.quiqup.com (Phase 1 / AUTH-08).
 *
 * Endpoint: GET https://platform-api.quiqup.com/quiqup/service-kinds
 * The QuiqDash UI calls this via `useGetServiceKinds` and reuses the result
 * across selectors / order-creation forms.
 *
 * The list is the SOURCE OF TRUTH for `service_kind` values on order creation
 * and reason-code lookups — agents must read from this endpoint rather than
 * inventing values, otherwise downstream order creation will 422.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({ environment: environmentField });
const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "list_service_kinds",
  description:
    "Returns the canonical list of Quiqup service kinds (express, standard, " +
    "returns, partner_export, partner_next_day, …) used as enum values by order " +
    "creation + reason-code lookups. Cache the result per session; the list is " +
    "stable across calls. The `service_kind` field on order creation MUST come " +
    "from this lookup — do not invent values. " +
    "Endpoint: GET /quiqup/service-kinds on platform-api.quiqup.com. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 5xx → upstream " +
    "temporarily unavailable, retry. " +
    'Example: `{ "environment": "production" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("list_service_kinds requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const res = await fetch(`${platformApiBase}/quiqup/service-kinds`, {
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
