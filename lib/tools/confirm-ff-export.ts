/**
 * `confirm_ff_export` — acknowledge that a fulfilment-order export was
 * received and persisted on the Quiqup side (Phase 2 / INTG-06).
 *
 * Endpoint: POST https://platform-api.quiqup.com/orders/confirm-ff-export
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json, Content-Type: application/json
 *
 * Per source-doc lines 1414-1425 (authoritative) the body shape is:
 *   { order_uuid: string }
 *
 * The `order_uuid` arg is bounded by `z.string().min(1)` to refuse empty
 * values at the schema layer (T-02-05). Upstream returns 404 if the uuid
 * does not exist — surfaced to the agent via QuiqupHttpError.
 *
 * Companion tools:
 *   - `get_integration_order` (INTG-05) → re-fetch the envelope to confirm
 *     `status` flipped after the ack.
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform`).
 *   - 404       → no such order_uuid.
 *   - 422       → validation failure (inspect body).
 *   - 5xx       → upstream temporarily unavailable, retry.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({
  order_uuid: z
    .string()
    .min(1)
    .describe(
      "Fulfilment order UUID — matches the order envelope's `uuid` field " +
        "from `get_integration_order`.",
    ),
  idempotency_key: z
    .string()
    .optional()
    .describe(
      "Optional caller-supplied key to dedupe retries within a 15-minute " +
        "window. Recommended when the caller is a webhook-driven retry loop.",
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "confirm_ff_export",
  description:
    "Acknowledge (confirm) that an integration-side fulfilment-order export " +
    "was received and persisted, via POST /orders/confirm-ff-export on " +
    "platform-api.quiqup.com. " +
    "Response shape: `{ result: string }`. " +
    "This is typically the FINAL step after a Shopify/WooCommerce/Salla " +
    "webhook lands an order: the integration emits the export, Quiqup " +
    "persists it, and the agent calls `confirm_ff_export` to ack. Without " +
    "this ack the upstream may keep retrying the export. " +
    "Pair with `get_integration_order` to re-fetch the envelope after the " +
    "ack and confirm `status` transitioned. Rate-limit: 30 calls / minute. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 404 → " +
    "no such order_uuid (verify against the envelope returned by " +
    "`get_integration_order`); 422 → validation failure (inspect body); " +
    "5xx → upstream temporarily unavailable, retry. " +
    'Example: `{ "order_uuid": "5a8b4e2f-1234-4abc-9def-abcdef012345" }`.',
  inputSchema,
  outputSchema,
  // Read-light write — webhook-driven acks come in pulses. 30/min is enough
  // for a normal pulse but bounds runaway loops.
  guardrails: {
    rateLimit: { capacity: 30, refillPerSec: 30 / 60 },
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("confirm_ff_export requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);

    // Body is exactly { order_uuid } — explicitly omit `idempotency_key`
    // and `environment` (tool-level, not upstream fields).
    const body = { order_uuid: args.order_uuid };

    const res = await fetch(`${platformApiBase}/orders/confirm-ff-export`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new QuiqupHttpError(res.status, await res.text());
    }

    const data = await res.json();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
};
