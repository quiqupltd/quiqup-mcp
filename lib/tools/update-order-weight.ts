/**
 * `update_order_weight` (ORDS-07) — update the weight (kg) on a single
 * Quiqup order via PATCH /quiqdash/orders/{orderId}/weight on
 * platform-api.quiqup.com.
 *
 * Endpoint: PATCH https://platform-api.quiqup.com/quiqdash/orders/{orderId}/weight
 *           Body:  { weight: <number-kg> }
 *           Auth:  Bearer <session-JWT>
 *
 * Wire-format note (per the 03-03 wire-format-translation precedent):
 *   The tool's input field is `weight_kg` (explicit unit in the agent-
 *   facing schema — "weight" alone is ambiguous between kg / lb / g and
 *   the Quiqdash UI labels it "kg"). The upstream body key is `weight`
 *   (no unit suffix — the unit is implicit at the BE). The handler
 *   translates `weight_kg` → `weight` on the outbound body. If the
 *   live-staging CALL-LOG (Task 3) shows the BE accepts `weight_kg`
 *   verbatim, the translation can be removed; until then, mirror what
 *   the Quiqdash frontend sends.
 *
 * Phase-4 / Wave-3 single-order mutation. Direct handler (no factory).
 *
 * NOT destructive-gated — this is a value-tune on a numeric attribute,
 * not a state mutation. The Phase-2 destructive contract is about
 * "would-not-want-to-undo" deletes / state-overwrites; correcting a
 * mis-entered weight is a routine operational task. The risk this
 * tool DOES carry is absurd-value abuse (T-04-14: "agent decides
 * weight is 999999kg"), so the `weight_kg` field has a sane range.
 *
 * Threat-register mitigation (T-04-14):
 *   `weight_kg: z.number().positive().max(1000)` — rejects zero,
 *   negative, and absurd values at Zod parse-time. 1000 kg is a
 *   generous cap (one-tonne parcels are well beyond Quiqup's standard
 *   last-mile capability); a heavier consignment requires a different
 *   product entirely and would route around this tool.
 *
 * Guardrails: 10/min rate-limit (non-destructive value-tune), idempotency
 * key for safe retry, audit on (affects downstream pricing / SLA).
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { PlatformApiClient } from "@/lib/clients/platform-api";
import { environmentField } from "@/lib/clients/quiqup-env";
import { jwtFor } from "@/lib/caller-auth";
import { assertOrderOwned } from "@/lib/caller-auth";

const inputSchema = z.object({
  order_id: z
    .string()
    .min(1)
    .describe(
      "Quiqup order id whose weight is being updated. Path-encoded by " +
        "the handler before the upstream PATCH.",
    ),
  weight_kg: z
    .number()
    .positive()
    .max(1000)
    .describe(
      "Order weight in kilograms. Must be strictly positive and " +
        "<= 1000 — outside this range is rejected client-side per the " +
        "T-04 threat register (T-04-14). Downstream pricing / SLA " +
        "calculations key off this value; absurd inputs would propagate " +
        "into bills and dispatch decisions.",
    ),
  idempotency_key: z
    .string()
    .optional()
    .describe(
      "Optional caller-supplied key to dedupe retries within a 15-minute " +
        "window. Recommended for safe at-least-once retries.",
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "update_order_weight",
  description:
    "Update the weight (kg) on a single Quiqup order. Endpoint: " +
    "PATCH /quiqdash/orders/{orderId}/weight (platform-api.quiqup.com). " +
    "Per-order scope-checked under the caller's session BEFORE the " +
    "PATCH runs (T-04-16). Weight must be > 0 and <= 1000 kg — outside " +
    "this range is rejected client-side per the T-04 threat register " +
    "(T-04-14). Affects downstream pricing / SLA calculations. " +
    "Wire-format note: the agent-facing field is `weight_kg` (explicit " +
    "unit), but the upstream body key is `weight` (unit implicit). The " +
    "handler translates on the outbound body — agents should always " +
    "pass `weight_kg`. " +
    "Idempotency: supply `idempotency_key` to make at-least-once " +
    "retries safe within 15 minutes. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 404 → " +
    "order not visible under your session (scope assertion catches this " +
    "before the PATCH); 4xx → BE rejected the new weight (e.g. order in " +
    "a non-editable state); 5xx → upstream temporarily unavailable, retry. " +
    'Example: `{ "order_id": "12345", "weight_kg": 2.5, "environment": "production" }`.',
  inputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 10, refillPerSec: 10 / 60 }, // 10/min — non-destructive value-tune
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    // 1. Auth gate (T-04-17 — outermost).
    if (!auth.userId) {
      throw new Error("update_order_weight requires an authenticated user");
    }

    // 2. Per-order scope assertion (T-04-16) — refuse cross-tenant
    //    weight edits BEFORE the PATCH lands.
    await assertOrderOwned(auth, args.order_id, args.environment);

    // 3. Mint JWT, build the Platform API client, fire the PATCH.
    const jwt = await jwtFor(auth, args.environment);
    const client = new PlatformApiClient({
      jwt,
      environment: args.environment,
    });

    // Wire-format: upstream key is `weight_kg` (confirmed by Wave-3
    // live-staging CALL-LOG — a request body `{ weight: 2.5 }` returns
    // HTTP 400 with `"weight_kg":["This field is required."]`). The
    // agent-facing schema key happens to match the wire key — no
    // translation needed.
    const data = await client.request(
      "PATCH",
      `/quiqdash/orders/${encodeURIComponent(args.order_id)}/weight`,
      { body: { weight_kg: args.weight_kg } },
    );

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Updated weight on order ${args.order_id} to ${args.weight_kg} kg.\n\n` +
            `Upstream response:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  },
};
