/**
 * `list_missions_filter` — search missions for the Transfer Mission picker
 * (Phase 3 / ORDL-06).
 *
 * Endpoint: GET https://platform-api.quiqup.com/quiqdash/missions
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json
 *
 * Query param (REQUIRED):
 *   - value: search prefix used by the Transfer Mission picker. Typically a
 *            partial mission name or numeric ID.
 *
 * Built via URLSearchParams (T-03-18 hygiene) — never string concatenation.
 *
 * This is the autocomplete endpoint, not the full mission-detail surface — for
 * that, use the future `get_mission` tool (not yet built).
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { environmentField } from "@/lib/clients/quiqup-env";
import { PlatformApiClient } from "@/lib/clients/platform-api";

const inputSchema = z.object({
  value: z
    .string()
    .min(1)
    .describe(
      "Search prefix used by the Transfer Mission picker. Typically a partial mission name or numeric ID. Source: app/hooks/order/use-order-management.ts:71.",
    ),
  environment: environmentField,
});

const outputSchema = z
  .object({ results: z.array(z.string()) })
  .passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "list_missions_filter",
  description:
    "GET /quiqdash/missions (Platform API, proxies to ex-core). " +
    "Search missions for the Transfer Mission picker. " +
    "Response shape: `{ results: string[] }` — a flat array of mission name/ID " +
    "strings matching the search prefix. This is the autocomplete endpoint, not the " +
    "full mission-detail surface — for that, use the future `get_mission` tool (not " +
    "yet built). " +
    "When to use: populate the Transfer Mission picker when an operator is searching " +
    "for a mission to attach orders to. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 422 → upstream " +
    "validation; 5xx → upstream temporarily unavailable, retry. " +
    'Example: `{ "value": "DXB-mission-202605", "environment": "production" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("list_missions_filter requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    // 03-REVIEW WR-01: migrated from inline fetch boilerplate to the
    // PlatformApiClient helper (see lib/clients/platform-api.ts).
    const client = new PlatformApiClient({ jwt, environment: args.environment });
    const data = await client.request("GET", "/quiqdash/missions", {
      query: { value: args.value },
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
};
