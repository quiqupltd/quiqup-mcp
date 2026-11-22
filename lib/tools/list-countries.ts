/**
 * `list_countries` — canonical ISO2 ↔ country-name map (Phase 1 / ADDR-04).
 *
 * Endpoint: GET https://platform-api.quiqup.com/countries
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json
 *
 * Use this to resolve any user-typed country to the ISO-3166 alpha-2 code
 * that order/address endpoints expect. Pair with `list_country_states` and
 * `list_country_cities` for the full geo drill-down.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({ environment: environmentField });

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "list_countries",
  description:
    "Canonical ISO2 → country-name map. Use this to resolve any user-typed " +
    "country to the ISO2 code that order/address endpoints expect. " +
    "Endpoint: GET platform-api.quiqup.com/countries. " +
    "Pair with `list_country_states` and `list_country_cities` for the full " +
    "geo drill-down. " +
    "Error modes: 401/403 = auth issue (run `whoami_platform`); 5xx = " +
    "upstream-unavailable — retry in a few seconds. " +
    'Example: `{ "environment": "production" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("list_countries requires an authenticated user");
    }
    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const res = await fetch(`${platformApiBase}/countries`, {
      method: "GET",
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/json" },
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
