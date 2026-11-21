/**
 * `list_depots` — enumerate depots (filtered by region + main/satellite flag)
 * for the Bulk Mission dialog's depot dropdown (Phase 3 / ORDL-05).
 *
 * Endpoint: GET https://platform-api.quiqup.com/quiqdash/depots
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json
 *
 * Query params (both REQUIRED):
 *   - region:    Quiqup region code (e.g. "UAE", "KSA").
 *   - mainDepot: boolean — `true` returns main depots; `false` returns
 *                satellite/micro depots. NOTE the wire-format is camelCase
 *                `mainDepot` (NOT `main_depot`). On the MCP side we accept the
 *                snake_case `main_depot` to match the rest of the surface and
 *                translate to the wire-format key.
 *
 * Booleans are serialized as the literal strings "true"/"false" via
 * `String(args.main_depot)` — Quiqup BE parses these into Go bools.
 *
 * Built via URLSearchParams (T-03-18 hygiene) — never string concatenation.
 *
 * Pair with `list_missions_filter` to pre-populate the mission picker for the
 * same region.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { environmentField } from "@/lib/clients/quiqup-env";
import { PlatformApiClient } from "@/lib/clients/platform-api";

const inputSchema = z.object({
  region: z
    .string()
    .min(1)
    .describe(
      'Region filter — the Quiqup region code (e.g. "UAE", "KSA"). Required by upstream; the Quiqdash UI keeps this dropdown disabled until a region is selected. Source: app/hooks/order/use-order-management.ts:12.',
    ),
  main_depot: z
    .boolean()
    .describe(
      "If true, returns only main depots; if false, returns satellite/micro depots. Maps to the upstream `mainDepot` query param (note the camelCase on the wire).",
    ),
  environment: environmentField,
});

const outputSchema = z
  .object({ depots: z.array(z.object({}).passthrough()) })
  .passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "list_depots",
  description:
    "GET /quiqdash/depots (Platform API, proxies to ex-core internally). " +
    "Enumerates depots filtered by region + main/satellite flag — populates the " +
    "Bulk Mission dialog's depot dropdown. " +
    "Response shape: `{ depots: [{ id, name, address1, address2, apartmentNumber, " +
    "contactName, coordinates, coords[], country, emirate, mainDepot, micro, phone, " +
    "region }] }`. `coordinates` is the structured object; `coords[]` is a flat " +
    "[lng, lat] tuple for map-marker rendering. `micro` flags satellite-of-satellite " +
    "depots (rare). " +
    "When to use: populate the Bulk Mission dialog's depot dropdown. Pair with " +
    "`list_missions_filter` to pre-populate the mission picker for the same region. " +
    "Input note: the wire-format query key is `mainDepot` (camelCase); this tool " +
    "accepts `main_depot` (snake_case) and translates — match the MCP-side naming " +
    "convention. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 422 → likely an " +
    "unknown region code; 5xx → upstream temporarily unavailable, retry. " +
    'Example: `{ "region": "UAE", "main_depot": true, "environment": "production" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("list_depots requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    // 03-REVIEW WR-01: migrated from inline fetch boilerplate to the
    // PlatformApiClient helper (see lib/clients/platform-api.ts).
    //
    // NOTE the snake_case → camelCase wire translation. The MCP-side
    // schema uses `main_depot` (matching the rest of the surface); the
    // upstream wants `mainDepot`. Boolean → "true"/"false" string is
    // handled by the helper's `String(v)` coercion for Go's bool parser.
    const client = new PlatformApiClient({ jwt, environment: args.environment });
    const data = await client.request("GET", "/quiqdash/depots", {
      query: {
        region: args.region,
        mainDepot: args.main_depot,
      },
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
};
