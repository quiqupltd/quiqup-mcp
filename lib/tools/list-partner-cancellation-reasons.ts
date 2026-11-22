/**
 * `list_partner_cancellation_reasons` — fetch the dropdown options for
 * partner-initiated order cancellation (Phase 1 / ORDL-08).
 *
 * Endpoint: GET https://platform-api.quiqup.com/orders/partner-cancellation-reasons
 * Headers:  Authorization: Bearer <session-JWT>, Accept: application/json
 *
 * Pair this with the already-shipped `cancel_lastmile_orders_batch` to
 * validate `cancellation_reason` inputs before sending the batch transition.
 *
 * NOTE: the upstream is not in the OpenAPI yet (the source frontend casts
 * the response `as any`), so the output schema is intentionally a wide
 * passthrough.
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
  name: "list_partner_cancellation_reasons",
  description:
    "Returns the dropdown options for the partner-initiated cancellation " +
    "dialog. Pair with the future `cancel_lastmile_orders_batch` " +
    "(already shipped) to validate `cancellation_reason` inputs. " +
    "Endpoint: GET platform-api.quiqup.com/orders/partner-cancellation-reasons. " +
    "Distinguished from `list_cancellation_reasons`: this is the narrower " +
    "partner-initiated subset; the other is the broader taxonomy used by " +
    "the Bulk Change State dialog. " +
    "Endpoint is not in the upstream OpenAPI yet (cast `as any` in the " +
    "source frontend) — schema is intentionally open via passthrough. " +
    "Error modes: 401/403 = auth issue (run `whoami_platform`); 5xx = " +
    "upstream-unavailable — retry in a few seconds. " +
    'Example: `{ "environment": "production" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error(
        "list_partner_cancellation_reasons requires an authenticated user",
      );
    }
    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const res = await fetch(
      `${platformApiBase}/orders/partner-cancellation-reasons`,
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
