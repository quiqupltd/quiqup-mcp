/**
 * Scorers for the Phase-5 labels-slips-pdfs family eval
 * (labels-slips-pdfs-v1).
 *
 * Nine scorers feed Langfuse traces:
 *
 * Standard scorers (4):
 *   1. tool-name-match (0/1)            — did the LLM pick the right
 *      Phase-5 PDF-download tool? Reads expectedOutput.toolName (not
 *      expectedOutput.tool — the Phase-5 dataset shape uses toolName).
 *
 *   2. required-fields-present (0..1)   — per-tool rules:
 *        download_pending_labels  → environment
 *        download_return_label    → order_id, environment
 *        download_slip            → slipType, order_ids, environment
 *      Reports proportion present.
 *
 *   3. args-overlap (0..1)              — leaf-level overlap with
 *      expectedOutput.argsSubset (Phase-5 dataset shape uses argsSubset).
 *      threshold: 0.75 (calibrated for non-destructive read families per
 *      03-05 / 04-05 pattern).
 *
 *   4. description-quality (0..1)       — STATIC; per-tool substring
 *      checklist on production spec.description (endpoint marker,
 *      binary-envelope keywords, error modes, canonical Example block).
 *      Length >= 200 chars. Score is proportion-of-assertions-passed.
 *
 * Phase-5-specific STATIC scorers (5 — all item-independent):
 *   5. binary-envelope-contract-present (0/1) — readFileSync all 3 Phase-5
 *      tool files; strip comments; assert `contentType`, `base64`,
 *      `filenameHint`, `resource` (resource block), and `JSON.stringify`
 *      all co-occur in every file. Locks the canonical dual-block
 *      resource+text envelope contract across the entire Phase-5 family
 *      (T-05-22).
 *
 *   6. auth-isolation-quiqup-graphql-host (0/1) — readFileSync
 *      `lib/clients/quiqup-graphql-host.ts`; strip comments; assert ZERO
 *      occurrences of `X-Goog-Api-Key`, `api_key`, `apiKey`, `apikey`.
 *      Locks T-05-21 — the new Quiqup-GraphQL-host IS NOT an auth-exception
 *      (mirrors Phase-1 lookup-google-place + Phase-3 audit-no-bearer
 *      scorers).
 *
 *   7. slip-type-enum-pin (0/1)         — readFileSync
 *      `lib/tools/download-slip.ts`; strip comments; assert `picking-list`,
 *      `packing-list`, `z.enum`, AND `MISS-06` all co-occur. Locks MISS-06's
 *      slipType at the schema layer per source-doc §19 H line 4734 (T-05-23).
 *
 *   8. no-guardrails-on-read-tools (0/1) — imports all 3 Phase-5 production
 *      specs; asserts `spec.guardrails === undefined` on every one. Locks the
 *      read-tool no-guardrails convention per download_orders_export precedent
 *      + Wave-1/2/3 plans (T-05-24).
 *
 *   9. quiqup-graphql-host-error-class-uniqueness (0/1) — readFileSync
 *      `lib/clients/quiqup-graphql-host.ts`; strip comments; assert BOTH:
 *        - `export class QuiqupGraphqlHostError` IS present (new class declared)
 *        - `throw new QuiqupHttpError` does NOT appear (new host throws its
 *          own class, NOT the reused Quiqup-prefixed one per STATE.md decision
 *          2026-05-20 03-04). Locks T-05-25.
 *
 * Lenient by design on tool-name + args; STRICT on the binary-envelope,
 * auth-isolation, slipType enum, no-guardrails, and error-class invariants.
 *
 * Dataset field naming note: the Phase-5 dataset uses `expectedOutput.toolName`
 * (not `.tool`) and `expectedOutput.argsSubset` (not `.args`). These scorers
 * read those field names consistently.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";

import type { Evaluator } from "@langfuse/client";

import { argsOverlap as _argsOverlap } from "./score-tool-call";

import { spec as downloadPendingLabelsSpec } from "@/lib/tools/download-pending-labels";
import { spec as downloadReturnLabelSpec } from "@/lib/tools/download-return-label";
import { spec as downloadSlipSpec } from "@/lib/tools/download-slip";

// ────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Strip block and line comments from TypeScript source before substring
 * inspection. Mirrors the approach in score-lookup-google-place.ts and
 * score-orders-history-and-audit.ts — prevents false positives against
 * header comments that legitimately MENTION the forbidden identifiers in
 * order to document a design decision.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/.*$/gm, "$1"); // line comments (skip protocol-//-)
}

// ────────────────────────────────────────────────────────────────────────────
// 1. tool-name-match
// ────────────────────────────────────────────────────────────────────────────

/**
 * Phase-5 variant: reads `expectedOutput.toolName` (not `.tool`) to match
 * the Phase-5 dataset shape.
 */
