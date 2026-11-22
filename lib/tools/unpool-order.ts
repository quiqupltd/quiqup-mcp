/**
 * `unpool_order` (ORDT-14) — DESTRUCTIVE single-order PUT that severs an
 * order's mission assignment without touching the order itself. Returns
 * the order to the unassigned pool.
 *
 * Endpoint: PUT https://platform-api.quiqup.com/quiqdash/missions/unpool/orders/{orderUUID}
 *
 * Why this tool is hand-written (NOT through the factory):
 *   The canonical batch-transition factory at
 *   `lib/tools/_batch-transition-factory.ts` is batch-shaped — it owns
 *   the `order_ids: array` input, the sequential per-id scope-assertion
 *   LOOP, and the batch-PUT body assembly. `unpool_order` is the only
 *   ORDT transition that operates on a SINGLE order id (via path
 *   parameter rather than body array). Forcing it through the factory
 *   would either bend the factory's shape away from "batch" (poisoning
 *   the 11 other ORDT tools) or paper over the difference at the
 *   wrapper layer (defeating the factory's purpose). The cleaner answer
 *   per D-01 specifics: hand-write `unpool_order` against the canonical
 *   destructive helpers directly, mirroring the factory's handler
 *   ordering (auth → confirm → scope → dry_run → upstream) so the gate
 *   contract is identical.
 *
 * Distinct from mission cancellation: the order SURVIVES — only its
 * mission assignment is severed.
 *
 * `order_uuid` must be the UUID form (the `uuid` field on order detail,
 * NOT the integer id). The handler URL-encodes it before interpolation
 * to lock out path-injection.
 *
 * Destructive contract (canonical Phase 2+ pattern):
 *   - `confirm: true` MUST be set; otherwise `requireConfirm` throws
 *     `ConfirmationRequiredError` and the handler returns a structured
 *     isError result. NO upstream PUT is made.
 *   - `dry_run: true` short-circuits AFTER auth + confirm + scope but
 *     BEFORE the upstream PUT. Pair with `confirm: true` to exercise
 *     the gate.
 *   - Sequential scope-assertion via `assertOrderBelongsToUser` runs
 *     BEFORE the dry-run branch so dry-run still fails-fast on
 *     out-of-scope orders.
 *   - Tight 3/min rate limit; 15-min idempotency window; audit on.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { PlatformApiClient } from "@/lib/clients/platform-api";
import { environmentField } from "@/lib/clients/quiqup-env";
import {
  destructiveConfirmField,
  destructiveDryRunField,
  requireConfirm,
  isDryRun,
  ConfirmationRequiredError,
  buildConfirmationRequiredResult,
} from "@/lib/middleware/destructive";
import {
  ScopeViolationError,
} from "@/lib/middleware/scope";
import { assertOrderOwned, jwtFor, lookupOwnedOrderRow } from "@/lib/caller-auth";

const inputSchema = z.object({
  order_uuid: z
    .string()
    .min(1)
    .describe(
      "Quiqup order UUID — the `uuid` field on order detail, NOT the " +
        "integer id. URL-encoded by the handler before the upstream PUT.",
    ),
  confirm: destructiveConfirmField,
  dry_run: destructiveDryRunField,
  idempotency_key: z
    .string()
    .optional()
    .describe(
      "Optional client-supplied key. Duplicate calls with the same key " +
        "within 15 minutes return the cached result without re-firing " +
        "the upstream PUT.",
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "unpool_order",
  description:
    "DESTRUCTIVE: unpool a single order from its current mission, returning " +
    "it to the unassigned pool. Requires `confirm: true`. Use `dry_run: " +
    "true` (paired with `confirm: true`) to preview without modifying. " +
    "Distinct from mission cancellation — the order survives, only its " +
    "mission assignment is severed. The order_uuid must be the UUID form " +
    "(the `uuid` field on order detail, NOT the integer id). Endpoint: " +
    "PUT /quiqdash/missions/unpool/orders/{orderUUID} on platform-api. " +
    'Example: `{ "order_uuid": "abc-123-...", "confirm": true }`.',
  inputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 3, refillPerSec: 3 / 60 },
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    // 1. Auth gate (T-02-37 — runs BEFORE requireConfirm so anon callers
    //    see the auth error, not the confirm error).
    if (!auth.userId) {
      throw new Error("unpool_order requires an authenticated user");
    }

    // 2. Destructive confirm gate. ZERO upstream traffic past this point
    //    unless confirm:true.
    try {
      requireConfirm("unpool_order", args, "1 order from its mission");
    } catch (err) {
      if (err instanceof ConfirmationRequiredError) {
        return buildConfirmationRequiredResult(err);
      }
      throw err;
    }

    // 3. Per-order scope assertion. Runs BEFORE the dry-run branch so a
    //    dry-run preview still fails-fast on out-of-scope orders.
    try {
      await assertOrderOwned(auth, args.order_uuid, args.environment);
    } catch (err) {
      if (err instanceof ScopeViolationError) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `unpool_order refused: order ${args.order_uuid} is not ` +
                `visible under your session. No upstream PUT was attempted.`,
            },
          ],
          isError: true,
        };
      }
      throw err;
    }

    // 4. Dry-run branch — synthesized preview (decision D-03). Single-order
    //    shape names the uuid (not orderIds array) so the LLM caller can
    //    tell from the response shape that this is the unpool tool.
    if (isDryRun(args)) {
      const preview = {
        dryRun: true,
        orderUuid: args.order_uuid,
        simulated: {
          ok: true,
          transition: "unpool_order",
          order_uuid: args.order_uuid,
        },
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(preview, null, 2),
          },
        ],
      };
    }

    // 5. Real PUT. Mint JWT → PlatformApiClient → empty body (upstream
    //    contract — the path parameter is the only argument). Path is
    //    URL-encoded to lock out path-injection (T-04-10).
    const jwt = await jwtFor(auth, args.environment);
    const client = new PlatformApiClient({
      jwt,
      environment: args.environment,
    });
    const data = await client.request(
      "PUT",
      `/quiqdash/missions/unpool/orders/${encodeURIComponent(args.order_uuid)}`,
      { body: {} },
    );

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Unpooled order ${args.order_uuid} from its mission.\n\n` +
            `Upstream response:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// Agent door (`/agent/mcp`) variant
// ---------------------------------------------------------------------------
//
// Platform `filters[order_id]` takes NUMERIC client order ids only, never a
// uuid. So on the agent door the tool takes the numeric order id; the
// ownership lookup on GET /quiqdash/orders both proves the order is the
// caller's and supplies the row's `uuid`, which goes into the unpool path.
// A row without a uuid is refused.

const agentInputSchema = z.object({
  order_id: z
    .string()
    .regex(/^\d{1,12}$/, "order_id must be the numeric client order id (1 to 12 digits)")
    .describe(
      "Numeric client order id (digits only, 1 to 12). The order's uuid is looked up " +
        "from your own order list; never pass a uuid.",
    ),
  confirm: destructiveConfirmField,
  dry_run: destructiveDryRunField,
  idempotency_key: z
    .string()
    .optional()
    .describe(
      "Optional client-supplied key. Duplicate calls with the same key within 15 " +
        "minutes return the cached result without re-firing the upstream PUT.",
    ),
  environment: environmentField,
});

export const agentSpec: ToolSpec<typeof agentInputSchema, typeof outputSchema> = {
  name: "unpool_order",
  description:
    "DESTRUCTIVE: unpool a single order from its current mission, returning it to the " +
    "unassigned pool (the order survives, only the mission assignment is severed). Takes " +
    "the NUMERIC order id; the uuid is looked up from your own order list. Requires " +
    "`confirm: true`; `dry_run: true` previews. Endpoint: PUT " +
    "/quiqdash/missions/unpool/orders/{uuid} on platform-api.",
  inputSchema: agentInputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 3, refillPerSec: 3 / 60 },
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("unpool_order requires an authenticated user");
    }
    try {
      requireConfirm("unpool_order", args, "1 order from its mission");
    } catch (err) {
      if (err instanceof ConfirmationRequiredError) {
        return buildConfirmationRequiredResult(err);
      }
      throw err;
    }

    let row: Record<string, unknown>;
    try {
      row = await lookupOwnedOrderRow(auth, args.order_id);
    } catch (err) {
      if (err instanceof ScopeViolationError) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `unpool_order refused: order ${args.order_id} is not in your order list. ` +
                `No upstream PUT was attempted.`,
            },
          ],
          isError: true,
        };
      }
      throw err;
    }
    const uuid = typeof row.uuid === "string" ? row.uuid : "";
    if (!uuid) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `unpool_order refused: order ${args.order_id} has no uuid in your order ` +
              `list, so it cannot be unpooled. No upstream PUT was attempted.`,
          },
        ],
        isError: true,
      };
    }

    if (isDryRun(args)) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                dryRun: true,
                orderId: args.order_id,
                orderUuid: uuid,
                simulated: { ok: true, transition: "unpool_order", order_uuid: uuid },
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    const jwt = await jwtFor(auth, args.environment);
    const client = new PlatformApiClient({ jwt, environment: args.environment });
    const data = await client.request(
      "PUT",
      `/quiqdash/missions/unpool/orders/${encodeURIComponent(uuid)}`,
      { body: {} },
    );
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Unpooled order ${args.order_id} (uuid ${uuid}) from its mission.\n\n` +
            `Upstream response:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  },
};
