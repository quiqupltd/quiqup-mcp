/**
 * `list_quiqup_order_states` — fetch the canonical Quiqup order-state taxonomy
 * from platform-api.quiqup.com (Phase 1 / INTG-19).
 *
 * Endpoint: GET https://platform-api.quiqup.com/quiqup/orders/states
 * The QuiqDash UI calls this via `useGetQuiqupStates` (source-doc line 221) and
 * uses the response to populate every order-filter dropdown.
 *
 * This is the SOURCE OF TRUTH for the `state` enum used by:
 *   - `recent_orders` filtering
 *   - batch state-transition tools (out_for_delivery, collection_failed, …)
 *   - any future order-search UX
 *
 * The full state machine (allowed transitions, terminal states) is documented
 * in PROJECT.md.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({ environment: environmentField });
const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "list_quiqup_order_states",
  description:
    "Returns the canonical order-state taxonomy used by every filter dropdown " +
    "and every batch-status-transition tool. Use this to validate `state` " +
    "inputs to `recent_orders` and to map between human labels and internal " +
    "enum names. The full state machine is documented in PROJECT.md. " +
    "Endpoint: GET /quiqup/orders/states on platform-api.quiqup.com. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 5xx → upstream " +
    "temporarily unavailable, retry. " +
    'Example: `{ "environment": "production" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("list_quiqup_order_states requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const res = await fetch(`${platformApiBase}/quiqup/orders/states`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/json",
      },
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
