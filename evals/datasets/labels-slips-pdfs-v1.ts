/**
 * labels-slips-pdfs-v1 — first eval dataset for the Phase-5
 * labels-slips-pdfs family.
 *
 * Coverage: all 3 Phase-5 PDF-download tools:
 *   - download_pending_labels  (MISS-03, Quiqup-GraphQL-host)
 *   - download_return_label    (MISS-05, Quiqup-GraphQL-host)
 *   - download_slip            (MISS-06, Platform host, slipType z.enum-pinned)
 *
 * 12 items total (4 per tool). Each item exercises a distinct natural-language
 * phrasing, a combination of the two environments (production / staging), and
 * for download_slip both slipType enum values (picking-list / packing-list).
 *
 * Scored by ../score-labels-slips-pdfs.ts — drift-proof spec imports +
 * 5 STATIC scorers that lock the Phase-5 invariants at the CI layer.
 *
 * Tool-side reference:
 *   download_pending_labels — { environment }
 *   download_return_label   — { order_id: string, environment }
 *   download_slip           — { slipType: "picking-list" | "packing-list", order_ids: (number|string)[], environment }
 */

export interface LabelsSlipsPdfsInput {
  prompt: string;
}

export type LabelsSlipsPdfsToolName =
  | "download_pending_labels"
  | "download_return_label"
  | "download_slip";

export interface LabelsSlipsPdfsExpected {
  toolName: LabelsSlipsPdfsToolName;
  argsSubset: Record<string, unknown>;
}

export interface LabelsSlipsPdfsItem {
  input: LabelsSlipsPdfsInput;
  expectedOutput: LabelsSlipsPdfsExpected;
  metadata: { tag: string };
}

export const items: LabelsSlipsPdfsItem[] = [
  // ── download_pending_labels (4 items) ────────────────────────────────────
  {
    input: {
      prompt: "Download all pending order labels in one PDF",
    },
    expectedOutput: {
      toolName: "download_pending_labels",
      argsSubset: { environment: "production" },
    },
    metadata: { tag: "pending-labels-happy" },
  },
  {
    input: {
      prompt: "Print the labels for all my pending shipments",
    },
    expectedOutput: {
      toolName: "download_pending_labels",
      argsSubset: { environment: "production" },
    },
    metadata: { tag: "pending-labels-paraphrase" },
  },
  {
    input: {
      prompt: "Get a label sheet for everything queued up",
    },
    expectedOutput: {
      toolName: "download_pending_labels",
      argsSubset: { environment: "production" },
    },
    metadata: { tag: "pending-labels-vague" },
  },
  {
    input: {
      prompt: "Pull staging pending labels",
    },
    expectedOutput: {
      toolName: "download_pending_labels",
      argsSubset: { environment: "staging" },
    },
    metadata: { tag: "pending-labels-staging" },
  },

  // ── download_return_label (4 items) ──────────────────────────────────────
  {
    input: {
      prompt: "Get the return label for order 57282",
    },
    expectedOutput: {
      toolName: "download_return_label",
      argsSubset: { order_id: "57282", environment: "production" },
    },
    metadata: { tag: "return-label-happy" },
  },
  {
    input: {
      prompt: "Print return label, order ID 57282",
    },
    expectedOutput: {
      toolName: "download_return_label",
      argsSubset: { order_id: "57282", environment: "production" },
    },
    metadata: { tag: "return-label-paraphrase" },
  },
  {
    input: {
      prompt: "I need the return shipping document for order id 12345",
    },
    expectedOutput: {
      toolName: "download_return_label",
      argsSubset: { order_id: "12345", environment: "production" },
    },
    metadata: { tag: "return-label-different-id" },
  },
  {
    input: {
      prompt: "Download return label for staging order 99",
    },
    expectedOutput: {
      toolName: "download_return_label",
      argsSubset: { order_id: "99", environment: "staging" },
    },
    metadata: { tag: "return-label-staging" },
  },

  // ── download_slip (4 items) ───────────────────────────────────────────────
  {
    input: {
      prompt: "Generate a picking list slip for orders 100, 101, 102",
    },
    expectedOutput: {
      toolName: "download_slip",
      argsSubset: {
        slipType: "picking-list",
        order_ids: [100, 101, 102],
        environment: "production",
      },
    },
    metadata: { tag: "slip-picking-multi" },
  },
  {
    input: {
      prompt: "Print packing list for order 555",
    },
    expectedOutput: {
      toolName: "download_slip",
      argsSubset: {
        slipType: "packing-list",
        order_ids: [555],
        environment: "production",
      },
    },
    metadata: { tag: "slip-packing-single" },
  },
  {
    input: {
      prompt: "Picking slip for order 1, 2, 3, 4, 5 in staging",
    },
    expectedOutput: {
      toolName: "download_slip",
      argsSubset: {
        slipType: "picking-list",
        order_ids: [1, 2, 3, 4, 5],
        environment: "staging",
      },
    },
    metadata: { tag: "slip-staging" },
  },
  {
    input: {
      prompt: "I need the carton-exterior slip for orders 200 and 201",
    },
    expectedOutput: {
      toolName: "download_slip",
      argsSubset: {
        slipType: "packing-list",
        order_ids: [200, 201],
        environment: "production",
      },
    },
    metadata: { tag: "slip-packing-paraphrase" },
  },
];
