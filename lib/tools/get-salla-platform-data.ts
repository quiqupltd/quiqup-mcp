/**
 * `get_salla_platform_data` — read a Salla connection's LIVE platform-data
 * bundle (shipping methods + locations as Salla currently exposes them) from
 * platform-api.quiqup.com (Phase 2 / INTG-24).
 *
 * Endpoint: GET https://platform-api.quiqup.com/integrations/configs/{connectionId}/platform-data
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json
 *
 * Response shape (per source-doc lines 4365-4378, authoritative):
 *   {
 *     shipping_methods: { id, code, title, kind?: "in_house" | "external" | "unknown" }[],
 *     locations:        { id, name }[]
 *   }
 *
 * Companion tools:
 *   - The returned `shipping_methods[].id` values feed
 *     `update_salla_config.delivery_methods[].platform_method_id` and the
 *     `code` values feed `update_salla_config.delivery_methods[].platform_method`.
 *   - The returned `locations[].id` values feed
 *     `update_salla_config.locations[].platform_location_id`.
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform`).
 *   - 404       → connection id unknown.
 *   - 5xx       → upstream temporarily unavailable; retry.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({
  connection_id: z
    .string()
    .min(1)
    .describe("Salla connection id (same value used by `get_salla_connection`)."),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "get_salla_platform_data",
  description:
    "Read a Salla connection's LIVE platform-data bundle (shipping methods + " +
    "locations as Salla currently exposes them) via GET " +
    "/integrations/configs/{connectionId}/platform-data on platform-api.quiqup.com. " +
    "Response shape: `{ shipping_methods: [{ id, code, title, kind? }], " +
    "locations: [{ id, name }] }` (kind ∈ 'in_house' | 'external' | 'unknown'). " +
    "These are Salla's LIVE shipping methods and locations — use them when " +
    "building `update_salla_config.delivery_methods[].platform_method_id` " +
    "(from shipping_methods[].id), `update_salla_config.delivery_methods[].platform_method` " +
    "(from shipping_methods[].code), and `update_salla_config.locations[].platform_location_id` " +
    "(from locations[].id). " +
    "Companion read: `get_salla_config` returns the SAVED mapping; this tool " +
    "returns the LIVE catalog. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 404 → " +
    "connection id unknown; 5xx → upstream temporarily unavailable, retry. " +
    'Example: `{ "connection_id": "conn_abc123", "environment": "production" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error(
        "get_salla_platform_data requires an authenticated user",
      );
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const res = await fetch(
      `${platformApiBase}/integrations/configs/${encodeURIComponent(args.connection_id)}/platform-data`,
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
