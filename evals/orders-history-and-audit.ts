/**
 * Eval runner: orders-history-and-audit-v1 — Phase-3 Quiqup REST history
 * + Audit families (combined; both anchor on order-detail reads, mirroring
 * the Phase-2 sub-family grouping rationale).
 *
 * Hands each dataset item's natural-language merchant question to Claude
 * with the 2 Phase-3 tools exposed (get_order_history,
 * list_order_audit_events) and scores the resulting tool_use block via
 * ./score-orders-history-and-audit.ts.
 *
 * Drift-proofing: tool descriptions are imported DIRECTLY from each
 * production `spec` (no inline copies — T-01-26 + 02-06 lesson).
 *
 * The score file includes a STATIC source-inspection scorer
 * (audit-sends-bearer) that readFile()s `lib/clients/audit.ts` and locks
 * the Authorization header at the eval-gate layer — the Audit service
 * requires the caller's Clerk token (sc-30350), so a maintainer cannot
 * drop it from the client without simultaneously editing this score file.
 *
 * Offline: does NOT hit the Quiqup API.
 *
 * Env vars (auto-loaded by bun from .env.local):
 *   LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL
 *   ANTHROPIC_API_KEY
 *
 * Dry-run: set EVAL_DRY_RUN=1 to print item count and exit.
 *
 * CI gate: set EVAL_GATE=1 to enforce tool-name-match >= 0.75,
 * args-overlap >= 0.7, description-quality >= 1.0, AND
 * audit-sends-bearer >= 1.0 at the end.
 *
 * Run: `bun run eval:orders-history-and-audit`
 */

import {
  items,
  TODAY,
  type OrdersHistoryAndAuditInput,
  type OrdersHistoryAndAuditExpected,
} from "./datasets/orders-history-and-audit-v1";

import { spec as getOrderHistorySpec } from "@/lib/tools/get-order-history";
import { spec as listOrderAuditEventsSpec } from "@/lib/tools/list-order-audit-events";

if (process.env.EVAL_DRY_RUN === "1") {
  console.log(
    `orders-history-and-audit-v1 dry-run: ${items.length} items (TODAY=${TODAY})`,
  );
  process.exit(0);
}

const { NodeSDK } = await import("@opentelemetry/sdk-node");
const { LangfuseSpanProcessor } = await import("@langfuse/otel");
const { LangfuseClient } = await import("@langfuse/client");
const { AnthropicInstrumentation } = await import(
  "@arizeai/openinference-instrumentation-anthropic"
);
const Anthropic = (await import("@anthropic-ai/sdk")).default;
const { z } = await import("zod");

const { evaluators } = await import("./score-orders-history-and-audit");

import type { ExperimentTask } from "@langfuse/client";

const MODEL = process.env.EVAL_MODEL ?? "claude-sonnet-4-6";

const otelSdk = new NodeSDK({
  spanProcessors: [new LangfuseSpanProcessor()],
  instrumentations: [new AnthropicInstrumentation()],
});
otelSdk.start();

const langfuse = new LangfuseClient();
const anthropic = new Anthropic();

const specs = [getOrderHistorySpec, listOrderAuditEventsSpec] as const;

const tools = specs.map((spec) => {
  const inputJsonSchema = z.toJSONSchema(spec.inputSchema, {
    target: "draft-07",
    io: "input",
  }) as Record<string, unknown>;
  // Pull description straight from the production `spec.description` — the
  // whole point of this drift-proofing approach. spec.name + spec.inputSchema
  // similarly come from the live production source, never inline copies.
  return {
    name: spec.name,
    description: spec.description,
    input_schema: { ...inputJsonSchema, type: "object" as const },
  };
});

interface TaskOutput {
  tool: string | null;
  args: Record<string, unknown> | null;
}

const task: ExperimentTask<
  OrdersHistoryAndAuditInput,
  OrdersHistoryAndAuditExpected
> = async (item) => {
  const input = (item as { input?: OrdersHistoryAndAuditInput }).input;
  if (!input?.request) {
    return { tool: null, args: null } satisfies TaskOutput;
  }
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    tools,
    tool_choice: { type: "any" },
    messages: [
      {
        role: "user",
        content:
          "You are an operations assistant for a Quiqup partner (Dubai-based " +
          "merchant). Translate the merchant's question into the single most " +
          "appropriate Phase-3 order-detail-read tool call. Disambiguation:\n" +
          "  - `get_order_history`       → STATE-TRANSITION timeline (when did " +
          "the order go from pending → live → delivered, by which operator, " +
          "with which on-hold/return reason). Takes a clientOrderID string. " +
          "Source: Quiqup REST GET /orders/{id}/history.\n" +
          "  - `list_order_audit_events` → FIELD-LEVEL audit log (who edited " +
          "the address, when, before/after diff). Takes an order UUID. " +
          "Source: Audit service GET /events.\n" +
          "If the input clearly looks like a small numeric clientOrderID, " +
          "prefer get_order_history. If it's a full UUID, prefer " +
          "list_order_audit_events. " +
          "Use sensible defaults for unspecified fields. " +
          `Today's date is ${TODAY} (UTC).\n\n` +
          `Question: ${input.request}`,
      },
    ],
  });

  const block = res.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    return { tool: null, args: null } satisfies TaskOutput;
  }
  return {
    tool: block.name,
    args: block.input as Record<string, unknown>,
  } satisfies TaskOutput;
};

const result = await langfuse.experiment.run({
  name: `phase3-orders-history-and-audit-v1 (${MODEL})`,
  description:
    `Offline tool-call quality baseline for the Phase-3 Quiqup REST history + ` +
    `Audit families on ${MODEL}. ${items.length} hand-authored merchant ` +
    `questions, frozen TODAY=${TODAY}. Scored by tool-name-match (accepts ` +
    "array-of-acceptable for the disambiguation prompt), " +
    "required-fields-present (per-tool: order_id / order_uuid), args-overlap, " +
    "description-quality, and audit-sends-bearer (STATIC; readFile + " +
    "comment-strip + assert Authorization/Bearer in non-comment code of " +
    "lib/clients/audit.ts).",
  data: items,
  task,
  evaluators,
});

console.log(await result.format());

await langfuse.shutdown();
await otelSdk.shutdown();

// CI gate (opt-in via EVAL_GATE=1; no-op locally).
if (process.env.EVAL_GATE === "1") {
  const { gate } = await import("./gate");
  gate(result, [
    { scoreName: "tool-name-match", min: 0.75 },
    { scoreName: "args-overlap", min: 0.7 },
    { scoreName: "description-quality", min: 1.0 },
    { scoreName: "audit-sends-bearer", min: 1.0 },
  ]);
}
