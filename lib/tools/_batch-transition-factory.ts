/**
 * Canonical batch-transition factory — the SINGLE source for the
 * destructive-batch contract used by every ORDT-03..14 forward-path and
 * reason-bearing tool in Phase 4.
 *
 * Why a factory (decision D-01, Phase-4 plan 04-01):
 *   The 12 ORDT batch transitions all share the shape
 *   `PUT /quiqdash/orders/batch/{transition}` with body `{ order_ids }`
 *   plus an optional `reason` for the four reason-bearing variants. If
 *   each were hand-authored we'd inevitably drift on the destructive
 *   gate, the scope-assertion loop, the dry-run shape, the guardrails
 *   block, or the auth-required preamble. Phase 3's `recent-orders.ts`
 *   maintenance-comment regression taught us "uniformity by convention"
 *   fails the moment a 13th tool gets added — the only way to lock the
 *   contract structurally is a single chokepoint every per-tool file
 *   passes through. That chokepoint is `defineBatchTransition`.
 *
 * Per-tool files (e.g. `lib/tools/set-collected.ts`) are then ONE call:
 *
 *     export const spec = defineBatchTransition({
 *       name: "set_collected",
 *       path: "/quiqdash/orders/batch/set_collected",
 *       description: "Mark a batch of orders as collected ...",
 *     });
 *
 * The per-tool description focuses ONLY on the transition semantics;
 * the factory appends the canonical destructive-gate preamble + dry-run
 * sentence automatically so the LLM sees the same wording on every
 * tool.
 *
 * Handler order (T-02-37/38/39 — auth → confirm → scope → dry-run → upstream):
 *   1. `if (!auth.userId) throw` — destructive ops require an
 *      authenticated user; this fires BEFORE requireConfirm so anon
 *      callers see the auth error, not the confirm error.
 *   2. `requireConfirm` — throws `ConfirmationRequiredError`; the
 *      handler catches it and returns the canonical
 *      `buildConfirmationRequiredResult` shape. ZERO upstream traffic
 *      on missing confirm.
 *   3. Sequential `assertOrderBelongsToUser` loop (NOT Promise.all —
 *      the assertion endpoint is rate-limited per-user; burst-paralleling
 *      10 calls would trip the limit before the destructive call even
 *      reaches the gate, see decision D-07). Denials collected; any
 *      denial refuses the WHOLE batch with a structured error naming
 *      every denied id. ZERO upstream PUT traffic.
 *   4. If `dry_run: true` → synthesize a rich preview payload
 *      (decision D-03): `{ dryRun: true, orderIds, simulated: {...} }`
 *      where `simulated` is a "batch acknowledged" envelope shaped
 *      like what the real PUT would return. ZERO upstream PUT traffic.
 *   5. Mint JWT, build PlatformApiClient, fire ONE PUT with body
 *      `{ order_ids, ...(reason ? { reason } : {}) }`. Return the
 *      upstream payload to the caller.
 *
 * Imports DIRECTLY from `lib/middleware/destructive.ts` (no copy-paste,
 * no rename — D-01 explicit). The grep gate in the plan's acceptance
 * criteria asserts every per-tool file contains EXACTLY one
 * `defineBatchTransition(` call and ZERO inline `requireConfirm`,
 * `isDryRun`, or `assertOrderBelongsToUser` references — proving the
 * factory is the only chokepoint.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { PlatformApiClient } from "@/lib/clients/platform-api";
import { environmentField } from "@/lib/clients/quiqup-env";
import { jwtFor } from "@/lib/caller-auth";
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
import { assertOrderOwned } from "@/lib/caller-auth";

export interface BatchTransitionConfig {
  /** MCP tool name, snake_case (e.g. "set_collected"). */
  name: string;
  /** Upstream path on platform-api (e.g. "/quiqdash/orders/batch/set_collected"). */
  path: string;
  /**
   * Semantic-only description. The factory automatically prepends the
   * canonical "DESTRUCTIVE state transition" preamble and appends the
   * dry-run hint so the LLM sees uniform wording on every tool.
   */
  description: string;
  /**
   * Opt-in reason-bearing variant. When set, the input schema gains a
   * required `reason: z.string().min(1)` field whose description
   * names the Phase-1 enumeration tool to call for valid values (per
   * decision D-02 — free-form string + description-pin, not enum).
   */
  reasonField?: {
    description: string;
  };
  /**
   * JSON key the upstream expects for the id list. Defaults to `order_ids`
   * (the ex-core / last-mile shape the original ORDT tools use). The merchant
   * app routes on platform-api (`/quiqdash/orders/batch/set_ready_for_collection`
   * and `set_cancelled`) take camelCase `orderIds`; set this for those.
   */
  bodyKey?: "order_ids" | "orderIds";
}

// Output schema is shared across every factory instance — these tools
// return whatever the upstream batch endpoint returns, and registerTool's
// M4 enforcement is warn-only anyway.
const sharedOutputSchema = z.object({}).passthrough();

