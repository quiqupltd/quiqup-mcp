/**
 * `get_integration_order` — re-fetch an integration-order envelope by UUID
 * from platform-api.quiqup.com (Phase 2 / INTG-05).
 *
 * Endpoint: GET https://platform-api.quiqup.com/order/{orderUUID}
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json
 *
 * The `order_uuid` arg is path-interpolated and `encodeURIComponent`-escaped
 * (T-02-02: path-injection hygiene). Zod `z.string().min(1)` rejects empty
 * strings at the schema layer.
 *
 * Response shape: large integration-order envelope (per source-doc lines
 * 1144-1411, authoritative). Includes billing_address, shipping, origin_address,
 * products, line_items, refunds, tax_lines, totals, tracking_token, references,
 * version, status, status_reason, …
 *
 * When to call this:
 *   This is the post-repair re-fetch path — use it after
 *   `repair_integration_orders` to confirm a previously-failed order is now in
 *   the expected state. Also useful for one-off envelope inspection when an
 *   agent needs to disambiguate by status/products/totals.
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform`).
 *   - 404       → no such order_uuid (verify against
 *                 `list_integration_order_reasons[].fulfillment_order_id`).
 *   - 5xx       → upstream temporarily unavailable, retry.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({
  order_uuid: z
    .string()
    .min(1)
    .describe(
      "Integration order UUID, e.g. as returned by " +
        "`list_integration_order_reasons[].fulfillment_order_id`.",
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "get_integration_order",
  description:
    "Re-fetch a single integration order envelope by UUID via " +
    "GET /order/{orderUUID} on platform-api.quiqup.com. " +
    "Response is the large integration-order envelope: billing_address, " +
    "shipping, origin_address, products, line_items, refunds, tax_lines, " +
    "totals, tracking_token, references, version, status, status_reason — " +
    "passed through verbatim. " +
    "This is the post-repair re-fetch path — use it after " +
    "`repair_integration_orders` to confirm a previously-failed order is " +
    "now in the expected state. The `status` and `status_reason` fields are " +
    "the canonical post-repair signal; `products` and `line_items` reflect " +
    "the current cart shape. " +
    "Pair with `list_integration_order_reasons` to discover the UUIDs of " +
    "failed orders to inspect. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 404 → no " +
    "such order_uuid (verify against the `fulfillment_order_id` field on " +
    "`list_integration_order_reasons` results); 5xx → upstream temporarily " +
    "unavailable, retry. " +
    'Example: `{ "order_uuid": "5a8b4e2f-1234-4abc-9def-abcdef012345" }`.',
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("get_integration_order requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const res = await fetch(
      `${platformApiBase}/order/${encodeURIComponent(args.order_uuid)}`,
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
