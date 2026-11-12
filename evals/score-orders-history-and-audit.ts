/**
 * Scorers for the Phase-3 Quiqup REST history + Audit family eval
 * (orders-history-and-audit-v1).
 *
 * Five scorers feed Langfuse traces:
 *
 *   1. tool-name-match (0/1)            — accepts either a single expected
 *      tool name OR an array of acceptable tool names (the dataset has one
 *      disambiguation item where both tools are reasonable).
 *
 *   2. required-fields-present (0..1)   — per-tool rules:
 *        get_order_history       → order_id
 *        list_order_audit_events → order_uuid
 *
 *   3. args-overlap (0..1)              — wrapped from ./score-tool-call.ts.
 *
 *   4. description-quality (0..1)       — STATIC; per-tool substring
 *      checklist on production spec.description.
 *
 *   5. audit-sends-bearer (0/1)         — STATIC source-inspection;
 *      readFile()s `lib/clients/audit.ts`, STRIPS line + block comments
 *      (so a comment can't satisfy the check), and asserts the
 *      comment-stripped source still builds an Authorization header with
 *      a Bearer token. The Audit service requires the caller's Clerk
 *      token on every read (sc-30350): a client that stops sending it
 *      breaks order history for everyone.
 *
 * Lenient by design on tool-name + args; STRICT on the auth invariant.
 */

import type { Evaluator } from "@langfuse/client";

import { argsOverlap as _argsOverlap } from "./score-tool-call";

import { spec as getOrderHistorySpec } from "@/lib/tools/get-order-history";
import { spec as listOrderAuditEventsSpec } from "@/lib/tools/list-order-audit-events";

/**
 * Tool-name match — accepts either a single expected tool name OR an
 * array of acceptable names. The disambiguation item in the dataset uses
 * an array because both tools are reasonable for "everything that
 * happened to this order".
 */
export const toolNameMatch: Evaluator = async ({ output, expectedOutput }) => {
  const actual = (output as { tool?: string } | undefined)?.tool ?? null;
  const expected = (expectedOutput as { tool?: string | string[] } | undefined)
    ?.tool;
  const acceptable: string[] = Array.isArray(expected)
    ? expected
    : expected
      ? [expected]
      : [];
  const match = actual !== null && acceptable.includes(actual);
  return {
    name: "tool-name-match",
    value: match ? 1.0 : 0.0,
    comment: match
      ? `Called ${actual}`
      : `Expected one of [${acceptable.join(", ") || "<none>"}], got ${actual ?? "<no tool call>"}`,
  };
};

export const argsOverlap: Evaluator = async (ctx) => {
  const r = await _argsOverlap(ctx);
  return { ...r, name: "args-overlap" };
};

const REQUIRED_FIELDS: Record<string, readonly string[]> = {
  get_order_history: ["order_id"],
  list_order_audit_events: ["order_uuid"],
};

export const requiredFieldsPresent: Evaluator = async ({
  output,
  expectedOutput,
}) => {
  const args =
    (output as { args?: Record<string, unknown> } | undefined)?.args ?? {};
  const expectedTool =
    (expectedOutput as { tool?: string | string[] } | undefined)?.tool;
  // For the disambiguation case (array of acceptable tools), score against
  // whichever tool the agent actually picked.
  const actualTool = (output as { tool?: string } | undefined)?.tool ?? null;
  const toolKey =
    actualTool && REQUIRED_FIELDS[actualTool]
      ? actualTool
      : typeof expectedTool === "string"
        ? expectedTool
        : Array.isArray(expectedTool) && expectedTool[0]
          ? expectedTool[0]
          : null;
  const required = toolKey ? REQUIRED_FIELDS[toolKey] ?? [] : [];
  if (required.length === 0) {
    return {
      name: "required-fields-present",
      value: 1.0,
      comment: `no required args for ${toolKey ?? "<unknown>"}`,
    };
  }
  const present = required.filter((k) => k in args);
  return {
    name: "required-fields-present",
    value: present.length / required.length,
    comment: `${present.length}/${required.length}: [${present.join(", ")}]`,
  };
};

interface DescriptionCheck {
  spec: { name: string; description: string };
  substrings: string[];
}

const DESCRIPTION_CHECKS: DescriptionCheck[] = [
  {
    spec: getOrderHistorySpec,
    substrings: [
      // Endpoint marker.
      "/orders/{id}/history",
      // Error-modes section.
      "401",
      // Cross-tool disambiguation — must mention the companion tool.
      "list_order_audit_events",
      // Canonical example block.
      "Example:",
    ],
  },
  {
    spec: listOrderAuditEventsSpec,
    substrings: [
      // Endpoint marker.
      "/events?resourceID.eq={orderUuid}",
      // Cross-tool disambiguation.
      "get_order_history",
      // Auth language — description MUST tell the LLM the caller's
      // Clerk token is forwarded as a Bearer token and that results are
      // scoped to the caller (see lib/tools/list-order-audit-events.ts).
      "Bearer token",
      // Canonical example block.
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

/**
 * STATIC source-inspection: audit-sends-bearer.
 *
 * Reads lib/clients/audit.ts, STRIPS line + block comments (the file
 * header explains the Authorization header, and a comment must not be
 * able to satisfy the check), and asserts the remaining code builds an
 * `Authorization` header from a `Bearer ` token.
 *
 * Inverse of the Google Places auth-isolation scorer: Audit used to be
 * a no-Bearer client, and requires the caller's Clerk token since
 * sc-30350. A maintainer cannot drop the header without simultaneously
 * editing this scorer.
 */
const AUDIT_CLIENT_SOURCE_PATH = "lib/clients/audit.ts";

/**
 * Strip /* ... *​/ block comments AND // line comments from a TS source
 * string. Deliberately a regex-only pass, not a real TS parser — the
 * client unit test catches anything this misses.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/.*$/gm, "$1"); // line comments (skip protocol-//-)
}

// The header assignment must appear on ONE line of non-comment code
// (`Authorization: \`Bearer ${...}\``). Checking for the two words anywhere
// in the file would pass on unrelated identifiers like `authorizationKey` +
// `"bearer x"` while the client sends no header at all.
const AUTH_HEADER_LINE = /authorization["']?\s*:\s*[`"']bearer \$\{/;

export const auditSendsBearer: Evaluator = async () => {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");

  let raw: string;
  try {
    raw = await readFile(
      path.resolve(process.cwd(), AUDIT_CLIENT_SOURCE_PATH),
      "utf-8",
    );
  } catch (err) {
    return {
      name: "audit-sends-bearer",
      value: 0.0,
      comment: `read failed for ${AUDIT_CLIENT_SOURCE_PATH}: ${(err as Error).message}`,
    };
  }

  const code = stripComments(raw).toLowerCase();
  const failures: string[] = [];
  if (!code.split("\n").some((line) => AUTH_HEADER_LINE.test(line))) {
    failures.push(
      `${AUDIT_CLIENT_SOURCE_PATH}: no non-comment line builds an Authorization: \`Bearer \${...}\` header`,
    );
  }

  return {
    name: "audit-sends-bearer",
    value: failures.length === 0 ? 1.0 : 0.0,
    comment:
      failures.length === 0
        ? "audit.ts (sans comments) sends an Authorization: Bearer header"
        : `failures: ${failures.join("; ")}`,
  };
};

export const evaluators = [
  toolNameMatch,
  requiredFieldsPresent,
  argsOverlap,
  descriptionQuality,
  auditSendsBearer,
];