export const toolNameMatch: Evaluator = async ({ output, expectedOutput }) => {
  const actual = (output as { tool?: string } | undefined)?.tool ?? null;
  // Phase-5 dataset uses `toolName` rather than `tool`.
  const expected =
    (expectedOutput as { toolName?: string } | undefined)?.toolName ?? null;
  const match = actual !== null && actual === expected;
  return {
    name: "tool-name-match",
    value: match ? 1.0 : 0.0,
    comment: match
      ? `Called ${actual}`
      : `Expected ${expected ?? "<none>"}, got ${actual ?? "<no tool call>"}`,
  };
};

// ────────────────────────────────────────────────────────────────────────────
// 2. required-fields-present
// ────────────────────────────────────────────────────────────────────────────

const REQUIRED_FIELDS: Record<string, readonly string[]> = {
  download_pending_labels: ["environment"],
  download_return_label: ["order_id", "environment"],
  download_slip: ["slipType", "order_ids", "environment"],
};

export const requiredFieldsPresent: Evaluator = async ({
  output,
  expectedOutput,
}) => {
  const args =
    (output as { args?: Record<string, unknown> } | undefined)?.args ?? {};
  // Phase-5 dataset uses `toolName`.
  const expectedTool =
    (expectedOutput as { toolName?: string } | undefined)?.toolName ?? null;
  const required = expectedTool ? (REQUIRED_FIELDS[expectedTool] ?? []) : [];
  if (required.length === 0) {
    return {
      name: "required-fields-present",
      value: 1.0,
      comment: `no required args for ${expectedTool ?? "<unknown>"}`,
    };
  }
  const present = required.filter((k) => k in args);
  return {
    name: "required-fields-present",
    value: present.length / required.length,
    comment: `${present.length}/${required.length}: [${present.join(", ")}]`,
  };
};

// ────────────────────────────────────────────────────────────────────────────
// 3. args-overlap
// ────────────────────────────────────────────────────────────────────────────

/**
 * Phase-5 variant: remaps `expectedOutput.argsSubset` → `expectedOutput.args`
 * before delegating to the shared `_argsOverlap` scorer which reads `.args`.
 */
export const argsOverlap: Evaluator = async (ctx) => {
  // The shared scorer reads `expectedOutput.args`; Phase-5 dataset uses
  // `argsSubset`. Inject a normalised `args` key for the delegate call.
  const rawExpected = ctx.expectedOutput as
    | { argsSubset?: unknown; args?: unknown }
    | undefined;
  const normalisedCtx = {
    ...ctx,
    expectedOutput: {
      ...rawExpected,
      args: rawExpected?.argsSubset ?? rawExpected?.args ?? {},
    },
  };
  const r = await _argsOverlap(normalisedCtx);
  return { ...r, name: "args-overlap" };
};

// ────────────────────────────────────────────────────────────────────────────
// 4. description-quality
// ────────────────────────────────────────────────────────────────────────────

interface DescriptionCheck {
  spec: { name: string; description: string };
  substrings: string[];
}

/**
 * STATIC — item-independent. Asserts the production spec.description of
 * each Phase-5 tool is >= 200 chars and contains the listed substrings.
 * Imports specs directly so description edits in production are
 * automatically reflected here (drift-proof per STATE.md decision 01-04).
 */
