/**
 * `list_courier_failure_reasons` — fetch the courier delivery/collection
 * failure reason taxonomy, filtered by delivery_type (Phase 1 / ORDL-12).
 *
 * Endpoint: GET https://platform-api.quiqup.com/quiqdash/courier/delivery_failure_reasons?delivery_type=<dt>
 * Headers:  Authorization: Bearer <session-JWT>, Accept: application/json
 *
 * delivery_type is REQUIRED and is one of `delivery_failed` /
 * `collection_failed` — the two have distinct reason sets per source-doc
 * line 312. Pair with the already-shipped staging-only batch transitions
 * `set_delivery_failed_batch` and `set_collection_failed_batch`.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({
  delivery_type: z
    .enum(["delivery_failed", "collection_failed"])
    .describe(
      "Which failure type — distinct reason sets per type per source-doc line 312",
    ),
  environment: environmentField,
});

const outputSchema = z
  .object({ reasons: z.array(z.unknown()).optional() })
  .passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "list_courier_failure_reasons",
  description:
    "Returns the courier-failure reason taxonomy for a given delivery_type. " +
    "Endpoint: GET platform-api.quiqup.com/quiqdash/courier/delivery_failure_reasons?delivery_type=. " +
    "delivery_type is REQUIRED and is one of `delivery_failed` / " +
    "`collection_failed` — the two have distinct reason sets. " +
    "Pair with the already-shipped staging-only batch transitions " +
    "`set_delivery_failed_batch` and `set_collection_failed_batch` " +
    "(and the future Phase-4 production variants) to validate the " +
    "courier_failure_reason input before sending. " +
    "Error modes: 401/403 = auth issue (run `whoami_platform`); 422 = " +
    "unknown delivery_type (schema-bounded at the tool layer so this is " +
    "unlikely); 5xx = upstream-unavailable — retry in a few seconds. " +
    'Example: `{ "delivery_type": "delivery_failed" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error(
        "list_courier_failure_reasons requires an authenticated user",
      );
    }
    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const url = new URL(
      `${platformApiBase}/quiqdash/courier/delivery_failure_reasons`,
    );
    url.searchParams.set("delivery_type", args.delivery_type);
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
