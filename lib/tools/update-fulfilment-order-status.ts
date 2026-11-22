/**
 * `update_fulfilment_order_status` (ORDS-04) — DESTRUCTIVE: change the
 * status of a single fulfilment order via PATCH /api/fulfilment/orders/{id}
 * on platform-api.quiqup.com (Phase 4 / Wave 3).
 *
 * Endpoint: PATCH https://platform-api.quiqup.com/api/fulfilment/orders/{id}
 *           Body:  { status: "<target-status>" }
 *           Auth:  Bearer <session-JWT>
 *
 * Destructive gating (D-06):
 *   This is a state mutation with the same "would-not-want-to-undo"
 *   property as the batch transitions (an LLM cannot easily roll back
 *   a fulfilment order from `shipped` back to `picking` without
 *   coordinating with the warehouse). It is therefore canonical
 *   destructive-gated:
 *     - `confirm: true` MUST be set. Otherwise the handler returns a
 *       structured isError result naming the order id + target status,
 *       and NO upstream PATCH is made.
 *     - `dry_run: true` (paired with `confirm: true`) short-circuits
 *       AFTER auth + confirm + scope checks but BEFORE the upstream
 *       PATCH — returns a synthesized preview payload.
 *
 * Status field shape (D-02 precedent):
 *   `status` is `z.string().min(1)` (free-form), NOT a `z.enum([...])`
 *   snapshot. The valid set lives on the BE; an LLM with up-to-date
 *   reasoning should consult the BE schema or order-history audit
 *   events for the legitimate set of target statuses. Overconstraining
 *   the client schema would silently break new statuses the moment
 *   Quiqup ships them. Bad inputs surface via the upstream's
 *   structured 4xx envelope.
 *
 * Guardrails: TIGHT 3/min canonical block (same as batch transitions)
 * + idempotency-key + audit.
 *
 * Phase-4 / Wave-3 single-order mutation. Direct handler (no factory) —
 * the factory is shaped for batch tools with `order_ids[]`, this tool
 * takes a single `order_id` + a `status` string.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { PlatformApiClient } from "@/lib/clients/platform-api";
import { environmentField } from "@/lib/clients/quiqup-env";
import { jwtFor } from "@/lib/caller-auth";
import {
  ConfirmationRequiredError,
  buildConfirmationRequiredResult,
  destructiveConfirmField,
  destructiveDryRunField,
  isDryRun,
  requireConfirm,
  sanitizeForResourceText,
} from "@/lib/middleware/destructive";
import { assertOrderOwned } from "@/lib/caller-auth";

const inputSchema = z.object({
  order_id: z
    .string()
    .min(1)
    .describe(
      "Fulfilment order id. Path-encoded by the handler before the " +
        "upstream PATCH.",
    ),
  status: z
    .string()
    .min(1)
    .describe(
      "Target fulfilment status. Free-form string accepted by the " +
        "upstream — the BE owns the valid set. If a Phase-1 enumeration " +
        "tool exists for fulfilment statuses, call it first; otherwise " +
        "consult the BE schema or order-history audit events for " +
        "observed values.",
    ),
  confirm: destructiveConfirmField,
  dry_run: destructiveDryRunField,
  idempotency_key: z
    .string()
    .optional()
    .describe(
      "Optional caller-supplied key to dedupe retries within a 15-minute " +
        "window. Recommended for destructive ops to make at-least-once " +
        "agent retries safe.",
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "update_fulfilment_order_status",
  description:
    "DESTRUCTIVE state mutation: change a fulfilment order's status via " +
    "PATCH /api/fulfilment/orders/{id} on platform-api.quiqup.com. " +
    "Requires `confirm: true`. Use `dry_run: true` (paired with confirm) " +
    "to preview the simulated payload without firing the PATCH. Has the " +
    "same 'would-not-want-to-undo' property as batch transitions (D-06) — " +
    "rolling a fulfilment order back to an earlier state typically " +
    "requires warehouse coordination. " +
    "Status field is free-form per D-02: consult the BE schema or " +
    "`get_order_history` / `list_order_audit_events` for the legitimate " +
    "set of target statuses. " +
    "Per-order scope-checked under the caller's session BEFORE the PATCH " +
    "runs (T-04-16). Idempotency: supply `idempotency_key` to make " +
    "at-least-once retries safe within 15 minutes. " +
    "Rate limit: TIGHT 3/min (same as batch transitions). " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 404 → " +
    "order not visible under your session (scope assertion catches this " +
    "before the PATCH); 4xx → BE rejected the target status (consult the " +
    "BE schema for the valid set); 5xx → upstream temporarily " +
    "unavailable, retry. " +
    'Example: `{ "order_id": "12345", "status": "shipped", "confirm": true, ' +
    '"environment": "production" }`.',
  inputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 3, refillPerSec: 3 / 60 }, // tight: 3/min canonical
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    // 1. Auth gate (T-04-17) — outermost, runs BEFORE requireConfirm so
    //    anon callers see the auth error rather than the confirm error.
    if (!auth.userId) {
      throw new Error(
        "update_fulfilment_order_status requires an authenticated user",
      );
    }

    // 2. Destructive confirm gate (canonical Phase 2+ pattern).
    //    sanitizeForResourceText caps length + strips control chars so a
    //    log-injection or copy-the-whole-row id/status doesn't echo back
    //    verbatim into the LLM-visible error text.
    try {
      requireConfirm(
        "update_fulfilment_order_status",
        args,
        `order ${JSON.stringify(sanitizeForResourceText(args.order_id))} → ` +
          `status ${JSON.stringify(sanitizeForResourceText(args.status))}`,
      );
    } catch (err) {
      if (err instanceof ConfirmationRequiredError) {
        return buildConfirmationRequiredResult(err);
      }
      throw err;
    }

    // 3. Per-order scope assertion (T-04-16) — refuse cross-tenant
    //    mutations BEFORE any PATCH lands. Runs AFTER confirm gate so a
    //    no-confirm caller never pays the scope-check round-trip either.
    //    Runs BEFORE the dry-run short-circuit so dry-run still
    //    fails-fast on out-of-scope orders (matches batch-factory
    //    semantics).
    await assertOrderOwned(auth, args.order_id, args.environment);

    // 4. Dry-run short-circuit (D-03 rich preview). Synthesize a payload
    //    shaped like what the real PATCH would return for a successful
    //    transition, with `dryRun: true` stamped on top.
    if (isDryRun(args)) {
      const preview = {
        dryRun: true,
        orderId: args.order_id,
        simulated: {
          ok: true,
          order_id: args.order_id,
          status: args.status,
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

    // 5. Real PATCH. Mint JWT, build the Platform API client, fire it.
    const jwt = await jwtFor(auth, args.environment);
    const client = new PlatformApiClient({
      jwt,
      environment: args.environment,
    });

    // encodeURIComponent for path-param hygiene (T-04-18).
    const data = await client.request(
      "PATCH",
      `/api/fulfilment/orders/${encodeURIComponent(args.order_id)}`,
      { body: { status: args.status } },
    );

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Updated fulfilment order ${args.order_id} status to "${args.status}".\n\n` +
            `Upstream response:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  },
};
