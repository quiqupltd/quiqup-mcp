/**
 * `list_cancellation_reasons` — fetch the broad cancellation reason
 * taxonomy used by the Bulk Change State dialog (Phase 1 / ORDL-11).
 *
 * Endpoint: GET https://platform-api.quiqup.com/quiqdash/orders/cancellation-reasons
 * Headers:  Authorization: Bearer <session-JWT>, Accept: application/json
 *
 * Distinct from `list_partner_cancellation_reasons`:
 *   - `list_cancellation_reasons` (this) → broad cancellation taxonomy for
 *     the Bulk Change State dialog (intention=cancellation).
 *   - `list_partner_cancellation_reasons` → narrower partner-initiated
 *     subset used by the partner cancel dialog.
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
  name: "list_cancellation_reasons",
  description:
    "Returns the broad cancellation-reason taxonomy used by the Bulk Change " +
    "State dialog (intention=cancellation). " +
    "Endpoint: GET platform-api.quiqup.com/quiqdash/orders/cancellation-reasons. " +
    "This is the broad cancellation-reason taxonomy used by the Bulk Change " +
    "State dialog (intention=cancellation); `list_partner_cancellation_reasons` " +
    "is the narrower partner-initiated subset. " +
    "Pair with the future Phase-4 cancellation batch transition to validate " +
    "`cancellation_reason` inputs. " +
    "Error modes: 401/403 = auth issue (run `whoami_platform`); 5xx = " +
    "upstream-unavailable — retry in a few seconds. " +
    'Example: `{ "environment": "production" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("list_cancellation_reasons requires an authenticated user");
    }
    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const res = await fetch(
      `${platformApiBase}/quiqdash/orders/cancellation-reasons`,
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
