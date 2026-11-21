/**
 * `upload_order_document` — Phase 3 / ORDS-08.
 *
 * Endpoint: POST https://orders-api.quiqup.com/orders-by-client-id/{clientOrderID}/documents
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup bridge),
 *           Accept: application/json
 *           (Content-Type is set automatically by the runtime from the
 *            FormData body — `multipart/form-data; boundary=...`)
 *
 * Per source-doc §5 line 355 + §19 H lines 4671-4675 the FE POSTs three
 * multipart form fields:
 *   - file (binary)
 *   - document_type (default "proof_of_delivery")
 *   - admin_override (default "true")
 * The FE checks only `response.ok` (source-doc line 4674) — the
 * upstream typically returns a document reference but the shape is not
 * tightly contracted.
 *
 * Identity binding (BL-04 lesson — server-side):
 *   The input schema has NO `user_id` / `actor_id` / `actor_email` field.
 *   The uploader identity is derived exclusively from `auth.userId` at
 *   the handler level. Caller-supplied identity is a cross-tenant
 *   smuggling vector — locked out by the schema shape itself, not just
 *   by handler conventions.
 *
 * Guardrails (BL-01 canonical write-tool pattern):
 *   - rateLimit 10/min — uploads should be rare; runaway rate is misuse.
 *   - idempotency on `idempotency_key` (15min TTL) — safe retries.
 *   - audit: true — repudiation defence (T-03-29).
 *
 * Pre-flight 10MB cap (T-03-25 DoS mitigation):
 *   `args.file_base64.length <= 13_500_000` (~10MB after base64 decode).
 *   Enforced BEFORE FormData construction AND BEFORE JWT mint so
 *   abusive callers cost nothing upstream.
 *
 * Filename hygiene (T-03-25):
 *   Path separators (`/`, `\`) replaced with `_` server-side. Never
 *   trust the caller-supplied filename verbatim.
 *
 * Path-param hygiene (T-03-24):
 *   `client_order_id` is `encodeURIComponent`-ed before interpolation
 *   so caller-supplied IDs cannot inject path components.
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform`).
 *   - 413       → file too large (upstream rejected even under our 10MB cap).
 *   - 422       → bad client_order_id or unsupported document_type.
 *   - 5xx       → upstream temporarily unavailable, retry.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { OrdersCoreRestClient } from "@/lib/clients/orders-core-rest";
import { environmentField } from "@/lib/clients/quiqup-env";
import { jwtFor } from "@/lib/caller-auth";

const MAX_FILE_BASE64_CHARS = 13_500_000;

const inputSchema = z.object({
  client_order_id: z
    .union([z.number().int().positive(), z.string().min(1)])
    .describe(
      "Quiqup clientOrderID — accepts either the integer ID or its string " +
        "form. encodeURIComponent is applied at the URL boundary so " +
        "caller-supplied IDs cannot inject path components.",
    ),
  file_base64: z
    .string()
    .min(1)
    .describe(
      "Base64-encoded file bytes. PDF / JPEG / PNG are typical " +
        "proof-of-delivery payloads. Capped at ~10MB (~13.5M base64 " +
        "chars) — agents trying to upload very large blobs should split " +
        "or compress first.",
    ),
  filename: z
    .string()
    .min(1)
    .max(255)
    .describe(
      "Original filename (informational; the upstream stores it on the " +
        "document record). Path separators are stripped server-side.",
    ),
  content_type: z
    .string()
    .min(1)
    .describe(
      "MIME type of the file (e.g. 'image/jpeg', 'image/png', " +
        "'application/pdf'). Populates the multipart part's Content-Type.",
    ),
  document_type: z
    .string()
    .min(1)
    .default("proof_of_delivery")
    .describe(
      "Document type tag. Source-doc §19 H line 4673 shows " +
        "'proof_of_delivery' as the observed FE value. Defaults to that; " +
        "pass another string only if you know the upstream supports it.",
    ),
  admin_override: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Boolean flag that the FE always sends as 'true' (source-doc §19 H " +
        "line 4673). Defaults to true — pass false to skip the " +
        "admin-override path if upstream policy permits it.",
    ),
  idempotency_key: z
    .string()
    .optional()
    .describe(
      "Optional caller-supplied key to dedupe retries within a 15-minute " +
        "window. Wire-shape: this field is NOT included in the multipart " +
        "envelope — it's consumed by the registerTool wrapper for the " +
        "idempotency cache key.",
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "upload_order_document",
  description:
    "POST /orders-by-client-id/{clientOrderID}/documents (Orders Core REST " +
    "host — orders-api.quiqup.com; multipart/form-data). " +
    "Upload a document (typically a proof-of-delivery image or PDF) to an " +
    "existing Quiqup order. Inputs: `client_order_id` (integer or string " +
    "clientOrderID), `file_base64` (base64-encoded file bytes, capped at " +
    "~10MB), `filename` (informational — path separators are stripped " +
    "server-side), `content_type` (MIME — e.g. 'image/jpeg'), " +
    "`document_type` (default 'proof_of_delivery'), `admin_override` " +
    "(default true), and an optional `idempotency_key` for safe retries " +
    "within a 15-minute window. " +
    "Identity binding: this tool does NOT accept caller-supplied user/" +
    "actor fields. The uploader identity is bound server-side to the " +
    "authenticated user (auth.userId). Do not pass `user_id`, `actor_id`, " +
    "or `actor_email` — they will be ignored at best and rejected at worst. " +
    "Output: the upstream Orders Core document reference (typical shape " +
    "`{ document_id, document_type, created_at, url }` — verify against " +
    "the actual upstream response). The FE-side hook checks only " +
    "`response.ok` so the returned envelope is not tightly contracted. " +
    "Idempotency: passing `idempotency_key` lets the agent retry safely " +
    "within 15 minutes — duplicate calls with the same key return the " +
    "cached result. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 413 → " +
    "file too large (upstream rejected even under our 10MB client cap); " +
    "422 → bad client_order_id or unsupported document_type; 5xx → " +
    "upstream retry. " +
    'Example: `{ "client_order_id": 12345, "file_base64": "iVBORw0KGgo...", ' +
    '"filename": "pod-12345.jpg", "content_type": "image/jpeg", ' +
    '"document_type": "proof_of_delivery", "admin_override": true, ' +
    '"environment": "production" }`.',
  inputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 10, refillPerSec: 10 / 60 },
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("upload_order_document requires an authenticated user");
    }

    // Pre-flight 10MB cap. Enforced BEFORE JWT mint and BEFORE FormData
    // construction so abusive callers cost nothing upstream.
    if (args.file_base64.length > MAX_FILE_BASE64_CHARS) {
      throw new Error(
        `file_base64 exceeds 10MB cap (${MAX_FILE_BASE64_CHARS} base64 chars); split or compress before uploading`,
      );
    }

    // Filename hygiene — strip both POSIX and Windows path separators.
    const safeFilename = args.filename.replace(/[\\/]/g, "_");

    // Apply defaults locally — the SDK may not always pre-fill .default()
    // values (see register.ts comment on z.input vs z.infer).
    const documentType = args.document_type ?? "proof_of_delivery";
    const adminOverride = args.admin_override ?? true;

    const jwt = await jwtFor(auth, args.environment);

    const fileBytes = Buffer.from(args.file_base64, "base64");
    const fd = new FormData();
    fd.append(
      "file",
      new Blob([new Uint8Array(fileBytes)], { type: args.content_type }),
      safeFilename,
    );
    fd.append("document_type", documentType);
    fd.append("admin_override", String(adminOverride));

    const client = new OrdersCoreRestClient({
      jwt,
      environment: args.environment,
    });

    const path = `/orders-by-client-id/${encodeURIComponent(
      String(args.client_order_id),
    )}/documents`;
    const data = await client.requestMultipart("POST", path, fd);

    return {
      content: [
        { type: "text" as const, text: JSON.stringify(data, null, 2) },
      ],
    };
  },
};
