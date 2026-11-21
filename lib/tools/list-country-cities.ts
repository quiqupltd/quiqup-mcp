/**
 * `list_country_cities` — list the cities within a country (Phase 1 / ADDR-06).
 *
 * Endpoint: GET https://platform-api.quiqup.com/countries/{countryNameOrIso2}/cities
 * Headers:  Authorization: Bearer <session-JWT>, Accept: application/json
 *
 * Note the upstream's dual-form path param: it accepts EITHER the ISO2 code
 * (e.g. "AE") OR the full country name (e.g. "United Arab Emirates"). The
 * tool encodes whichever the caller supplies.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({
  country_name_or_iso2: z
    .string()
    .min(2)
    .describe(
      'Either the ISO2 code (e.g. "AE") or the full country name (e.g. "United Arab Emirates")',
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "list_country_cities",
  description:
    "List the cities within a country. The path param is dual-form: pass " +
    'either the ISO2 code (e.g. "AE") OR the full country name (e.g. ' +
    '"United Arab Emirates") — upstream accepts both. ' +
    "Endpoint: GET platform-api.quiqup.com/countries/{countryNameOrIso2}/cities. " +
    "Prefer ISO2 when you have it (`list_countries` to resolve). " +
    "Error modes: 401/403 = auth issue (run `whoami_platform`); 404 = " +
    "unknown country (verify with `list_countries`); 5xx = " +
    "upstream-unavailable — retry in a few seconds. " +
    'Example: `{ "country_name_or_iso2": "AE" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("list_country_cities requires an authenticated user");
    }
    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const res = await fetch(
      `${platformApiBase}/countries/${encodeURIComponent(args.country_name_or_iso2)}/cities`,
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
