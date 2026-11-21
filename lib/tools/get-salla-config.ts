/**
 * `get_salla_config` — read a Salla connection's SAVED config + mapping from
 * platform-api.quiqup.com (Phase 2 / INTG-25).
 *
 * Endpoint: GET https://platform-api.quiqup.com/integrations/configs/{connectionId}
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json
 *
 * Response shape (per source-doc lines 4380-4406, authoritative):
 *   200: { config: {
 *           delivery_methods: [{ platform_method, platform_method_id, service_kind, shipping_profile_id? }],
 *           locations: [{ platform_location_id, warehouse_id }],
 *           initial_order_states: string[],
 *           awb_trigger: "pending" | "ready_for_collection" | "at_depot" |
 *                        "out_for_delivery" | "on_shipment_webhook" |
 *                        "ready_for_collection_or_webhook",
 *           country_filter: string[],     // ISO-3166 alpha-2
 *           sync_products: boolean,
 *           auto_mark_as_rfc: boolean,
 *           wms_delay_minutes: number,
 *           is_manual_international_order_confirmed: boolean
 *         } }
 *   404: NO CONFIG SAVED YET — this tool surfaces that as a STRUCTURED
 *        `{ config: null, message: ... }` response (NOT a thrown error), so the
 *        LLM can immediately call `update_salla_config` to create one without
 *        first having to parse an HTTP error.
 *
 * Companion tools:
 *   - `get_salla_platform_data` — the LIVE catalog (use to discover valid
 *     platform_method_id + platform_location_id values when building an update
 *     payload).
 *   - `update_salla_config` — UPSERTs the config (creates if missing, partial-
 *     updates if present).
 *   - `list_service_kinds` — the canonical service_kind enum (Phase 1 AUTH-08).
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform`).
 *   - 404       → NO CONFIG YET — returned as `{ config: null }` structured
 *                 response (NOT a thrown error). Call `update_salla_config` to
 *                 create one.
 *   - 5xx       → upstream temporarily unavailable; retry after a few seconds.
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
    .describe(
      "Salla connection id (same value used by `get_salla_connection`).",
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "get_salla_config",
  description:
    "Read a Salla connection's SAVED config + mapping via GET " +
    "/integrations/configs/{connection_id} on platform-api.quiqup.com. " +
    "Response shape (envelope unwrapped on this MCP layer): " +
    "`{ delivery_methods: [{ platform_method, platform_method_id, service_kind, " +
    "shipping_profile_id? }], locations: [{ platform_location_id, warehouse_id }], " +
    "initial_order_states: string[], awb_trigger, country_filter: string[] " +
    "(ISO-3166 alpha-2), sync_products, auto_mark_as_rfc, wms_delay_minutes, " +
    "is_manual_international_order_confirmed }`. " +
    "awb_trigger ∈ 'pending' | 'ready_for_collection' | 'at_depot' | " +
    "'out_for_delivery' | 'on_shipment_webhook' | 'ready_for_collection_or_webhook'. " +
    "404 semantic: if NO config has been saved for this connection yet, upstream " +
    "returns 404 — this tool surfaces that as a STRUCTURED " +
    "`{ config: null, message: 'No Salla config saved yet ...' }` response " +
    "rather than a thrown error, so the agent can immediately call " +
    "`update_salla_config` to create one without parsing an HTTP error. Other " +
    "non-2xx (401/403/422/5xx) still throw QuiqupHttpError. " +
    "Companion reads: `get_salla_platform_data` returns the LIVE catalog (use " +
    "to discover valid platform_method_id + platform_location_id values); " +
    "`list_service_kinds` (Phase 1 AUTH-08) returns the canonical service_kind " +
    "enum. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 404 → returned " +
    "as structured null-config (NOT an error); 5xx → upstream temporarily " +
    "unavailable, retry. " +
    'Example: `{ "connection_id": "conn_abc123", "environment": "production" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("get_salla_config requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const res = await fetch(
      `${platformApiBase}/integrations/configs/${encodeURIComponent(args.connection_id)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/json",
        },
      },
    );

    // 404 = "no config saved yet" — surface as a structured null-config
    // response so the agent can act on it without parsing an HTTP error
    // (T-02-30 invariant). ANY OTHER non-2xx still throws.
    if (res.status === 404) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                config: null,
                message:
                  "No Salla config saved yet for this connection — call update_salla_config to create one.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (!res.ok) {
      throw new QuiqupHttpError(res.status, await res.text());
    }

    // Unwrap the `{ config }` envelope on success per source-doc line 4380.
    const body = (await res.json()) as { config?: Record<string, unknown> };
    const config = body.config ?? {};

    return {
      content: [
        { type: "text" as const, text: JSON.stringify(config, null, 2) },
      ],
    };
  },
};
