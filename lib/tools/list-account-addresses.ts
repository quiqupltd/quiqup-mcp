/**
 * `list_account_addresses` — read the address book for an account on
 * platform-api.quiqup.com (Phase 1 / ADDR-01).
 *
 * Endpoint: GET https://platform-api.quiqup.com/accounts/{id}/addresses
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json
 *
 * Use this to enumerate stored pickup/drop-off addresses for the signed-in
 * partner (default `id="me"`) before referencing them in order-creation or
 * waypoint-update flows. Pair with `create_partner_address` and
 * `update_partner_address` to mutate the same address book.
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform`).
 *   - 404       → account id is not visible to the signed-in user.
 *   - 422       → upstream validation rejection (rare on a GET).
 *   - 5xx       → upstream temporarily unavailable; retry after a few seconds.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({
  id: z
    .string()
    .min(1)
    .default("me")
    .describe('Account id; "me" resolves to the signed-in partner'),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "list_account_addresses",
  description:
    "Address book listing for the account; pair with create_partner_address / " +
    "update_partner_address to mutate. " +
    'Endpoint: GET platform-api.quiqup.com/accounts/{id}/addresses. Default ' +
    '`id="me"` resolves to the signed-in partner. Returns the array of saved ' +
    "addresses (each with id, label, address1/address2, town, country, " +
    "coordinates, contact details). " +
    "Error modes: 401/403 indicate an auth issue (run `whoami_platform`); 404 " +
    "means the account id is not visible to this user; 422 is rare on GET; " +
    "5xx is upstream-unavailable — retry in a few seconds. " +
    'Example: `{ "id": "me", "environment": "production" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("list_account_addresses requires an authenticated user");
    }
    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const id = args.id ?? "me";
    const res = await fetch(
      `${platformApiBase}/accounts/${encodeURIComponent(id)}/addresses`,
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
