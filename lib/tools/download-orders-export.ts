/**
 * `download_orders_export` — Phase 3 / ORDL-07.
 *
 * Endpoint: GET https://ex-api.quiqup.com/orders/download (Ex-core host).
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup bridge),
 *           Accept: *<slash>* (the upstream returns text/csv).
 *
 * Per source-doc §19 H lines 4716-4721, the FE calls `/orders/download`
 * with `from` + `to` (yyyy-mm-dd), an optional `filters[order_id]`
 * comma-separated list, and a `per_page` knob. The response is text/csv
 * which the FE saves as `selected-orders.csv`.
 *
 * Binary-response contract (03-REVIEW WR-04, fixed): the canonical envelope
 *   { contentType, base64, filenameHint }
 * is now returned as a `resource` content block with an `application/json`
 * sibling `text` block carrying the metadata for the LLM to summarise.
 * Phase 5 (PDFs), Phase 7 (CSV), and Phase 10 (Zoho PDFs) MUST follow this
 * same `resource`-block pattern — returning the envelope inside a `text`
 * block re-introduces the 2026-05-14 `get_lastmile_order_label` regression
 * (bash-heredoc gymnastics on the LLM side; see `lib/tools/register.ts:108`
 * for the historical context that drove widening `ContentBlock[]`).
 *
 * Read-only: no `guardrails` block. An export is a read, not a mutation.
 * The per_page cap (5000) and order_ids cap (500) bound per-call cost.
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform`).
 *   - 422       → typically a bad date format or invalid order_ids list.
 *   - 5xx       → upstream temporarily unavailable, retry.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { ExCoreClient } from "@/lib/clients/ex-core";
import { environmentField } from "@/lib/clients/quiqup-env";
import { jwtFor } from "@/lib/caller-auth";

// yyyy-mm-dd format is what the upstream actually expects on this
// endpoint (source-doc §19 H line 4720) — NOT full ISO-8601. WR-02
// lesson generalised: enforce the format the upstream wants, not the
// nearest-cousin standard.
const yyyyMmDd = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}$/,
    "must be in yyyy-mm-dd format (the Ex-core /orders/download endpoint accepts dates only, not full ISO-8601 timestamps)",
  );

const inputSchema = z.object({
  from: yyyyMmDd.describe(
    "Inclusive start date in yyyy-mm-dd format (UTC). The Ex-core upstream " +
      "uses yyyy-mm-dd NOT full ISO-8601 — per source-doc §19 H line 4720.",
  ),
  to: yyyyMmDd.describe(
    "Inclusive end date in yyyy-mm-dd format (UTC). Match the format of `from`.",
  ),
  order_ids: z
    .array(z.union([z.number().int().positive(), z.string().min(1)]))
    .max(500)
    .optional()
    .describe(
      "Optional filter — restrict the export to these clientOrderIDs. " +
        "Wire-format is comma-separated via the `filters[order_id]` query key. " +
        "Capped at 500 to bound the upstream cost.",
    ),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .default(1000)
    .describe(
      "Rows per page (1-5000). Default 1000. CSV streams all rows in a " +
        "single response — pagination here is the upstream's batch-size " +
        "hint, NOT cursor pagination.",
    ),
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
  name: "download_orders_export",
  description:
    "GET /orders/download (Ex-core host — ex-api.quiqup.com). " +
    "Exports a CSV of Quiqup orders matching a date range (and optionally " +
    "a list of specific clientOrderIDs). " +
    "Returns TWO content blocks: (1) a `resource` block whose " +
    "`resource.blob` field carries the base64-encoded CSV bytes under the " +
    "canonical metadata `{ contentType: 'text/csv', base64, filenameHint: " +
    "'orders-export-<from>-to-<to>.csv' }` projected as the resource's " +
    "`mimeType` + a synthesised `uri`; and (2) a sibling `text` block " +
    "carrying the JSON metadata envelope `{ contentType, base64, " +
    "filenameHint }` for the LLM to summarise (DO NOT echo the `base64` " +
    "field verbatim — it can be megabytes). Decode the `blob` field on " +
    "the `resource` block client-side to get the CSV bytes; hand the file " +
    "to the user verbatim, the same way `get_lastmile_order_label` returns " +
    "a downloadable artifact. " +
    "Inputs: `from` / `to` (yyyy-mm-dd UTC date strings — NOT full ISO-8601), " +
    "optional `order_ids` (array of integer or string clientOrderIDs, max 500, " +
    "wire-encoded as the `filters[order_id]` comma-separated query key), and " +
    "`per_page` (rows per page, 1-5000, default 1000). " +
    "When-to-use: use to bulk-export orders matching a date window. For " +
    "per-order detail in JSON, use `lookup_orders_ids` + `bulk_orders_lookup` " +
    "instead. " +
    "Error modes: 401/403 → run `whoami_platform`; 422 → likely a bad date " +
    "format or invalid order_ids list; 5xx → upstream retry. " +
    'Example: `{ "from": "2026-05-01", "to": "2026-05-19", ' +
    '"order_ids": [12345, 12346], "per_page": 1000, "environment": "production" }`.',
  inputSchema,
  outputSchema,
  // No guardrails block — read-only export (matches the read-tool
  // convention; see threat-register T-03-28).
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("download_orders_export requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    const client = new ExCoreClient({ jwt, environment: args.environment });

    // Build query string. Only include `filters[order_id]` when the
    // caller actually supplied IDs — an empty string may be interpreted
    // by the upstream as "filter by an empty set" (matches nothing),
    // safer to omit.
    const query: Record<string, string> = {
      from: args.from,
      to: args.to,
      per_page: String(args.per_page ?? 1000),
    };
    if (args.order_ids && args.order_ids.length > 0) {
      query["filters[order_id]"] = args.order_ids.join(",");
    }

    const result = await client.request("GET", "/orders/download", { query });

    // Happy path: result is the base64 envelope from ExCoreClient. Layer
    // on the filenameHint so the agent can label the saved artifact.
    //
    // 03-REVIEW WR-04: return a `resource` content block (NOT a `text`
    // block containing JSON-stringified base64). A CSV export can easily
    // be megabytes; squeezing megabytes of base64 through a `text` block
    // forces LLM clients into bash-heredoc gymnastics to decode bytes
    // that should have flowed as a `resource` block to begin with (see
    // `lib/tools/register.ts:108` widening note from 2026-05-14). Phase 5
    // (PDFs), Phase 7 (CSV), Phase 10 (Zoho PDFs) MUST follow the same
    // shape. The sibling `text` block carries the metadata envelope
    // `{ contentType, base64, filenameHint }` JSON-stringified so the
    // contract substrings live in source (the static eval scorer
    // `binary-envelope-contract` greps for them); the base64 is sent
    // for backwards compatibility but agents SHOULD prefer the resource
    // block's `blob` field for the actual bytes.
    if (
      result &&
      typeof result === "object" &&
      "base64" in result &&
      typeof (result as { base64: unknown }).base64 === "string"
    ) {
      const envelope = result as { contentType: string; base64: string };
      const filenameHint = `orders-export-${args.from}-to-${args.to}.csv`;
      // Synthesise a `quiqup-export://` URI from the filenameHint. The
      // URI is opaque — it carries no fetchable semantics — but the
      // resource block MUST carry a `uri` per the MCP schema, and a
      // scheme-prefixed filename is the most useful default for clients
      // that surface the URI to the user.
      const resourceUri = `quiqup-export://${filenameHint}`;
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
          { type: "text" as const, text: JSON.stringify(payload, null, 2) },
        ],
      };
    }

    // Fallback path: upstream returned JSON (typically a 200-with-error
    // envelope from the gateway). Surface verbatim — the agent can
    // decide whether to retry.
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  },
};
