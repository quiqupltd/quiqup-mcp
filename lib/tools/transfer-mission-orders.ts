/**
 * `transfer_mission_orders` — Phase 4 / MISS-02 (DESTRUCTIVE-gated).
 *
 * Endpoint: PUT https://platform-api.quiqup.com/quiqdash/missions/transfer/{missionID}
 *           body: { order_ids: [...] }
 * Headers:  Authorization: Bearer <session-JWT>, Accept: application/json,
 *           Content-Type: application/json
 *
 * Semantics: transfer one or more orders INTO the target mission. The
 * upstream removes the orders from their current mission (if any) and
 * assigns them to the named mission. The companion `create_mission`
 * (MISS-01) is NOT destructive-gated because it's pure creation; THIS
 * tool IS destructive-gated (D-05) because it mutates dispatch state on
 * both the source AND target mission. Up to 50 orders per call.
 *
 * Why 50 (vs. 10 for ORDT batch transitions):
 *   Mission transfers are mission-level operations where the realistic
 *   batch size is the mission itself. ORDT batch transitions move a few
 *   ad-hoc orders between states; this tool reassigns an entire mission
 *   manifest. 50 matches the typical mission size envelope observed in
 *   Quiqdash; if a mission exceeds 50 orders, split the transfer into
 *   sequential calls.
 *
 * Hand-written (NOT factory-driven):
 *   The batch-transition factory (lib/tools/_batch-transition-factory.ts)
 *   is shaped for the ORDT path `PUT /quiqdash/orders/batch/{transition}`
 *   with body { order_ids }. This tool's path interpolates a mission_id
 *   segment, so it can't reuse the factory verbatim. It does, however,
 *   import the SAME canonical destructive helpers
 *   (lib/middleware/destructive.ts) and the SAME scope assertion
 *   (lib/middleware/scope.ts::assertOrderBelongsToUser) — the destructive
 *   contract stays uniform even when the URL shape can't be factored.
 *
 * Handler order (T-02-37/38/39 — auth → confirm → scope → dry-run → upstream):
 *   1. `if (!auth.userId) throw` — anon callers see the auth error, not
 *      the confirm error.
 *   2. requireConfirm → throws ConfirmationRequiredError → catch →
 *      buildConfirmationRequiredResult. ZERO upstream traffic.
 *   3. Sequential `assertOrderBelongsToUser` loop (NOT Promise.all —
 *      the assertion endpoint is per-user rate-limited; bursting 50
 *      calls would trip the limit before the destructive PUT runs).
 *      Denials collected; any denial refuses the WHOLE batch.
 *   4. If `dry_run: true` → synthesize `{ dryRun: true, missionId,
 *      orderIds, simulated: {...} }`. ZERO upstream PUT traffic.
 *   5. Mint JWT, PlatformApiClient PUT
 *      `/quiqdash/missions/transfer/${encodeURIComponent(mission_id)}`
 *      with body { order_ids }. Return upstream payload to caller.
 *
 * T-04-22 — cross-tenant order-steal mitigation:
 *   An LLM caller could in principle try to "steal" orders out of
 *   another tenant's mission by transferring them into a mission they
 *   own. The per-id `assertOrderBelongsToUser` loop prevents this:
 *   Quiqup's scope model binds orders to partners, not to missions, and
 *   mission assignment is a transient state. assertOrderBelongsToUser
 *   proves the caller owns the orders — they cannot transfer orders they
 *   don't own. The threat is therefore mitigated STRUCTURALLY by
 *   tenant-level scope, not by a separate mission-membership check.
 *   (Considered: explicit source-mission membership verification.
 *   Rejected: the tenant-scope check already proves ownership; the
 *   "steal from someone else's mission" path requires the attacker to
 *   own the orders in the first place, which the scope loop forbids.)
 *
 * T-04-23 — mission_id path injection mitigation:
 *   `encodeURIComponent(args.mission_id)` on path interpolation so
 *   caller-supplied IDs cannot inject path components.
 *
 * Identity binding (BL-04 — server-side):
 *   No `user_id` / `actor_id` / `actor_email` / `partner_id` on input.
 *   Identity comes from `auth.userId` only.
 *
 * Guardrails (canonical destructive-tool block):
 *   - rateLimit 3/min — tight; mission transfers should be rare.
 *   - idempotency on `idempotency_key` (15min TTL) — safe retries.
 *   - audit: true.
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

const inputSchema = z.object({
  mission_id: z
    .string()
    .min(1)
    .describe(
      "ID of the TARGET mission — the destination the orders are moved " +
        "into. URL-encoded at the path boundary so caller-supplied IDs " +
        "cannot inject path components.",
    ),
  order_ids: z
    .array(z.string().min(1))
    .min(1)
    .max(50)
    .describe(
      "Up to 50 Quiqup order ids to transfer into the target mission. " +
        "Each id is independently scope-checked against the caller's " +
        "session BEFORE the upstream PUT runs; any out-of-scope id " +
        "refuses the whole batch with no upstream traffic. The 50-cap " +
        "(vs. 10 for ORDT batch transitions) reflects the typical " +
        "mission-manifest size.",
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
  name: "transfer_mission_orders",
  description:
    "DESTRUCTIVE — PUT /quiqdash/missions/transfer/{missionID} (Platform host). " +
    "Transfer one or more orders INTO a target mission. The upstream " +
    "removes the orders from their current mission (if any) and assigns " +
    "them to the named mission, mutating dispatch state on both source " +
    "and target. Requires `confirm: true`. Use `dry_run: true` (paired " +
    "with confirm) to preview without firing the PUT. Up to 50 orders " +
    "per call. " +
    "Companion: `create_mission` (MISS-01) creates a fresh mission and " +
    "is NOT destructive-gated per D-05 — the destructive split is " +
    "intentional. After creating a mission you typically follow up with " +
    "this tool to add orders to it. " +
    "Per-order scope-checked against the caller's session BEFORE the PUT " +
    "runs (T-04-22 — prevents 'stealing' orders out of another tenant's " +
    "mission via the scope model). mission_id is URL-encoded on path " +
    "interpolation (T-04-23). " +
    "Identity binding: no user/actor fields accepted — identity bound " +
    "server-side to auth.userId (BL-04). " +
    "Error modes: missing-confirm → ConfirmationRequiredError result " +
    "(isError:true), no upstream traffic; out-of-scope id → batch " +
    "refusal naming the denied id, no upstream PUT; 401/403 → auth " +
    "(run `whoami_platform`); 422 → upstream validation; 5xx → retry. " +
    'Example: `{ "mission_id": "miss-1", "order_ids": ["o-1","o-2"], ' +
    '"confirm": true, "environment": "production" }`.',
  inputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 3, refillPerSec: 3 / 60 },
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    // 1. Auth gate (T-02-37) — BEFORE requireConfirm so anon callers see
    //    the auth error, not the confirm error.
    if (!auth.userId) {
      throw new Error(
        "transfer_mission_orders requires an authenticated user",
      );
    }

    // 2. Confirm gate. Throw → catch → structured error result. No
    //    upstream traffic possible past this point unless confirm:true.
    try {
      requireConfirm(
        "transfer_mission_orders",
        args,
        `${args.order_ids.length} order(s) into mission ${args.mission_id}`,
      );
    } catch (err) {
      if (err instanceof ConfirmationRequiredError) {
        return buildConfirmationRequiredResult(err);
      }
      throw err;
    }

    // 3. Sequential per-id scope assertion (D-07). NOT Promise.all —
    //    the assertion endpoint is per-user rate-limited; bursting 50
    //    parallel GETs would trip the limit before the destructive PUT
    //    even reaches the gate. Denials collected so the refusal can
    //    name every offending id at once (LLM drops bad ids and retries
    //    without binary-search).
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
              `transfer_mission_orders refused: ${denied.length} order id(s) ` +
              `not visible under your session: ${denied.join(", ")}. ` +
              `No upstream call was attempted. Drop the inaccessible ` +
              `id(s) and retry.`,
          },
        ],
        isError: true,
      };
    }

    // 4. Dry-run branch (D-03 — rich preview). Note: scope-assertion
    //    runs BEFORE this so dry-run still fails-fast on out-of-scope ids.
    if (isDryRun(args)) {
      const preview = {
        dryRun: true,
        missionId: args.mission_id,
        orderIds: args.order_ids,
        simulated: {
          ok: true,
          transition: "transfer_mission_orders",
          target_mission_id: args.mission_id,
          order_ids: args.order_ids,
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

    // 5. Real PUT. Mint JWT → PlatformApiClient → encoded path.
    const jwt = await jwtFor(auth, args.environment);
    const client = new PlatformApiClient({
      jwt,
      environment: args.environment,
    });
    const path = `/quiqdash/missions/transfer/${encodeURIComponent(
      args.mission_id,
    )}`;
    const data = await client.request("PUT", path, {
      body: { order_ids: args.order_ids },
    });

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Transferred ${args.order_ids.length} order(s) into mission ` +
            `${args.mission_id}.\n\nUpstream response:\n${JSON.stringify(
              data,
              null,
              2,
            )}`,
        },
      ],
    };
  },
};