const DESCRIPTION_CHECKS: DescriptionCheck[] = [
  {
    spec: downloadPendingLabelsSpec,
    substrings: [
      // Endpoint marker.
      "/pending_orders_labels",
      // Binary-envelope contract keywords — description MUST surface the
      // envelope shape so the LLM knows the return is base64, not parsed JSON.
      "contentType",
      "base64",
      "filenameHint",
      // Error-modes section (min. one auth-related error code).
      "401",
      // Canonical Example block.
      "Example:",
    ],
  },
  {
    spec: downloadReturnLabelSpec,
    substrings: [
      // Endpoint marker.
      "/return_order_label/",
      // Binary-envelope keywords.
      "contentType",
      "base64",
      "filenameHint",
      // Error-modes section.
      "401",
      // Canonical Example block.
      "Example:",
    ],
  },
  {
    spec: downloadSlipSpec,
    substrings: [
      // Endpoint marker.
      "/slips/",
      // slipType enum values — description MUST name both literal values.
      "picking-list",
      "packing-list",
      // Binary-envelope keywords.
      "contentType",
      "base64",
      "filenameHint",
      // Error-modes section.
      "401",
      // Canonical Example block.
      "Example:",
    ],
  },
];

const MIN_DESCRIPTION_LENGTH = 200;

export const descriptionQuality: Evaluator = async () => {
  const failures: string[] = [];
  let total = 0;
  let passed = 0;
  for (const check of DESCRIPTION_CHECKS) {
    const desc = check.spec.description;
    total += 1;
    if (desc.length >= MIN_DESCRIPTION_LENGTH) {
      passed += 1;
    } else {
      failures.push(
        `${check.spec.name}: description length ${desc.length} < ${MIN_DESCRIPTION_LENGTH}`,
      );
    }
    for (const sub of check.substrings) {
      total += 1;
      if (desc.includes(sub)) {
        passed += 1;
      } else {
        failures.push(`${check.spec.name}: description missing "${sub}"`);
      }
    }
  }
  return {
    name: "description-quality",
    value: total > 0 ? passed / total : 0,
    comment:
      failures.length === 0
        ? `${passed}/${total} description assertions passed`
        : `${passed}/${total}; failures: ${failures.join("; ")}`,
  };
};

// ────────────────────────────────────────────────────────────────────────────
// 5. binary-envelope-contract-present  (STATIC)
// ────────────────────────────────────────────────────────────────────────────

/**
 * STATIC source-inspection: asserts the canonical dual-block envelope
 * contract is intact in all 3 Phase-5 tool files. Reads each file via
 * readFileSync, strips comments, and asserts ALL FIVE substrings are
 * present in every file:
 *   - `contentType`    — part of the { contentType, base64, filenameHint } envelope
 *   - `base64`         — the binary payload key
 *   - `filenameHint`   — the tool-added metadata key
 *   - `resource`       — the MCP resource-block type literal (confirms the dual-block shape)
 *   - `JSON.stringify` — the text-block companion (the metadata JSON envelope)
 *
 * A future refactor that drops the resource block in favour of a text-only
 * envelope (the pre-03-04 footgun at lib/tools/register.ts:108) trips this
 * scorer immediately (T-05-22).
 */
const PHASE5_TOOL_SOURCE_PATHS = [
  "lib/tools/download-pending-labels.ts",
  "lib/tools/download-return-label.ts",
  "lib/tools/download-slip.ts",
] as const;

const BINARY_ENVELOPE_SUBSTRINGS = [
  "contentType",
  "base64",
  "filenameHint",
  "resource",
  "JSON.stringify",
] as const;

