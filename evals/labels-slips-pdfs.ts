/**
 * Eval runner: labels-slips-pdfs-v1 — Phase-5 labels-slips-pdfs family.
 *
 * Hands each dataset item's natural-language merchant prompt to Claude
 * with all 3 Phase-5 PDF-download tools exposed and scores the resulting
 * tool_use block via ./score-labels-slips-pdfs.ts.
 *
 * Tools in the family:
 *   - download_pending_labels  (MISS-03, Quiqup-GraphQL-host)
 *   - download_return_label    (MISS-05, Quiqup-GraphQL-host)
 *   - download_slip            (MISS-06, Platform host)
 *
 * Drift-proofing: tool descriptions, input schemas, and tool names are
 * imported DIRECTLY from each production `spec` — no inline copies
 * (T-01-26 + 02-06 + 03-05 + 04-05 lesson). A description edit in
 * production is automatically reflected here.
 *
 * The score file includes FIVE Phase-5-specific STATIC scorers:
 *   - binary-envelope-contract-present  (readFile + assert { contentType,
 *       base64, filenameHint, resource, JSON.stringify } in all 3 tools)
 *   - auth-isolation-quiqup-graphql-host  (readFile + comment-strip +
 *       assert NO API-key tokens in quiqup-graphql-host.ts)
 *   - slip-type-enum-pin  (readFile + assert picking-list + packing-list +
 *       z.enum + MISS-06 in download-slip.ts)
 *   - no-guardrails-on-read-tools  (import specs + assert guardrails ===
 *       undefined on all 3)
 *   - quiqup-graphql-host-error-class-uniqueness  (readFile + assert
 *       QuiqupGraphqlHostError declared + no throw new QuiqupHttpError)
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
 * args-overlap >= 0.75, description-quality >= 1.0,
 * binary-envelope-contract-present >= 1.0,
 * auth-isolation-quiqup-graphql-host >= 1.0,
 * slip-type-enum-pin >= 1.0, no-guardrails-on-read-tools >= 1.0,
 * AND quiqup-graphql-host-error-class-uniqueness >= 1.0.
 *
 * Run: `bun run eval:labels-slips-pdfs`
 */

import {
  items,
  type LabelsSlipsPdfsInput,
  type LabelsSlipsPdfsExpected,
} from "./datasets/labels-slips-pdfs-v1";

import { spec as downloadPendingLabelsSpec } from "@/lib/tools/download-pending-labels";
import { spec as downloadReturnLabelSpec } from "@/lib/tools/download-return-label";
import { spec as downloadSlipSpec } from "@/lib/tools/download-slip";

if (process.env.EVAL_DRY_RUN === "1") {
  console.log(`labels-slips-pdfs-v1 dry-run: ${items.length} items`);
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

const { evaluators } = await import("./score-labels-slips-pdfs");

import type { ExperimentTask } from "@langfuse/client";

const MODEL = process.env.EVAL_MODEL ?? "claude-sonnet-4-6";

const otelSdk = new NodeSDK({
  spanProcessors: [new LangfuseSpanProcessor()],
  instrumentations: [new AnthropicInstrumentation()],
});
otelSdk.start();

const langfuse = new LangfuseClient();
const anthropic = new Anthropic();

// Multi-tool family eval — all 3 Phase-5 PDF-download tools are exposed.
// Tool specs imported directly from production modules (drift-proof).
const specs = [
  downloadPendingLabelsSpec,
  downloadReturnLabelSpec,
  downloadSlipSpec,
] as const;

const tools = specs.map((spec) => {
  const inputJsonSchema = z.toJSONSchema(spec.inputSchema, {
    target: "draft-07",
    io: "input",
  }) as Record<string, unknown>;
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
  LabelsSlipsPdfsInput,
  LabelsSlipsPdfsExpected
> = async (item) => {
  const input = (item as { input?: LabelsSlipsPdfsInput }).input;
  if (!input?.prompt) {
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
          "You are an operations assistant for a Quiqup partner. Translate " +
          "the merchant's request into a single Phase-5 PDF-download tool call. " +
          "Disambiguation guide:\n" +
          "  - All pending labels for the account (no order_id): use " +
          "`download_pending_labels`.\n" +
          "  - Return label for a specific order (order_id required): use " +
          "`download_return_label`.\n" +
          "  - Picking-list or packing-list slip for one or more orders " +
          "(slipType + order_ids required): use `download_slip`.\n" +
          "For environment: default to `production` unless staging is explicitly " +
          "requested.\n" +
          `Request: ${input.prompt}`,
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
  name: `phase5-labels-slips-pdfs-v1 (${MODEL})`,
  description:
    `Offline tool-call quality baseline for the Phase-5 labels-slips-pdfs ` +
    `family (download_pending_labels, download_return_label, download_slip) ` +
    `on ${MODEL}. ${items.length} hand-authored merchant prompts covering all ` +
    `3 tools, both slipType enum values, and both environments. Scored by ` +
    "tool-name-match, required-fields-present, args-overlap, " +
    "description-quality, plus 5 Phase-5 STATIC scorers locking the " +
    "binary-envelope contract (binary-envelope-contract-present — asserts " +
    "{ contentType, base64, filenameHint, resource, JSON.stringify } in all " +
    "3 tool files), auth-isolation (auth-isolation-quiqup-graphql-host — " +
    "comment-strip + assert no API-key tokens in quiqup-graphql-host.ts), " +
    "slipType enum (slip-type-enum-pin — assert picking-list + packing-list " +
    "+ z.enum + MISS-06 in download-slip.ts), read-tool no-guardrails " +
    "(no-guardrails-on-read-tools — assert spec.guardrails === undefined on " +
    "all 3), and error-class uniqueness " +
    "(quiqup-graphql-host-error-class-uniqueness — assert " +
    "QuiqupGraphqlHostError declared + no throw new QuiqupHttpError).",
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
    { scoreName: "args-overlap", min: 0.75 },
    { scoreName: "description-quality", min: 1.0 },
    { scoreName: "binary-envelope-contract-present", min: 1.0 },
    { scoreName: "auth-isolation-quiqup-graphql-host", min: 1.0 },
    { scoreName: "slip-type-enum-pin", min: 1.0 },
    { scoreName: "no-guardrails-on-read-tools", min: 1.0 },
    { scoreName: "quiqup-graphql-host-error-class-uniqueness", min: 1.0 },
  ]);
}
