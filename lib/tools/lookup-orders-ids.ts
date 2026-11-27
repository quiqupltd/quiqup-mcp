/**
 * `lookup_orders_ids` — fetch ONLY the `clientOrderID`s of Quiqup orders
 * matching a where-filter via the Orders Core GraphQL endpoint
 * (Phase 3 / ORDL-02 → `ordersListingIdsQuery`).
 *
 * Endpoint: POST https://orders-api.quiqup.com/graph
 *   (or orders-api.staging.quiqup.com/graph when `environment: "staging"`).
 * Headers: Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token
 *   bridge — IDENTICAL to the REST tools), Accept/Content-Type JSON.
 *
 * When to use which (canonical disambiguation):
 *   - `lookup_orders_ids`   → just the `clientOrderID`s of orders matching a
 *                             filter. Use this for "select all matching"
 *                             bulk-action pre-flight (Quiqdash's bulk-update
 *                             entry point).
 *   - `bulk_orders_lookup`  → re-fetch the items + per-item weights for a
 *                             specific set of `clientOrderID`s (typical
 *                             companion call after this one).
 *   - `recent_orders` (Phase 1 ORDL-01, last-mile REST) → human-readable
 *                             rows with origin/destination/state for
 *                             dashboarding. Different surface entirely.
 *
 * GraphQL contract notes:
 *   - The `query` string is an inline CONSTANT — never built from caller
 *     data (threat T-03-08). Variables go on the GraphQL `variables`
 *     envelope; the wire serializer is `JSON.stringify`, no concatenation.
 *   - The selection set MUST match the Quiqdash frontend's
 *     `app/graphql/queries/orders-listing.query.ts` (`ordersListingIdsQuery`)
 *     because Orders Core treats query text as the response contract — see
 *     docs/quiqup-api-full-frontend-extract.md §19 E lines 4434-4458 (this
 *     companion query requests only `edges.node.clientOrderID`).
 *   - HTTP non-2xx → throws QuiqupHttpError (handled by the registerTool
 *     wrapper, surfaced to the caller as `isError: true`).
 *   - HTTP 200 with populated `errors[]` is NOT swallowed: the full
 *     `{ data, errors }` envelope is included in the text content so the
 *     agent can inspect partial failures (GraphQL spec §7.1).
 *
 * Identity binding: the handler refuses to run when `auth.userId` is null
 * (BL-04 from Phase 2 — server-derived identity only, no caller-supplied
 * `user_id` smuggle path).
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

/**
 * `OrderWhereInput` is supplied by the Quiqdash frontend's
 * `buildOrderFilters(searchFilter)` helper. The full TS shape isn't in the
 * doc extract, so we accept the object as a passthrough — the Quiqup BE
 * validates the field set upstream (over-constraining client-side would
 * lock out fields the FE quietly uses; the Phase-2 BL-01 footgun pattern).
 *
 * Observed keys (comment-pinned for description quality):
 *   stateIn               : string[]      e.g. ["pending", "delivery_complete"]
 *   sourceIn              : string[]      integration source filter
 *   clientOrderIDIn       : number[]
 *   partnerOrderIDIn      : string[]
 *   brandNameIn           : string[]
 *   submittedAtGTE / submittedAtLTE   : string   ISO-8601
 *   scheduledForGTE / scheduledForLTE : string   ISO-8601
 * (Orders Core has no `*Between` or `search` key on OrderWhereInput;
 * Quiqdash's `buildWhereFilters` sends submittedAtGTE/LTE. sc-34635)
 */
const inputSchema = z.object({
  first: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Forward-cursor page size (1-500). Pair with `after`. Mutually exclusive with `last`/`before`.",
    ),
  last: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Backward-cursor page size (1-500). Pair with `before`. Mutually exclusive with `first`/`after`.",
    ),
  after: z
    .string()
    .optional()
    .describe(
      "Opaque forward cursor copied from a previous response's `pageInfo.endCursor`.",
    ),
  before: z
    .string()
    .optional()
    .describe(
      "Opaque backward cursor copied from a previous response's `pageInfo.startCursor`.",
    ),
  where: z
    .object({})
    .passthrough()
    .optional()
    .describe(
      "OrderWhereInput filter (Quiqdash's `buildOrderFilters()` output). " +
        "Observed keys: stateIn (string[]), sourceIn (string[]), " +
        "clientOrderIDIn (number[]), partnerOrderIDIn (string[]), " +
        "brandNameIn (string[]), submittedAtGTE / submittedAtLTE (ISO-8601), " +
        "scheduledForGTE / scheduledForLTE (ISO-8601). " +
        "Passed through to upstream — Quiqup BE validates the schema. " +
        "Bad fields surface in the response's `errors[]` array.",
    ),
  orderBy: z
    .object({
      field: z
        .literal("SUBMITTED_AT")
        .describe(
          "Currently the only supported sort field (the Quiqdash frontend hard-codes SUBMITTED_AT).",
        ),
      direction: z.enum(["ASC", "DESC"]),
    })
    .optional(),
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
 * `app/graphql/queries/orders-listing.query.ts` (`ordersListingIdsQuery`)
 * because Orders Core treats query text as the response contract.
 * Mirrors docs/quiqup-api-full-frontend-extract.md §19 E lines 4434-4458,
 * narrowed to `edges.node.clientOrderID` (this is the "ids only" companion
 * query referenced on line 4461).
 * Variable types must match the Orders Core schema too (Quiqdash-v3
 * `app/graphql/schema.graphql`): cursors are `Cursor` and `orderBy` is
 * `OrderOrder`. Declaring `String` / `OrderByInput` made every call fail
 * with 422 GRAPHQL_VALIDATION_FAILED (sc-34635).
 */