export const binaryEnvelopeContractPresent: Evaluator = async () => {
  const failures: string[] = [];

  for (const relPath of PHASE5_TOOL_SOURCE_PATHS) {
    let raw: string;
    try {
      raw = readFileSync(path.resolve(process.cwd(), relPath), "utf-8");
    } catch (err) {
      failures.push(
        `read failed for ${relPath}: ${(err as Error).message}`,
      );
      continue;
    }

    const code = stripComments(raw);
    for (const sub of BINARY_ENVELOPE_SUBSTRINGS) {
      if (!code.includes(sub)) {
        failures.push(
          `${relPath}: missing "${sub}" — binary-envelope-contract-present failed ` +
            `(dropping this key would break the canonical Phase-5 dual-block resource+text ` +
            `envelope contract; Phase 7/10 tools will silently regress too)`,
        );
      }
    }
  }

  return {
    name: "binary-envelope-contract-present",
    value: failures.length === 0 ? 1.0 : 0.0,
    comment:
      failures.length === 0
        ? `All 3 Phase-5 tool files contain the canonical { contentType, base64, ` +
          `filenameHint } envelope + resource block + JSON.stringify — T-05-22 contract holds`
        : `failures: ${failures.join("; ")}`,
  };
};

// ────────────────────────────────────────────────────────────────────────────
// 6. auth-isolation-quiqup-graphql-host  (STATIC)
// ────────────────────────────────────────────────────────────────────────────

/**
 * STATIC source-inspection: reads `lib/clients/quiqup-graphql-host.ts`,
 * strips comments, and asserts the comment-stripped source contains ZERO
 * occurrences of API-key identifiers.
 *
 * Forbidden substrings (case-insensitive where noted):
 *   - X-Goog-Api-Key  (Google Places API key header)
 *   - api_key         (generic key param)
 *   - apiKey          (camelCase variant)
 *   - apikey          (all-lowercase, case-insensitive check)
 *
 * The Quiqup-GraphQL-host IS a first-party Quiqup service; it uses the
 * standard Bearer JWT path, NOT the Google API-key exception pattern.
 * Any non-comment occurrence of these substrings indicates a regression
 * toward an auth-exception pattern that must be reviewed (T-05-21).
 *
 * Mirrors: Phase-1 `auth-isolation` scorer in score-lookup-google-place.ts
 * and the Phase-3 `audit-no-bearer` scorer in score-orders-history-and-audit.ts.
 */
const GRAPHQL_HOST_CLIENT_PATH = "lib/clients/quiqup-graphql-host.ts";

const FORBIDDEN_API_KEY_SUBSTRINGS = [
  "X-Goog-Api-Key",
  "api_key",
  "apiKey",
] as const;

export const authIsolationQuiqupGraphqlHost: Evaluator = async () => {
  let raw: string;
  try {
    raw = readFileSync(
      path.resolve(process.cwd(), GRAPHQL_HOST_CLIENT_PATH),
      "utf-8",
    );
  } catch (err) {
    return {
      name: "auth-isolation-quiqup-graphql-host",
      value: 0.0,
      comment: `read failed for ${GRAPHQL_HOST_CLIENT_PATH}: ${(err as Error).message}`,
    };
  }

  const code = stripComments(raw);
  const failures: string[] = [];

  // Case-sensitive checks for the documented variants.
  for (const sub of FORBIDDEN_API_KEY_SUBSTRINGS) {
    if (code.includes(sub)) {
      failures.push(
        `${GRAPHQL_HOST_CLIENT_PATH}: must not contain "${sub}" in non-comment ` +
          `code — Quiqup-GraphQL-host IS NOT an auth-exception client (T-05-21)`,
      );
    }
  }
  // Case-insensitive check for `apikey` (covers `APIKEY`, `ApiKey`, etc.).
  if (code.toLowerCase().includes("apikey")) {
    // Only trip if not already caught by the case-sensitive `apiKey` check.
    if (!code.includes("apiKey")) {
      failures.push(
        `${GRAPHQL_HOST_CLIENT_PATH}: case-insensitive match for "apikey" found in ` +
          `non-comment code — Quiqup-GraphQL-host IS NOT an auth-exception client (T-05-21)`,
      );
    }
  }

  return {
    name: "auth-isolation-quiqup-graphql-host",
    value: failures.length === 0 ? 1.0 : 0.0,
    comment:
      failures.length === 0
        ? `${GRAPHQL_HOST_CLIENT_PATH} (sans comments) is free of API-key identifiers ` +
          `— auth-isolation holds; Quiqup-GraphQL-host uses Bearer JWT (T-05-21)`
        : `failures: ${failures.join("; ")}`,
  };
};

