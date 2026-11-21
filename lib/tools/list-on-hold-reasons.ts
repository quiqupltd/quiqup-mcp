/**
 * `list_on_hold_reasons` — fetch the on-hold reason taxonomy filtered by
 * service kind (Phase 1 / ORDL-09).
 *
 * Endpoint: GET https://platform-api.quiqup.com/quiqdash/orders/states/on_hold_reasons?service_kind=<sk>
 * Headers:  Authorization: Bearer <session-JWT>, Accept: application/json
 *
 * Upstream returns different reasons per service-kind, so `service_kind`
 * is a REQUIRED query param. Use `list_service_kinds` (shipped in plan
 * 01-01) to enumerate valid values. Pair with the future `set_on_hold`
 * (Phase 4) batch tool to validate `on_hold_reason` inputs.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({
  service_kind: z
    .string()
    .min(1)
    .describe(
      "Service kind from list_service_kinds — required filter; the upstream returns different reasons per service kind",
    ),
  environment: environmentField,
});

const outputSchema = z
  .object({ reasons: z.array(z.unknown()).optional() })
  .passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "list_on_hold_reasons",
  description:
    "Returns the on-hold reason taxonomy for a given service_kind. " +
    "Endpoint: GET platform-api.quiqup.com/quiqdash/orders/states/on_hold_reasons?service_kind=. " +
    "service_kind is REQUIRED — enumerate valid values via `list_service_kinds`. " +
    "Pair with the future `set_on_hold` (Phase 4) batch tool to validate " +
    "`on_hold_reason` inputs before sending the transition. " +
    "Error modes: 401/403 = auth issue (run `whoami_platform`); 422 = " +
    "unknown service_kind; 5xx = upstream-unavailable — retry in a few seconds. " +
    'Example: `{ "service_kind": "express" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("list_on_hold_reasons requires an authenticated user");
    }
    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const url = new URL(
      `${platformApiBase}/quiqdash/orders/states/on_hold_reasons`,
    );
    url.searchParams.set("service_kind", args.service_kind);
    const res = await fetch(url.toString(), {
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
