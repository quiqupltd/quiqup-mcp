/**
 * `list_state_cities` — list the cities within a state of a country
 * (Phase 1 / ADDR-07).
 *
 * Endpoint: GET https://platform-api.quiqup.com/countries/{countryIso2}/states/{stateNameOrCode}/cities
 * Headers:  Authorization: Bearer <session-JWT>, Accept: application/json
 *
 * BOTH path params are encoded — `state_name_or_code` is upstream's
 * free-form selector so it may contain spaces (e.g. "Abu Dhabi").
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
  state_name_or_code: z
    .string()
    .min(1)
    .describe('State name or code (upstream accepts both, e.g. "Dubai")'),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "list_state_cities",
  description:
    "List the cities within a state of a country. " +
    "Endpoint: GET platform-api.quiqup.com/countries/{countryIso2}/states/{stateNameOrCode}/cities. " +
    "Both path params are URL-encoded by the tool; `state_name_or_code` may " +
    'contain spaces (e.g. "Abu Dhabi"). Use after `list_country_states` to ' +
    "drill down to the city level. " +
    "Error modes: 401/403 = auth issue (run `whoami_platform`); 404 = " +
    "unknown country or state (verify with `list_countries` / " +
    "`list_country_states`); 5xx = upstream-unavailable — retry in a few seconds. " +
    'Example: `{ "country_iso2": "AE", "state_name_or_code": "Dubai" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("list_state_cities requires an authenticated user");
    }
    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const res = await fetch(
      `${platformApiBase}/countries/${encodeURIComponent(args.country_iso2)}/states/${encodeURIComponent(args.state_name_or_code)}/cities`,
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