// ────────────────────────────────────────────────────────────────────────────
// 7. slip-type-enum-pin  (STATIC)
// ────────────────────────────────────────────────────────────────────────────

/**
 * STATIC source-inspection: reads `lib/tools/download-slip.ts`, strips
 * comments, and asserts ALL FOUR substrings co-occur in the comment-stripped
 * source:
 *   - `picking-list`  — one of the two documented slipType enum values
 *   - `packing-list`  — the other documented slipType enum value
 *   - `z.enum`        — confirms the enum is locked at the Zod schema layer
 *   - `MISS-06`       — requirement tag (ensures the tie to source-doc §19 H
 *                       line 4734 is visible in the source file)
 *
 * A maintainer broadening slipType to `z.string()` to support an undocumented
 * `manifest` or similar value trips this scorer immediately (T-05-23).
 */
const SLIP_TOOL_SOURCE_PATH = "lib/tools/download-slip.ts";

const SLIP_ENUM_SUBSTRINGS = [
  "picking-list",
  "packing-list",
  "z.enum",
  "MISS-06",
] as const;

export const slipTypeEnumPin: Evaluator = async () => {
  let raw: string;
  try {
    raw = readFileSync(
      path.resolve(process.cwd(), SLIP_TOOL_SOURCE_PATH),
      "utf-8",
    );
  } catch (err) {
    return {
      name: "slip-type-enum-pin",
      value: 0.0,
      comment: `read failed for ${SLIP_TOOL_SOURCE_PATH}: ${(err as Error).message}`,
    };
  }

  const code = stripComments(raw);
  const failures: string[] = [];
  for (const sub of SLIP_ENUM_SUBSTRINGS) {
    if (!code.includes(sub)) {
      failures.push(
        `${SLIP_TOOL_SOURCE_PATH}: missing "${sub}" — slip-type-enum-pin failed ` +
          `(the slipType enum must contain both "picking-list" and "packing-list" ` +
          `via z.enum, tied to MISS-06; source-doc §19 H line 4734 — T-05-23)`,
      );
    }
  }

  return {
    name: "slip-type-enum-pin",
    value: failures.length === 0 ? 1.0 : 0.0,
    comment:
      failures.length === 0
        ? `${SLIP_TOOL_SOURCE_PATH} pins slipType as z.enum(["picking-list", "packing-list"]) ` +
          `with MISS-06 tag — T-05-23 contract holds`
        : `failures: ${failures.join("; ")}`,
  };
};

// ────────────────────────────────────────────────────────────────────────────
// 8. no-guardrails-on-read-tools  (STATIC)
// ────────────────────────────────────────────────────────────────────────────

/**
 * STATIC: imports all 3 Phase-5 production specs and asserts
 * `spec.guardrails === undefined` on each one.
 *
 * Locks the read-tool no-guardrails convention per:
 *   - `download_orders_export` precedent (Phase 3 — the anchor read tool)
 *   - Wave-1/2/3 plans (05-01..05-03 PLAN.md — all explicitly document
 *     "No guardrails block — read-only tool")
 *
 * A legitimate decision to ADD guardrails — e.g. if PII redaction lands
 * at audit time — would require flipping this scorer intentionally;
 * that is the desired behaviour, not a footgun (T-05-24).
 */
export const noGuardrailsOnReadTools: Evaluator = async () => {
  const specs = [
    { name: downloadPendingLabelsSpec.name, spec: downloadPendingLabelsSpec },
    { name: downloadReturnLabelSpec.name, spec: downloadReturnLabelSpec },
    { name: downloadSlipSpec.name, spec: downloadSlipSpec },
  ];

  const failures: string[] = [];
  for (const { name, spec } of specs) {
    if ((spec as unknown as { guardrails?: unknown }).guardrails !== undefined) {
      failures.push(
        `${name}: spec.guardrails is not undefined — read tools MUST omit the ` +
          `guardrails block (matches download_orders_export + Wave-1/2/3 precedent). ` +
          `If adding guardrails is intentional (e.g. PII redaction), flip this scorer (T-05-24)`,
      );
    }
  }

  return {
    name: "no-guardrails-on-read-tools",
    value: failures.length === 0 ? 1.0 : 0.0,
    comment:
      failures.length === 0
        ? `All 3 Phase-5 read tools have spec.guardrails === undefined ` +
          `— T-05-24 read-tool no-guardrails convention holds`
        : `failures: ${failures.join("; ")}`,
  };
};

