/**
 * `bulk_create_orders` — Phase 4 / ORDC-05.
 *
 * Endpoint: POST https://platform-api.quiqup.com/quiqdash/bulk_orders
 *           (multipart/form-data — single `file` form field carrying the CSV bytes)
 * Headers:  Authorization: Bearer <session-JWT>
 *           Accept: application/json
 *           Content-Type is set AUTOMATICALLY by the runtime from the
 *           FormData body — DO NOT set it manually (canonical 03-04
 *           lockup; setting it clobbers the multipart boundary).
 *
 * D-08 — per-row error passthrough (Phase 4 plan):
 *   When the upstream returns per-row errors (e.g.
 *   `{ errors: { row_1: "missing sku", row_5: "invalid date" }, created: [...] }`),
 *   this tool returns the upstream payload VERBATIM. NO client-side
 *   aggregation, NO stripping. The LLM caller is the right place to
 *   decide whether to retry the failed rows.
 *
 * Multipart-codec hoist decision (recorded by 04-04 Task 2):
 *   The multipart codec was hoisted to `lib/clients/_multipart.ts` and
 *   both `orders-core-rest.ts` (Phase 3) and `platform-api.ts` (this
 *   tool) now delegate to it via their own `requestMultipart` methods.
 *   Rationale: Phase 6 will add a third multipart consumer (Fulfilment
 *   bulk-validate / bulk-commit product CSVs, also Platform host) — with
 *   three callers in flight the lift-and-shift wins on DRY without
 *   introducing test churn.
 *
 * Pre-flight 10MB cap (T-04-19 DoS mitigation):
 *   `args.csv_base64.length <= 13_500_000` (~10MB after base64 decode).
 *   Enforced BEFORE FormData construction AND BEFORE JWT mint so abusive
 *   callers cost nothing upstream. Matches the upload_order_document
 *   (Phase 3 / ORDS-08) precedent verbatim.
 *
 * Identity binding (BL-04 server-side):
 *   No `user_id` / `actor_id` / `actor_email` / `partner_id` field on
 *   the input schema. Identity comes from `auth.userId` only.
 *
 * Guardrails (BL-01 — slightly tighter than upload_order_document
 * because each bulk call may create many orders at once):
 *   - rateLimit 5/min — bulk uploads should be rare.
 *   - idempotency on `idempotency_key` (15min TTL) — safe retries.
 *   - audit: true — repudiation defence.
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform`).
 *   - 413       → file too large (upstream rejected even under 10MB cap).
 *   - 422       → upstream validation rejection.
 *   - 5xx       → upstream temporarily unavailable, retry.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { PlatformApiClient } from "@/lib/clients/platform-api";
import { environmentField } from "@/lib/clients/quiqup-env";
import { jwtFor } from "@/lib/caller-auth";

const MAX_CSV_BASE64_CHARS = 13_500_000;

const inputSchema = z.object({
  csv_base64: z
    .string()
    .min(1)
    .max(MAX_CSV_BASE64_CHARS)
    .describe(
      "Base64-encoded CSV file content. The CSV should carry one order " +
        "per row using the partner's bulk-order template (partner_order_id, " +
        "sku, quantity, shipping address fields, etc. — see Quiqdash's " +
        "downloadable template for the exact column set). Capped at ~10MB " +
        "(13,500,000 base64 chars) — agents trying to upload very large " +
        "CSVs should split into smaller batches.",
    ),
  filename: z
    .string()
    .min(1)
    .default("bulk_orders.csv")
    .describe(
      "Original filename (informational; the upstream stores it on the " +
        "upload record). Defaults to 'bulk_orders.csv'.",
    ),
  idempotency_key: z
    .string()
    .optional()
    .describe(
      "Optional client-supplied key. Duplicate calls with the same key " +
        "within 15 minutes return the cached result without re-firing " +
        "the upstream POST. Useful for retrying after transient network " +
        "errors without creating duplicate orders.",
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "bulk_create_orders",
  description:
    "POST /quiqdash/bulk_orders (Platform host — multipart/form-data; CSV upload). " +
    "Create many orders in a single call by uploading a CSV file. Inputs: " +
    "`csv_base64` (base64-encoded CSV bytes, max ~10MB / 13,500,000 base64 " +
    "chars), `filename` (informational, defaults to 'bulk_orders.csv'), " +
    "optional `idempotency_key`. The CSV columns follow Quiqdash's bulk-" +
    "order template (partner_order_id, sku, quantity, shipping address " +
    "fields, etc.) — download the canonical template from Quiqdash for " +
    "the exact shape. " +
    "Per-row error semantics (D-08): the upstream returns per-row error " +
    "results — e.g. `{ created: [...], errors: { row_1: 'missing sku', " +
    "row_5: 'invalid date' } }`. This tool surfaces that payload VERBATIM " +
    "without aggregation; the LLM caller decides which rows to retry. " +
    "Identity binding: NO user/actor fields accepted — identity is bound " +
    "server-side to auth.userId (BL-04). " +
    "Idempotency: pass `idempotency_key` to dedupe retries within 15 min — " +
    "critical here because re-running a bulk upload on transient network " +
    "failure would otherwise create duplicate orders. " +
    "Error modes: 401/403 → auth (run `whoami_platform`); 413 → too large " +
    "even under 10MB client cap; 422 → upstream validation; 5xx → retry. " +
    'Example: `{ "csv_base64": "cGFydG5lcl9vcmRlcl9pZCxza3UsLi4u", ' +
    '"filename": "orders.csv", "environment": "production" }`.',
  inputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 5, refillPerSec: 5 / 60 },
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("bulk_create_orders requires an authenticated user");
    }

    // Pre-flight 10MB cap (defense-in-depth — schema also enforces it).
    // Enforced BEFORE JWT mint and BEFORE FormData construction so
    // abusive callers cost nothing upstream.
    if (args.csv_base64.length > MAX_CSV_BASE64_CHARS) {
      throw new Error(
        `csv_base64 exceeds 10MB cap (${MAX_CSV_BASE64_CHARS} base64 chars); split into smaller batches`,
      );
    }

    // Apply default locally (the SDK may not always pre-fill .default()).
    const safeFilename = (args.filename ?? "bulk_orders.csv").replace(
      /[\\/]/g,
      "_",
    );

    const jwt = await jwtFor(auth, args.environment);

    const csvBytes = Buffer.from(args.csv_base64, "base64");
    const fd = new FormData();
    // Per source-doc §19 H line 4668 — single `file` form field.
    fd.append(
      "file",
      new Blob([new Uint8Array(csvBytes)], { type: "text/csv" }),
      safeFilename,
    );

    const client = new PlatformApiClient({
      jwt,
      environment: args.environment,
    });
    const data = await client.requestMultipart(
      "POST",
      "/quiqdash/bulk_orders",
      fd,
    );

    // D-08 verbatim passthrough: stringify the upstream payload as-is.
    // No aggregation, no stripping — the LLM sees the full row→error map.
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(data, null, 2) },
      ],
    };
  },
};
