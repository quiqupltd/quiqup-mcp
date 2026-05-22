/**
 * `download_return_label` — Phase 5 / Wave 2 / MISS-05.
 *
 * Endpoint: GET https://graph.quiqup.com/return_order_label/{orderId}
 *   (Quiqup-GraphQL-host REST surface — graph.staging.quiqup.com for staging).
 *   PDF response. Source-doc §8 line 428-429 + §19 H lines 4730-4731.
 *
 * Wave 2 is a deliberate "tool-only" wave — no new client, no new error class.
 * This tool reuses the `QuiqupGraphqlHostClient` introduced in plan 05-01. The
 * Wave-1 client is the chokepoint for the Phase-5 host family; consolidating
 * new-host risk into Wave 1 means Waves 2 and 3 are pure additions. This mirrors
 * STATE.md decision 2026-05-20 03-03 (the "consolidation wave" pattern from
 * Phase 3 plan 03-03 where three Platform-API tools reused existing plumbing).
 *
 * Path hygiene (T-03-24 generalized, also T-05-10):
 *   The caller-supplied `order_id` is `encodeURIComponent`-encoded before URL
 *   interpolation so caller-supplied IDs cannot inject path components. For
 *   example, `order_id: "57282/admin"` becomes `/return_order_label/57282%2Fadmin`
 *   on the wire — the upstream sees the encoded string and the path resolver does
 *   not collapse it. Path-injection is a structural concern independent of
 *   read-vs-write; the same mitigation applies here as in `upload_order_document`.
 *   The orderId in the filenameHint uses the RAW caller-supplied value (NOT the
 *   encoded form) — the filename surface is presentation-only; the URL surface is
 *   the one that needs encoding.
 *
 * Output: returns TWO content blocks per the binary-envelope-contract locked by
 *   `download_pending_labels` (Wave 1) and `download_orders_export` (Phase 3):
 *     (1) a `resource` block with `uri: "quiqup-label://return-label-{orderId}.pdf"`,
 *         `mimeType: envelope.contentType`, and `blob: envelope.base64`.
 *     (2) a sibling `text` block carrying `{ contentType, base64, filenameHint }`.
 *   The binary-envelope-contract STATIC scorer in Wave 4 grep-locks this shape
 *   across all 3 Phase-5 PDF tools.
 *
 * filenameHint convention: `return-label-{order_id}.pdf` — derives the filename
 *   from the orderId so each call produces a deterministic, human-readable artifact
 *   name per-call. The FE save-as convention in source-doc §8 line 429 is
 *   `useDownloadReturnLabel`; we extrapolate the same prefix-by-purpose convention
 *   used by Phase-3's `orders-export-{from}-to-{to}.csv`.
 *
 * Read-only: NO `guardrails` block (matches `download_pending_labels` /
 *   `download_orders_export` precedent for read tools).
 *
 * Error modes:
 *   - 401/403 → auth issue — run `whoami_platform`.
 *   - 404 → upstream did not find a return label for that orderId (the order is
 *     likely not in a return state — check via `get_order_history`).
 *   - 5xx → upstream temporarily unavailable, retry.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupGraphqlHostClient } from "@/lib/clients/quiqup-graphql-host";
import { environmentField } from "@/lib/clients/quiqup-env";
import { getQuiqupReadyJwt } from "@/lib/quiqup";

const inputSchema = z.object({
  order_id: z.string().min(1, "order_id is required"),
  environment: environmentField,
});

const outputSchema = z
  .object({
    contentType: z.string(),
    base64: z.string(),
    filenameHint: z.string(),
  })
  .passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "download_return_label",
  description:
    "GET /return_order_label/{orderId} (Quiqup-GraphQL-host — graph.quiqup.com). " +
    "Returns TWO content blocks identical to `download_pending_labels`: " +
    "(1) a `resource` block whose `resource.blob` field carries the base64-encoded " +
    "PDF bytes under the canonical metadata " +
    "{ contentType: 'application/pdf', base64, filenameHint: 'return-label-<orderId>.pdf' } " +
    "projected as the resource's `mimeType` + a synthesised " +
    "`quiqup-label://return-label-<orderId>.pdf` URI; and (2) a sibling `text` block " +
    "carrying the JSON metadata envelope `{ contentType, base64, filenameHint }` " +
    "for the LLM to summarise (DO NOT echo the `base64` field verbatim — it can " +
    "be hundreds of KB). Decode the `blob` field on the resource block client-side; " +
    "hand the file to the user verbatim. " +
    "Inputs: `order_id` (Quiqup orderId, string, required — `encodeURIComponent`-encoded " +
    "server-side before URL interpolation so caller-supplied IDs cannot inject path " +
    "components) and `environment` (`'production'` | `'staging'`). " +
    "When-to-use: use to download the return label PDF for a specific Quiqup order " +
    "that has been put into a return state. For non-return-state labels, use " +
    "`get_lastmile_order_label` (signed-URL pattern) or `download_pending_labels` " +
    "(concatenated batch PDF) instead. " +
    "Error modes: 401/403 → run `whoami_platform`; 404 → order has no return label " +
    "(the order is likely not in a return state — check via `get_order_history`); " +
    "5xx → upstream retry. " +
    'Example: `{ "order_id": "57282", "environment": "production" }`.',
  inputSchema,
  outputSchema,
  // No guardrails block — read-only tool (matches `download_pending_labels` /
  // `download_orders_export` precedent; an export is a read, not a mutation).
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error(
        "download_return_label requires an authenticated user",
      );
    }

    const jwt = await getQuiqupReadyJwt(auth.userId);
    const client = new QuiqupGraphqlHostClient({
      jwt,
      environment: args.environment,
    });

    // T-05-10 path hygiene: `encodeURIComponent` applied to the caller-supplied
    // order_id before URL interpolation. This generalises T-03-24 from write
    // tools to read tools — path-injection is a structural concern. The encoded
    // form is used ONLY for the URL; the filenameHint uses the raw value so
    // the saved artifact has a human-readable name (T-05-12 split — tests
    // assert both sides of this split to prevent drift).
    const path = `/return_order_label/${encodeURIComponent(args.order_id)}`;
    const result = await client.request("GET", path);

    // Happy path: result is the base64 envelope from QuiqupGraphqlHostClient.
    // Layer on filenameHint using the RAW order_id (not the encoded form) so
    // the saved file is named deterministically per-call and is human-readable.
    //
    // binary-envelope-contract: mirrors download-pending-labels.ts verbatim —
    // same `if (result && typeof result === "object" && "base64" in result ...)`
    // shape; same `as const` patterns; same dual-block `resource` + `text`
    // return. The Wave-4 STATIC scorer grep-locks this shape across all 3
    // Phase-5 PDF tools.
    if (
      result &&
      typeof result === "object" &&
      "base64" in result &&
      typeof (result as { base64: unknown }).base64 === "string"
    ) {
      const envelope = result as { contentType: string; base64: string };
      // filenameHint uses the RAW order_id — presentation-only surface (T-05-12).
      const filenameHint = `return-label-${args.order_id}.pdf`;
      // Synthesise the `quiqup-label://` URI from the filename. The raw order_id
      // is safe here because the URI is opaque presentation data, not a path
      // that the runtime resolves. The URL surface (above, line with
      // encodeURIComponent) is the one that needs encoding.
      const resourceUri = "quiqup-label://" + `return-label-${args.order_id}.pdf`;
      const payload = {
        contentType: envelope.contentType,
        base64: envelope.base64,
        filenameHint,
      };
      return {
        content: [
          {
            type: "resource" as const,
            resource: {
              uri: resourceUri,
              mimeType: envelope.contentType,
              blob: envelope.base64,
            },
          },
          {
            type: "text" as const,
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    }

    // Fallback path: upstream returned JSON (typically a 200-with-error
    // envelope from the gateway). Surface verbatim — the agent can decide
    // whether to retry.
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },
};
