/**
 * `create_order_charge` (ORDS-06) — create a one-off charge against a
 * Quiqup order via POST /quiqdash/order-charge on platform-api.quiqup.com.
 *
 * Use cases: extra-weight surcharge, COD adjustment, customer reimbursement,
 * any single-line charge that doesn't fit the original order pricing.
 *
 * Endpoint: POST https://platform-api.quiqup.com/quiqdash/order-charge
 *           Body:  { order_id, amount, currency, description? }
 *           Auth:  Bearer <session-JWT>
 *
 * Phase-4 / Wave-3 single-order mutation. Direct handler (no factory).
 *
 * NOT destructive-gated — this is a CREATE, not an in-place state
 * mutation. The Phase-2 destructive contract is about "would-not-want-to-
 * undo" deletes / state-overwrites; a one-off charge can be voided via
 * a follow-up tool. The risk this tool DOES carry is runaway-agent
 * abuse (T-04-13: "agent decides to charge 1,000,000 AED"), so the
 * `amount` field has a client-side cap.
 *
 * Threat-register mitigation (T-04-13):
 *   `amount: z.number().positive().max(100_000)` — rejects negative,
 *   zero, and absurd values at Zod parse-time, BEFORE the JWT mint and
 *   BEFORE the upstream POST. 100,000 is a generous cap on a single
 *   line-item charge in any of the currencies Quiqup currently
 *   supports; legitimate larger amounts can be split across multiple
 *   charges with explicit caller intent.
 *
 * Guardrails: 5/min rate-limit (charges should be infrequent but
 * not as throttled as the canonical 3/min destructive cap),
 * idempotency-key for safe retry, audit on (financial side-effect).
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { PlatformApiClient } from "@/lib/clients/platform-api";
import { environmentField } from "@/lib/clients/quiqup-env";
import { jwtFor } from "@/lib/caller-auth";
import { assertOrderOwned } from "@/lib/caller-auth";

const inputSchema = z.object({
  order_id: z
    .string()
    .min(1)
    .describe(
      "Quiqup order id to attach the charge to. Per-order scope-checked " +
        "under your session before the POST runs.",
    ),
  amount: z
    .number()
    .positive()
    .max(100_000)
    .describe(
      "Charge amount in the order's currency. Capped at 100,000 to " +
        "prevent runaway-agent abuse (T-04 threat register T-04-13). " +
        "Must be strictly positive. Currency interpretation is determined " +
        "by the `currency` field; confirm via `get_lastmile_order` or " +
        "`find_order_by_id_or_barcode` if uncertain which currency the " +
        "order is billed in.",
    ),
  currency: z
    .string()
    .min(3)
    .max(8)
    .describe(
      "ISO 4217 currency code (e.g., AED, USD, GBP). Should match the " +
        "order's currency — confirm via `get_lastmile_order` or " +
        "`find_order_by_id_or_barcode` if uncertain.",
    ),
  description: z
    .string()
    .optional()
    .describe(
      "Optional human-readable description of the charge — surfaced on " +
        "the invoice / receipt sent to the merchant. Recommended for " +
        "auditability ('extra weight surcharge', 'COD reimbursement', etc.).",
    ),
  idempotency_key: z
    .string()
    .optional()
    .describe(
      "Optional caller-supplied key to dedupe retries within a 15-minute " +
        "window. RECOMMENDED for financial side-effects — at-least-once " +
        "agent retries without this key can pile up duplicate charges.",
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "create_order_charge",
  description:
    "Create a one-off charge against an order — e.g., extra-weight " +
    "surcharge, COD adjustment, customer reimbursement. Endpoint: " +
    "POST /quiqdash/order-charge (platform-api.quiqup.com). Per-order " +
    "scope-checked under the caller's session BEFORE the POST runs " +
    "(T-04-16 — no cross-tenant charges). Amount is capped at 100,000 " +
    "in the chosen currency to prevent agent abuse (T-04-13); larger " +
    "legitimate amounts can be split across multiple charges with " +
    "explicit caller intent. " +
    "Idempotency: RECOMMENDED — supply `idempotency_key` to make " +
    "at-least-once retries safe within 15 minutes. Without it, a " +
    "retried call after a transient network blip can pile up duplicate " +
    "charges on the merchant's invoice. " +
    "Returns the created charge resource (including its upstream id). " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 404 → " +
    "order not visible under your session (scope assertion catches this " +
    "before the POST); 4xx → BE rejected the charge (e.g. order in a " +
    "non-chargeable state); 5xx → upstream temporarily unavailable, " +
    "retry with the SAME idempotency_key. " +
    'Example: `{ "order_id": "12345", "amount": 25.5, "currency": "AED", ' +
    '"description": "Extra weight surcharge", "environment": "production" }`.',
  inputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 5, refillPerSec: 5 / 60 }, // 5/min — financial side-effect
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    // 1. Auth gate (T-04-17 — outermost).
    if (!auth.userId) {
      throw new Error("create_order_charge requires an authenticated user");
    }

    // 2. Per-order scope assertion (T-04-16) — refuse cross-tenant
    //    charges BEFORE the POST lands.
    await assertOrderOwned(auth, args.order_id, args.environment);

    // 3. Mint JWT, build the Platform API client, fire the POST.
    const jwt = await jwtFor(auth, args.environment);
    const client = new PlatformApiClient({
      jwt,
      environment: args.environment,
    });

    // Body: order_id + amount + currency + (optional) description. The
    // Zod schema has already rejected amount > 100_000 / amount <= 0 /
    // missing required fields by this point.
    const body: Record<string, unknown> = {
      order_id: args.order_id,
      amount: args.amount,
      currency: args.currency,
    };
    if (args.description !== undefined) {
      body.description = args.description;
    }

    const data = await client.request("POST", "/quiqdash/order-charge", {
      body,
    });

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Created charge of ${args.amount} ${args.currency} on order ${args.order_id}.\n\n` +
            `Upstream response:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  },
};
