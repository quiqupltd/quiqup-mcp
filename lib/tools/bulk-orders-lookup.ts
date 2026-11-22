/**
 * `bulk_orders_lookup` — re-fetch a bulk set of Quiqup orders (with
 * per-item weights + parcel barcodes) by `clientOrderID` via the Orders
 * Core GraphQL `bulkOrdersLookupQuery`
 * (Phase 3 / ORDL-03 → `bulkOrdersLookupQuery`).
 *
 * Endpoint: POST https://orders-api.quiqup.com/graph
 *   (or orders-api.staging.quiqup.com/graph when `environment: "staging"`).
 * Headers: Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token
 *   bridge — IDENTICAL to the REST tools), Accept/Content-Type JSON.
 *
 * Typical flow: agent calls `lookup_orders_ids` to discover a matching set,
 * then `bulk_orders_lookup` with the resulting `clientOrderID`s to fetch the
 * per-item weights + parcel barcodes — typically because a follow-up
 * mutation (bulk weight update, mission add-by-id) needs them.
 *
 * GraphQL contract notes:
 *   - The `query` string is an inline CONSTANT — never built from caller
 *     data (threat T-03-08). Variables go on the GraphQL `variables`
 *     envelope; the wire serializer is `JSON.stringify`, no concatenation.
 *   - Selection set MUST match the Quiqdash frontend's
 *     `app/graphql/queries/bulk-orders-lookup.query.ts` because Orders
 *     Core treats query text as the response contract — see
 *     docs/quiqup-api-full-frontend-extract.md §19 E lines 4504-4516.
 *   - Upstream hard-caps the request at `first: 200`; we mirror that cap
 *     at the schema layer (`z.array(...).max(200)`) so an over-large
 *     request is rejected loudly client-side rather than silently
 *     truncated by the upstream.
 *   - HTTP non-2xx → QuiqupHttpError (registerTool wrapper unwraps to
 *     `isError: true`).
 *   - HTTP 200 with populated `errors[]` is surfaced verbatim (GraphQL
 *     partial-success per spec §7.1).
 *
 * Identity binding: the handler refuses to run when `auth.userId` is null
 * (BL-04 — server-derived identity only).
 *
 * Error modes:
 *   - 401 / 403       → auth issue (run `whoami_platform`).
 *   - 5xx             → upstream temporarily unavailable, retry.
 *   - `errors[]` in a 200 response → partial-success; inspect each entry's
 *                                    `message` and `path` to triage.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { environmentField } from "@/lib/clients/quiqup-env";
import { OrdersCoreGraphQLClient } from "@/lib/clients/orders-core-graphql";

const inputSchema = z.object({
  client_order_ids: z
    .array(z.number().int().positive())
    .min(1)
    .max(200)
    .describe(
      "Quiqup `clientOrderID` values to re-fetch. Capped at 200 — matches " +
        "the upstream `bulkOrdersLookupQuery`'s `first: 200` hard-cap so " +
        "over-large requests are rejected here instead of being silently " +
        "truncated upstream.",
    ),
  environment: environmentField,
});

const outputSchema = z
  .object({
    data: z.object({}).passthrough().nullable(),
    errors: z.array(z.unknown()).optional(),
  })
  .passthrough();

/**
 * Selection set MUST match the Quiqdash frontend's
 * `app/graphql/queries/bulk-orders-lookup.query.ts` because Orders Core
 * treats query text as the response contract. Mirrors
 * docs/quiqup-api-full-frontend-extract.md §19 E lines 4504-4516 exactly.
 */
// 03-REVIEW WR-03: `pageInfo { hasNextPage }` + `totalCount` added so
// the agent can detect silent truncation if upstream `clientOrderIDIn`
// semantics ever broaden (e.g. soft-deleted orders, fuzzy match) and
// pushes the result over the hard-coded `first: 200` cap. Today the
// schema caps `client_order_ids` at 200 and `clientOrderIDIn` is exact-
// match, so truncation cannot occur — but `lookup_orders_ids` (the
// agent's typical predecessor call in this flow) already requests
// `pageInfo + totalCount`. Asymmetric selection across two tools the
// agent uses in sequence is a debugging footgun; this restores
// symmetry. The handler does NOT branch on these fields — surfacing
// them in the response is enough for the agent to spot truncation.
const BULK_ORDERS_LOOKUP_QUERY = `query bulkOrdersLookup($where: OrderWhereInput) {
  orders(first: 200, where: $where) {
    edges {
      node {
        id
        uuid
        clientOrderID
        state
        items {
          id
          name
          parcelBarcode
          parcelBarcodeGeneratedBy
          quantity
          weight
        }
      }
    }
    pageInfo { hasNextPage }
    totalCount
  }
}`;

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "bulk_orders_lookup",
  description:
    "Re-fetch a bulk set of Quiqup orders by `clientOrderID` — including " +
    "item-level weights and parcel barcodes — via the Orders Core GraphQL " +
    "`bulkOrdersLookupQuery` (POST https://orders-api.quiqup.com/graph). " +
    "Backs the Quiqdash bulk weight-update modal and the bulk mission " +
    "add-by-id flow. Returns " +
    "`{ orders: { edges: [{ node: { id, uuid, clientOrderID, state, items: " +
    "[{ id, name, parcelBarcode, parcelBarcodeGeneratedBy, quantity, weight " +
    "}] } }], pageInfo: { hasNextPage }, totalCount } }`. The pageInfo + " +
    "totalCount fields are surfaced so the agent can detect silent " +
    "truncation if `totalCount > 200` ever holds — today the schema's " +
    "`client_order_ids.max(200)` cap means this is informational only " +
    "(03-REVIEW WR-03 lift). " +
    "Typical flow: call `lookup_orders_ids` first to get a matching set of " +
    "ids, then this tool to fetch the per-item weights + parcel barcodes for " +
    "the ones you want to mutate. For dashboard/listing rows, use " +
    "`recent_orders` (last-mile REST) instead. " +
    "Input cap: `client_order_ids` is capped at 200 entries — the upstream " +
    "`bulkOrdersLookupQuery` hard-codes `first: 200`, so passing more would " +
    "silently truncate; we reject at the schema layer instead. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 5xx → " +
    "upstream temporarily unavailable, retry. GraphQL `errors[]` in a 200 " +
    "response indicate partial-success (per GraphQL spec §7.1) — inspect " +
    "each entry's `message` and `path` for field-level rejection detail. " +
    "The tool surfaces both `data` and `errors` in its output so partial " +
    "failures are never silently dropped. " +
    "Example: `{ \"client_order_ids\": [12345, 12346, 12347], " +
    "\"environment\": \"production\" }`.",
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("bulk_orders_lookup requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    const client = new OrdersCoreGraphQLClient({
      jwt,
      environment: args.environment,
    });

    // Translate the flat `client_order_ids` arg into the upstream's
    // OrderWhereInput shape (`clientOrderIDIn: number[]`). The `where`
    // envelope is the variable, not part of the query string.
    const variables = {
      where: { clientOrderIDIn: args.client_order_ids },
    };

    const result = await client.query(BULK_ORDERS_LOOKUP_QUERY, variables);

    // Surface BOTH data and errors so partial-success is visible to the agent.
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  },
};
