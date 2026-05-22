/**
 * `download_slip` — Phase 5 / Wave 3 / MISS-06.
 *
 * Endpoint: GET https://platform-api.quiqup.com/slips/{slipType}?order_ids=<csv>
 *   (Platform host — platform-api.staging.quiqup.com for staging).
 *   Source-doc §8 line 431-432 + §19 H lines 4733-4736.
 *
 * This is the THIRD and final tool of Phase 5 and the first one that does NOT
 * live on the Quiqup-GraphQL-host introduced by Waves 1-2 — it lives on the
 * existing Platform host (platform-api.quiqup.com). Reuses the existing
 * `PlatformApiClient` (Platform is an existing host family per STATE.md
 * "sibling clients of an existing host family reuse the existing class" —
 * `QuiqupHttpError` stays as the error class).
 *
 * `slipType` is enum-bounded to `"picking-list" | "packing-list"` per
 * source-doc §19 H line 4734. This is a path parameter so the upstream
 * service dispatches on it directly — sending an undocumented value would
 * 404 at best and could probe internal routing at worst. The z.enum lock
 * matches the Phase-3 T-03-04 precedent (lookup_orders_ids.orderBy.field =
 * z.literal("SUBMITTED_AT") — STATE.md decision 2026-05-19 03-01).
 *
 * Headers (NEW — uses Task 1's extraHeaders parameter on PlatformApiClient):
 *   - `api-version: 20180108` (source-doc §8 line 432 — required by upstream).
 *   - `Accept: application/pdf` (source-doc §19 H line 4735 — overrides
 *     PlatformApiClient's default `Accept: application/json` which would 406
 *     on a PDF response).
 *
 * `order_ids` wire format: comma-separated query string (matches the FE-side
 * hook at `app/hooks/order/use-slips-download.tsx:28`). Capped at 500 entries
 * client-side — same cap as `download_orders_export` per STATE.md decision
 * 2026-05-19 03-01 ("bulk_orders_lookup.client_order_ids cap of 200 matches
 * the upstream"); 500 here matches the export precedent because the slip
 * endpoint is similarly bulk-shaped.
 *
 * Read-only: NO `guardrails` block (matches `download_pending_labels` /
 * `download_return_label` / `download_orders_export` precedent for read tools).
 *
 * Output: dual-block resource+text envelope, identical shape to Waves 1 and 2.
 *
 * filenameHint convention:
 *   - Single-order: `<slipType>-<orderId>.pdf` (e.g. `picking-list-12345.pdf`)
 *   - Multi-order: `<slipType>-<firstOrderId>-and-<N-1>-more.pdf` (e.g.
 *     `packing-list-12345-and-3-more.pdf`) — keeps artifact name human-readable
 *     without serialising the full ID list into the filename.
 *
 * Error modes:
 *   - 401/403 → auth issue — run `whoami_platform`.
 *   - 422 → bad slipType (schema should catch) or empty/invalid order_ids.
 *   - 5xx → upstream temporarily unavailable, retry.
 *
 * Phase 8 note: SHIP-02 (`list_carrier_capabilities`) will also need the
 * extraHeaders mechanism for `x-api-version: 20240101` (source-doc §11 line 499).
 * This tool is the first consumer of Task-1's extension.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { PlatformApiClient } from "@/lib/clients/platform-api";
import { environmentField } from "@/lib/clients/quiqup-env";
import { getQuiqupReadyJwt } from "@/lib/quiqup";

const inputSchema = z.object({
  slipType: z
    .enum(["picking-list", "packing-list"])
    .describe(
      "Slip flavour. `picking-list` is for warehouse pick-pack picking; " +
        "`packing-list` is for the carton's exterior. " +
        "Source-doc §19 H line 4734 enumerates these two values; passing any " +
        "other value 422s the upstream. Locked at the schema layer.",
    ),
  order_ids: z
    .array(z.union([z.number().int().positive(), z.string().min(1)]))
    .min(1, "at least one order_id is required")
    .max(
      500,
      "order_ids capped at 500 entries (matches download_orders_export precedent)",
    )
    .describe(
      "List of Quiqup orderIds to include on the slip. Wire-encoded as a " +
        "comma-separated `order_ids` query string. Capped at 500 entries " +
        "client-side to bound upstream cost. Accepts integer or string IDs " +
        "interchangeably (the upstream coerces both).",
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
  name: "download_slip",
  description:
    "GET /slips/{slipType}?order_ids=... (Platform host — platform-api.quiqup.com). " +
    "Returns TWO content blocks identical to `download_pending_labels` and " +
    "`download_return_label`: (1) a `resource` block whose `resource.blob` field " +
    "carries the base64-encoded PDF bytes under the canonical metadata " +
    "{ contentType: 'application/pdf', base64, filenameHint } projected as the " +
    "resource's `mimeType` + a synthesised `quiqup-label://<filenameHint>` URI; " +
    "and (2) a sibling `text` block carrying the JSON metadata envelope " +
    "`{ contentType, base64, filenameHint }` for the LLM to summarise (DO NOT " +
    "echo the `base64` field verbatim — it can be hundreds of KB). Decode the " +
    "`blob` field on the resource block client-side to get the PDF bytes; hand " +
    "the file to the user verbatim. " +
    "Inputs: `slipType` (z.enum locked to `picking-list` | `packing-list` — " +
    "source-doc §19 H line 4734; the upstream dispatches on this path parameter " +
    "directly), `order_ids` (array of integer or string Quiqup orderIds, min 1, " +
    "max 500, comma-separated on the wire), and `environment` " +
    "(`'production'` | `'staging'`). " +
    "filenameHint convention: single-order calls produce " +
    "`<slipType>-<orderId>.pdf` (e.g. `picking-list-12345.pdf`); multi-order " +
    "calls produce `<slipType>-<firstOrderId>-and-<N-1>-more.pdf` (e.g. " +
    "`packing-list-12345-and-3-more.pdf`) — this keeps the artifact name " +
    "human-readable without serialising the full ID list. " +
    "Header note (eval-discoverable): sends `api-version: 20180108` and " +
    "`Accept: application/pdf` per upstream requirement (source-doc §8 line 432, " +
    "§19 H line 4735). The api-version is a fixed numeric header value the BE " +
    "uses to lock slip-template versioning; do not parameterise. " +
    "When-to-use: use to download a picking-list (warehouse picking) or " +
    "packing-list (carton exterior) slip PDF for one or more orders. For per-order " +
    "labels use `get_lastmile_order_label`; for all pending labels in one PDF use " +
    "`download_pending_labels`; for return labels use `download_return_label`. " +
    "Error modes: 401/403 → run `whoami_platform`; 422 → bad slipType (the schema " +
    "should have caught this) or empty/invalid order_ids; 5xx → upstream retry. " +
    'Example: `{ "slipType": "picking-list", "order_ids": [12345, 12346, 12347], "environment": "production" }`.',
  inputSchema,
  outputSchema,
  // No guardrails block — read-only tool (matches `download_pending_labels` /
  // `download_return_label` / `download_orders_export` precedent).
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("download_slip requires an authenticated user");
    }

    const jwt = await getQuiqupReadyJwt(auth.userId);
    const client = new PlatformApiClient({ jwt, environment: args.environment });

    // T-05-14 / path hygiene: encodeURIComponent is belt-and-braces — the
    // z.enum already restricts the value to URL-safe strings ("picking-list"
    // and "packing-list"), but the precedent from `upload_order_document` is
    // "always encode caller-supplied path values".
    const path = `/slips/${encodeURIComponent(args.slipType)}`;

    // T-05-15 query hygiene: join into CSV. URLSearchParams.set() handles
    // any embedded special chars via percent-encoding (the IDs are numbers
    // or min(1) strings, so "&" and "?" characters cannot slip through).
    const orderIdsCsv = args.order_ids.join(",");
    const query = { order_ids: orderIdsCsv };

    // The Platform client's default Accept: application/json would 406 on a
    // PDF response — override via extraHeaders (Task-1's new mechanism).
    // NOTE on casing: `api-version` is lowercase per source-doc; `Accept` is
    // title-case to override the default `Accept: application/json` key used
    // by the client's header literal. HTTP headers are case-insensitive at
    // the wire level but the spread order matters inside the JS object.
    const extraHeaders = { "api-version": "20180108", Accept: "application/pdf" };

    const result = await client.request("GET", path, { query, extraHeaders });

    // Compute filenameHint. The convention keeps the artifact name
    // human-readable without exploding at 500 IDs.
    const firstId = String(args.order_ids[0]);
    const filenameHint =
      args.order_ids.length === 1
        ? `${args.slipType}-${firstId}.pdf`
        : `${args.slipType}-${firstId}-and-${args.order_ids.length - 1}-more.pdf`;

    // Happy path: result is the base64 envelope from PlatformApiClient.
    // Layer on filenameHint and return the dual-block resource+text envelope.
    //
    // binary-envelope-contract: mirrors download-pending-labels.ts and
    // download-return-label.ts verbatim — same narrowing pattern; same
    // `as const` types; same dual-block `resource` + `text` return. The
    // Wave-4 STATIC scorer grep-locks this shape across all 3 Phase-5 tools.
    if (
      result &&
      typeof result === "object" &&
      "base64" in result &&
      typeof (result as { base64: unknown }).base64 === "string"
    ) {
      const envelope = result as { contentType: string; base64: string };
      const resourceUri = `quiqup-label://${filenameHint}`;
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