// ────────────────────────────────────────────────────────────────────────────
// 9. quiqup-graphql-host-error-class-uniqueness  (STATIC)
// ────────────────────────────────────────────────────────────────────────────

/**
 * STATIC source-inspection: reads `lib/clients/quiqup-graphql-host.ts`,
 * strips comments, and asserts BOTH conditions:
 *
 *   1. `export class QuiqupGraphqlHostError` IS present — the new error
 *      class MUST be declared and exported. A rename or accidental removal
 *      trips this scorer.
 *
 *   2. `throw new QuiqupHttpError` does NOT appear in the comment-stripped
 *      source — the new host MUST throw its OWN class, NOT reuse the
 *      Quiqup-prefixed one. Per STATE.md decision 2026-05-20 03-04:
 *      "NEW service-host families get their OWN error class". The
 *      `QuiqupHttpError` reuse is only correct for sibling clients of an
 *      EXISTING host family (T-05-25).
 */
const REQUIRED_ERROR_CLASS_DECLARATION = "export class QuiqupGraphqlHostError";
const FORBIDDEN_ERROR_THROW = "throw new QuiqupHttpError";

export const quiqupGraphqlHostErrorClassUniqueness: Evaluator = async () => {
  let raw: string;
  try {
    raw = readFileSync(
      path.resolve(process.cwd(), GRAPHQL_HOST_CLIENT_PATH),
      "utf-8",
    );
  } catch (err) {
    return {
      name: "quiqup-graphql-host-error-class-uniqueness",
      value: 0.0,
      comment: `read failed for ${GRAPHQL_HOST_CLIENT_PATH}: ${(err as Error).message}`,
    };
  }

  const code = stripComments(raw);
  const failures: string[] = [];

  // Assertion 1: the new error class MUST be declared.
  if (!code.includes(REQUIRED_ERROR_CLASS_DECLARATION)) {
    failures.push(
      `${GRAPHQL_HOST_CLIENT_PATH}: "${REQUIRED_ERROR_CLASS_DECLARATION}" not found ` +
        `— the QuiqupGraphqlHostError class MUST be declared and exported ` +
        `(STATE.md decision 2026-05-20 03-04 — new service-host families get ` +
        `their own error class; T-05-25)`,
    );
  }

  // Assertion 2: the host MUST NOT throw QuiqupHttpError.
  if (code.includes(FORBIDDEN_ERROR_THROW)) {
    failures.push(
      `${GRAPHQL_HOST_CLIENT_PATH}: "${FORBIDDEN_ERROR_THROW}" found in ` +
        `non-comment code — the Quiqup-GraphQL-host MUST throw QuiqupGraphqlHostError, ` +
        `NOT reuse QuiqupHttpError (STATE.md decision 2026-05-20 03-04; T-05-25)`,
    );
  }

  return {
    name: "quiqup-graphql-host-error-class-uniqueness",
    value: failures.length === 0 ? 1.0 : 0.0,
    comment:
      failures.length === 0
        ? `${GRAPHQL_HOST_CLIENT_PATH} (sans comments) declares QuiqupGraphqlHostError ` +
          `AND contains no "throw new QuiqupHttpError" — T-05-25 error-class uniqueness holds`
        : `failures: ${failures.join("; ")}`,
  };
};

// ────────────────────────────────────────────────────────────────────────────
// Exported evaluator array (order matches plan spec: 4 standard + 5 STATIC)
// ────────────────────────────────────────────────────────────────────────────

export const evaluators = [
  toolNameMatch,
  requiredFieldsPresent,
  argsOverlap,
  descriptionQuality,
  binaryEnvelopeContractPresent,
  authIsolationQuiqupGraphqlHost,
  slipTypeEnumPin,
  noGuardrailsOnReadTools,
  quiqupGraphqlHostErrorClassUniqueness,
];
