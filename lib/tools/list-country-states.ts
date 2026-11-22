/**
 * `list_country_states` — list the states/regions within a country
 * (Phase 1 / ADDR-05).
 *
 * Endpoint: GET https://platform-api.quiqup.com/countries/{countryIso2}/states
 * Headers:  Authorization: Bearer <session-JWT>, Accept: application/json
 *
 * Use this after `list_countries` to drill down. Pair with
 * `list_state_cities` for the next level.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({
  country_iso2: z
    .string()
    .length(2)
    .describe('ISO-3166 alpha-2 country code, e.g. "AE"'),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "list_country_states",
  description:
    "List the states/regions within a country. " +
    "Endpoint: GET platform-api.quiqup.com/countries/{countryIso2}/states. " +
    "Use this after `list_countries` to drill down; pair with " +
    "`list_state_cities` for the next level. " +
    "Error modes: 401/403 = auth issue (run `whoami_platform`); 404 = " +
    "unknown country ISO2 (verify with `list_countries`); 5xx = " +
    "upstream-unavailable — retry in a few seconds. " +
    'Example: `{ "country_iso2": "AE" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("list_country_states requires an authenticated user");
    }
    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const res = await fetch(
      `${platformApiBase}/countries/${encodeURIComponent(args.country_iso2)}/states`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${jwt}`, Accept: "application/json" },
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
