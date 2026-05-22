/**
 * `download_pending_labels` — Phase 5 / Wave 1 / MISS-03.
 *
 * Endpoint: GET https://graph.quiqup.com/pending_orders_labels
 *   (Quiqup-GraphQL-host REST surface — graph.staging.quiqup.com for staging).
 *   PDF response, no path/query params per source-doc §8 line 422.
 *
 * Phase 5 anchor for the binary-response contract on the new Quiqup-GraphQL-host
 * family. The FE save-as filename is `pending-orders.pdf` per source-doc §8 line
 * 423 — we preserve that as `filenameHint` so the agent's downstream client can
 * label the file identically to the Quiqdash UX.
 *
 * Output: returns TWO content blocks per the canonical pattern locked by
 * `download_orders_export` — a `resource` block carrying the base64 PDF bytes
 * on `resource.blob` (with `mimeType: "application/pdf"` and a synthesised
 * `quiqup-label://pending-orders.pdf` URI), and a sibling `text` block carrying
 * the JSON-stringified `{ contentType, base64, filenameHint }` metadata. The
 * dual-block shape is required so MCP hosts that DO render `application/pdf`
 * resource blocks (e.g. ChatGPT) get a downloadable artifact, while hosts that
 * don't at least get the metadata envelope.
 *
 * Note: `get_lastmile_order_label` uses a signed-URL alternative because its
 * label endpoint is per-order; the pending-labels endpoint takes no order ID so
 * a signed URL would have no useful identity — the resource block is the right
 * answer here.
 *
 * Read-only: NO `guardrails` block (matches `download_orders_export` precedent —
 * read tools omit guardrails; the per-call cost is bounded by the upstream
 * returning a single concatenated PDF).
 *
 * Error modes: 401/403 → run `whoami_platform`; 5xx → upstream retry. The
 * endpoint has no input parameters so 422 is unlikely.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import {
  QuiqupGraphqlHostClient,
} from "@/lib/clients/quiqup-graphql-host";
import { environmentField } from "@/lib/clients/quiqup-env";
import { getQuiqupReadyJwt } from "@/lib/quiqup";

const inputSchema = z.object({
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
  name: "download_pending_labels",
  description:
    "GET /pending_orders_labels (Quiqup-GraphQL-host — graph.quiqup.com). " +
    "Returns TWO content blocks: (1) a `resource` block whose `resource.blob` " +
    "field carries the base64-encoded PDF bytes under the canonical metadata " +
    "{ contentType: 'application/pdf', base64, filenameHint: 'pending-orders.pdf' } " +
    "projected as the resource's `mimeType` + a synthesised " +
    "`quiqup-label://pending-orders.pdf` URI; and (2) a sibling `text` block " +
    "carrying the JSON metadata envelope `{ contentType, base64, filenameHint }` " +
    "for the LLM to summarise (DO NOT echo the `base64` field verbatim — it can " +
    "be hundreds of KB). Decode the `blob` field on the resource block client-side " +
    "to get the PDF bytes; hand the file to the user verbatim, the same way " +
    "`get_lastmile_order_label` returns a downloadable artifact. " +
    "Inputs: only `environment` (`'production'` | `'staging'`) — the endpoint has " +
    "no path or query parameters; the upstream selects the agent's pending orders " +
    "based on the authenticated user's account context. " +
    "When-to-use: use to download a concatenated PDF of label sheets for ALL " +
    "pending orders on the authenticated account in one call. For per-order labels, " +
    "use `get_lastmile_order_label` instead (returns a signed download URL). " +
    "Error modes: 401/403 → run `whoami_platform`; 5xx → upstream retry. " +
    'Example: `{ "environment": "production" }`.',
  inputSchema,
  outputSchema,
  // No guardrails block — read-only tool (matches `download_orders_export`
  // precedent; an export is a read, not a mutation).
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error(
        "download_pending_labels requires an authenticated user",
      );
    }

    const jwt = await getQuiqupReadyJwt(auth.userId);
    const client = new QuiqupGraphqlHostClient({
      jwt,
      environment: args.environment,
    });

    const result = await client.request("GET", "/pending_orders_labels");

    // Happy path: result is the base64 envelope from QuiqupGraphqlHostClient.
    // Layer on filenameHint so the agent can label the saved artifact —
    // matches the FE save-as filename at app/hooks/order/use-orders.tsx:373
    // per source-doc §8 line 423 (preserving FE-parity).
    //
    // binary-envelope-contract: mirrors download-orders-export.ts verbatim —
    // same `if (result && typeof result === "object" && "base64" in result ...)`
    // shape; same `as const` patterns; same dual-block `resource` + `text`
    // return. This is the locked Phase-3-decision wire shape; re-deriving it
    // would create drift.
    if (
      result &&
      typeof result === "object" &&
      "base64" in result &&
      typeof (result as { base64: unknown }).base64 === "string"
    ) {
      const envelope = result as { contentType: string; base64: string };
      const filenameHint = "pending-orders.pdf";
      // Synthesise a `quiqup-label://` URI from the canonical filename. The
      // URI is opaque — it carries no fetchable semantics — but the resource
      // block MUST carry a `uri` per the MCP schema, and a scheme-prefixed
      // filename is the most useful default for clients that surface it.
      // "pending-orders.pdf" is pinned as a literal here (not derived from
      // filenameHint) to lock the URI independently — the FE save-as parity
      // and the URI must both point to the same canonical filename.
      const resourceUri = "quiqup-label://" + "pending-orders.pdf";
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
