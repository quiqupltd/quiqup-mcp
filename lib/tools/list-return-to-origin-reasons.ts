/**
 * `list_return_to_origin_reasons` — fetch the return-to-origin reason
 * taxonomy (Phase 1 / ORDL-10).
 *
 * Endpoint: GET https://platform-api.quiqup.com/quiqdash/orders/states/return_to_origin_reasons
 * Headers:  Authorization: Bearer <session-JWT>, Accept: application/json
 *
 * No filter params per source-doc. Pair with the future `set_return_to_origin`
 * (Phase 4) batch transition to validate the reason input before sending.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({ environment: environmentField });

const outputSchema = z
  .object({ reasons: z.array(z.unknown()).optional() })
  .passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "list_return_to_origin_reasons",
  description:
    "Returns the return-to-origin reason taxonomy used by the Bulk Change " +
    "State dialog (intention=return_to_origin). " +
    "Endpoint: GET platform-api.quiqup.com/quiqdash/orders/states/return_to_origin_reasons. " +
    "Pair with the future `set_return_to_origin` (Phase 4) batch transition " +
    "to validate the `return_to_origin_reason` input before sending. " +
    "Error modes: 401/403 = auth issue (run `whoami_platform`); 5xx = " +
    "upstream-unavailable — retry in a few seconds. " +
    'Example: `{ "environment": "production" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error(
        "list_return_to_origin_reasons requires an authenticated user",
      );
    }
    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const res = await fetch(
      `${platformApiBase}/quiqdash/orders/states/return_to_origin_reasons`,
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
