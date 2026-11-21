/**
 * `set_delivery_complete_batch` — staging-only QA helper.
 *
 * Moves one or more Last-Mile orders to the terminal "delivery complete"
 * state via PUT /orders/batch/set_delivery_complete. Lifted from the
 * `Quiqup Staging State Change` Postman collection that the ops team uses
 * to walk an order through its state machine for end-to-end tests.
 *
 * STAGING ONLY: see header on `set-out-for-delivery-batch.ts` — same
 * rationale. The `environment` arg is pinned via `z.literal("staging")`.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupLastmileClient } from "@/lib/clients/quiqup-lastmile";
import { ENVIRONMENT_DESCRIPTION } from "@/lib/clients/quiqup-env";
import { jwtFor } from "@/lib/caller-auth";

const inputSchema = z.object({
  order_ids: z
    .array(z.number().int().positive())
    .min(1)
    .max(10)
    .describe("Quiqup Last-Mile order IDs (numeric, up to 10 per call)."),
  idempotency_key: z.string().optional(),
  environment: z
    .literal("staging")
    .default("staging")
    .describe(
      `${ENVIRONMENT_DESCRIPTION} This tool is STAGING-ONLY — any other value is rejected.`,
    ),
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "set_delivery_complete_batch",
  description:
    "STAGING-ONLY. Transition one or more Last-Mile orders to the terminal " +
    "`delivery_complete` state (PUT /orders/batch/set_delivery_complete, up " +
    "to 10 orders per call). Used to walk orders through their state " +
    "machine for end-to-end tests; not available against production. Supply " +
    "an optional `idempotency_key` to make retries safe within a 15-minute " +
    "window.",
  inputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 5, refillPerSec: 5 / 60 },
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error(
        "set_delivery_complete_batch requires an authenticated user",
      );
    }
    const jwt = await jwtFor(auth, args.environment);
    const client = new QuiqupLastmileClient({ jwt, environment: "staging" });
    const data = await client.request("PUT", "/orders/batch/set_delivery_complete", {
      body: { order_ids: args.order_ids },
    });
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Moved ${args.order_ids.length} order(s) to delivery_complete on staging.\n\n` +
            `Upstream response:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  },
};