/**
 * Build a ToolSpec for a destructive batch transition.
 *
 * Returns a strongly-typed spec ready to pass to `registerTool`. Callers
 * are expected to be one-line: `export const spec = defineBatchTransition({...})`.
 */
export function defineBatchTransition(
  config: BatchTransitionConfig,
): ToolSpec<z.ZodObject<z.ZodRawShape>, typeof sharedOutputSchema> {
  // Mutable record so we can conditionally graft on `reason`. We widen to
  // `Record<string, z.ZodTypeAny>` rather than `z.ZodRawShape` because
  // Zod v4's raw-shape type is a Readonly index signature, which forbids
  // the `baseShape.reason = ...` assignment below.
  const baseShape: Record<string, z.ZodTypeAny> = {
    order_ids: z
      .array(z.string().min(1))
      .min(1)
      .max(10)
      .describe(
        "Up to 10 Quiqup order ids to transition in a single batch. " +
          "Each id is independently scope-checked against your session " +
          "BEFORE the upstream PUT runs; any out-of-scope id refuses the " +
          "whole batch with no upstream traffic.",
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
  };
  if (config.reasonField) {
    baseShape.reason = z
      .string()
      .min(1)
      .describe(config.reasonField.description);
  }
  const inputSchema = z.object(baseShape);

  const description =
    `DESTRUCTIVE state transition. ${config.description} ` +
    `Requires \`confirm: true\`. Use \`dry_run: true\` to preview the ` +
    `simulated upstream payload without firing the PUT.`;

  return {
    name: config.name,
    description,
    inputSchema,
    outputSchema: sharedOutputSchema,
    guardrails: {
      rateLimit: { capacity: 3, refillPerSec: 3 / 60 },
      idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
      audit: true,
    },
    handler: async (auth, rawArgs) => {
      // We type the inbound args off the runtime shape — Zod has already
      // parsed in registerTool, but the factory accepts a wide signature
      // so we narrow locally for ergonomic property access.
      const args = rawArgs as {
        order_ids: string[];
        confirm?: boolean;
        dry_run?: boolean;
        idempotency_key?: string;
        environment?: "production" | "staging";
        reason?: string;
      };

      // 1. Auth gate (T-02-37 — runs BEFORE requireConfirm so anon
      //    callers see the auth error, not the confirm error).
      if (!auth.userId) {
        throw new Error(
          `${config.name} requires an authenticated user`,
        );
      }

      // 2. Confirm gate. Throw → catch → structured error result. No
      //    upstream traffic possible past this point unless confirm:true.
      try {
        requireConfirm(
          config.name,
          args,
          `${args.order_ids.length} order(s)`,
        );
      } catch (err) {
        if (err instanceof ConfirmationRequiredError) {
          return buildConfirmationRequiredResult(err);
        }
        throw err;
      }

      // 3. Sequential per-id scope assertion. Collect denials so the
      //    refusal can name every offending id at once (LLM can drop the
      //    bad ids and retry without binary-search).
      const denied: string[] = [];
      for (const id of args.order_ids) {
        try {
          await assertOrderOwned(auth, id, args.environment);
        } catch (err) {
          if (err instanceof ScopeViolationError) {
            denied.push(id);
          } else {
            throw err;
          }
        }
      }
      if (denied.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Batch ${config.name} refused: ${denied.length} order id(s) ` +
                `not visible under your session: ${denied.join(", ")}. ` +
                `No upstream call was attempted. Drop the inaccessible ` +
                `id(s) and retry.`,
            },
          ],
          isError: true,
        };
      }

      // 4. Dry-run branch (decision D-03 — rich preview). Note: we run
      //    the scope-assertion loop BEFORE this so dry-run still
      //    fails-fast on out-of-scope orders.
      if (isDryRun(args)) {
        const simulated: Record<string, unknown> = {
          ok: true,
          transition: config.name,
          order_ids: args.order_ids,
        };
        if (config.reasonField && args.reason !== undefined) {
          simulated.reason = args.reason;
        }
        const preview = {
          dryRun: true,
          orderIds: args.order_ids,
          simulated,
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

      // 5. Real PUT. Mint JWT → PlatformApiClient → body assembly.
      const jwt = await jwtFor(auth, args.environment);
      const client = new PlatformApiClient({
        jwt,
        environment: args.environment,
      });
      const body: Record<string, unknown> = {
        [config.bodyKey ?? "order_ids"]: args.order_ids,
      };
      if (config.reasonField && args.reason !== undefined) {
        body.reason = args.reason;
      }
      const data = await client.request("PUT", config.path, { body });

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Transitioned ${args.order_ids.length} order(s) via ${config.name}.\n\n` +
              `Upstream response:\n${JSON.stringify(data, null, 2)}`,
          },
        ],
      };
    },
  };
}