const ORDERS_LISTING_IDS_QUERY = `query ordersListingIds($first: Int, $last: Int, $after: Cursor, $before: Cursor, $where: OrderWhereInput, $orderBy: OrderOrder) {
  orders(first: $first, last: $last, after: $after, before: $before, where: $where, orderBy: $orderBy) {
    edges { node { clientOrderID } }
    pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
    totalCount
  }
}`;

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "lookup_orders_ids",
  description:
    "Fetch ONLY the `clientOrderID`s of Quiqup orders matching a where-filter " +
    "via the Orders Core GraphQL `ordersListingIdsQuery` (POST " +
    "https://orders-api.quiqup.com/graph). Returns " +
    "`{ orders: { edges: [{ node: { clientOrderID } }], pageInfo, totalCount } }`. " +
    "When to use which: use `lookup_orders_ids` to get the ids of a matching " +
    "set (the 'select all matching' / bulk-action pre-flight pattern), then " +
    "`bulk_orders_lookup` to re-fetch the per-item weights and parcel barcodes " +
    "for the ones you want to mutate. For human-readable rows with " +
    "origin/destination/state, use `recent_orders` (last-mile REST) instead — " +
    "different surface entirely. " +
    "Filter (`where`) is OrderWhereInput passthrough. Observed keys: stateIn " +
    "(string[]), sourceIn (string[]), clientOrderIDIn (number[]), " +
    "partnerOrderIDIn (string[]), brandNameIn (string[]), submittedAtGTE / " +
    "submittedAtLTE (ISO-8601), scheduledForGTE / scheduledForLTE (ISO-8601). " +
    "Pagination is cursor-based: pass `first` + `after` for forward, `last` + " +
    "`before` for backward. Page size capped at 500 to bound response size; " +
    "use `totalCount` to size subsequent calls. " +
    "Sort: `orderBy.field` is locked to 'SUBMITTED_AT' (the only field the " +
    "Quiqdash frontend uses); pass `direction: 'DESC'` for newest-first. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform` to confirm the " +
    "JWT resolves); 5xx → upstream temporarily unavailable, retry. " +
    "GraphQL `errors[]` in a 200 response indicate partial-success (per " +
    "GraphQL spec §7.1) — inspect each entry's `message` and `path` for " +
    "field-level rejection detail. The tool surfaces both `data` and " +
    "`errors` in its output so partial failures are never silently dropped. " +
    "Example: `{ \"where\": { \"stateIn\": [\"pending\", \"delivery_complete\"], " +
    "\"submittedAtGTE\": \"2026-05-01T00:00:00Z\", \"submittedAtLTE\": " +
    "\"2026-05-19T00:00:00Z\" }, \"first\": 200, \"orderBy\": { \"field\": " +
    "\"SUBMITTED_AT\", \"direction\": \"DESC\" } }`.",
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("lookup_orders_ids requires an authenticated user");
    }

    // Enforce the mutual-exclusivity advertised in the input schema's
    // describe text: callers must not combine forward (first/after) and
    // backward (last/before) pagination in the same request. Upstream
    // GraphQL rejects this anyway, but failing fast here avoids the
    // network round-trip and produces a clearer error.
    const forward = args.first !== undefined || args.after !== undefined;
    const backward = args.last !== undefined || args.before !== undefined;
    if (forward && backward) {
      throw new Error(
        "lookup_orders_ids: cursor modes are mutually exclusive — pass `first`/`after` for forward pagination OR `last`/`before` for backward, not both.",
      );
    }

    const jwt = await jwtFor(auth, args.environment);
    const client = new OrdersCoreGraphQLClient({
      jwt,
      environment: args.environment,
    });

    // Build the variables envelope. We intentionally pass only the fields the
    // caller supplied; absent fields are omitted (rather than serialised as
    // `null`) so the upstream sees the same shape Quiqdash sends.
    const variables: Record<string, unknown> = {};
    if (args.first !== undefined) variables.first = args.first;
    if (args.last !== undefined) variables.last = args.last;
    if (args.after !== undefined) variables.after = args.after;
    if (args.before !== undefined) variables.before = args.before;
    if (args.where !== undefined) variables.where = args.where;
    if (args.orderBy !== undefined) variables.orderBy = args.orderBy;

    const result = await client.query(ORDERS_LISTING_IDS_QUERY, variables);

    // Surface BOTH data and errors so partial-success is visible to the agent.
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  },
};
