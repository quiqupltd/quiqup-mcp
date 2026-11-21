/**
 * `repair_integration_orders` — re-run a batch of failed integration orders
 * via platform-api.quiqup.com (Phase 2 / INTG-04).
 *
 * Endpoint: POST https://platform-api.quiqup.com/integrations/repair-orders
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json, Content-Type: application/json
 *
 * Per source-doc lines 1145-1167 (authoritative) the body shape is:
 *   { ids: string[], order_name, shop_name, site_url, source, user_id,
 *     start_date, end_date }
 *
 * The `ids` array is capped at 50 client-side (T-02-04: mass-repair abuse
 * mitigation) — combined with the 5/min rate-limit guardrail that bounds
 * runaway agents to 250 repair attempts per minute.
 *
 * Companion tools:
 *   - `list_integration_order_reasons` (INTG-03) → discover failed orders to repair.
 *   - `get_integration_order` (INTG-05) → re-fetch the envelope after repair to
 *     confirm the new state.
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform`).
 *   - 422       → validation failure (inspect body — likely a bad source value
 *                 or date range).
 *   - 5xx       → upstream temporarily unavailable, retry.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl, integrationSourceField } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({
  ids: z
    .array(z.string().min(1))
    .min(1)
    .max(50)
    .describe(
      "Integration order ids to repair. Look these up via " +
        "`list_integration_order_reasons[].id`. Batch is capped at 50 ids per " +
        "call — split larger jobs across multiple calls.",
    ),
  order_name: z
    .string()
    .min(1)
    .describe(
      "Order-name filter, typically the storefront order name (e.g. '#1234').",
    ),
  shop_name: z.string().min(1),
  site_url: z
    .string()
    .describe(
      "Storefront URL of the source shop, e.g. https://acme.myshopify.com.",
    ),
  // 02-REVIEW WR-05: shared `integrationSourceField` (see quiqup-env.ts) so
  // the read/write source enums move together.
  source: integrationSourceField.describe(
    "Source channel — must match what `list_integration_connections` " +
      "returns for this shop.",
  ),
  // NOTE: `user_id` is intentionally NOT a caller arg (02-REVIEW BL-04). The
  // handler binds it to `auth.userId` server-side from the JWT subject so an
  // LLM cannot supply a foreign user_id and have repair-orders mutate another
  // tenant's records. The upstream body still receives `user_id`; the LLM
  // doesn't get to choose its value.
  // 02-REVIEW WR-02: enforce ISO-8601 date-time format on both bounds.
  start_date: z
    .string()
    .datetime({
      message: "must be ISO-8601 date-time, e.g. 2026-05-01T00:00:00Z",
    })
    .describe(
      "ISO-8601 date-time inclusive lower bound — typically the same window " +
        "passed to `list_integration_order_reasons`.",
    ),
  end_date: z
    .string()
    .datetime({
      message: "must be ISO-8601 date-time, e.g. 2026-05-19T00:00:00Z",
    })
    .describe("ISO-8601 date-time exclusive upper bound."),
  idempotency_key: z
    .string()
    .optional()
    .describe(
      "Optional caller-supplied key to dedupe retries within a 15-minute " +
        "window. Strongly recommended on repair batches — a retry-after-blip " +
        "without this key may re-attempt already-repaired ids and pollute " +
        "the upstream error counters.",
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "repair_integration_orders",
  description:
    "Re-run a batch of failed integration orders via " +
    "POST /integrations/repair-orders on platform-api.quiqup.com. " +
    "Response shape: `{ orders_processed, orders_created, message, errors[] }`. " +
    "The `errors[]` array names per-id rejection reasons — agents should " +
    "re-call `get_integration_order` on a sample of `orders_created` to " +
    "confirm the repair landed in the expected state. " +
    "Pair with `list_integration_order_reasons` to discover the ids of " +
    "currently-failed orders. `ids` are CAPPED at 50 per call (client-side); " +
    "split larger jobs across multiple calls. Rate-limit: 5 calls / minute. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 422 → " +
    "validation failure (inspect body — typically a bad source value or " +
    "date range); 5xx → upstream temporarily unavailable, retry. " +
    "Owner identity: the upstream `user_id` is BOUND server-side to the " +
    "authenticated JWT subject — there is no caller arg for it (02-REVIEW BL-04). " +
    'Example: `{ "ids": ["12345", "12346"], "order_name": "#1234", ' +
    '"shop_name": "acme", "site_url": "https://acme.myshopify.com", ' +
    '"source": "shopify", ' +
    '"start_date": "2026-05-01T00:00:00Z", ' +
    '"end_date": "2026-05-19T00:00:00Z" }`.',
  inputSchema,
  outputSchema,
  // Repair batches should be rare; the per-batch cap is already 50, so 5/min
  // bounds runaway agents to 250 repair attempts per minute.
  guardrails: {
    rateLimit: { capacity: 5, refillPerSec: 5 / 60 },
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error(
        "repair_integration_orders requires an authenticated user",
      );
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);

    // Build the upstream body from input fields only — explicitly omit
    // `idempotency_key` and `environment` (those are tool-level concerns,
    // not upstream API fields).
    // `user_id` is BOUND to auth.userId server-side (02-REVIEW BL-04) — the
    // JWT subject is the canonical owner identity for repair operations.
    const body = {
      ids: args.ids,
      order_name: args.order_name,
      shop_name: args.shop_name,
      site_url: args.site_url,
      source: args.source,
      user_id: auth.userId,
      start_date: args.start_date,
      end_date: args.end_date,
    };

    const res = await fetch(`${platformApiBase}/integrations/repair-orders`, {
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

// ---------------------------------------------------------------------------
// Agent door (`/agent/mcp`) variant
// ---------------------------------------------------------------------------
//
// Same upstream route, narrower contract, for server agents acting as one
// merchant (route facts: briefs/f28-write-routes.md, "Re-push a failed store
// order"):
//   - specific ids only. NO date range is accepted or sent, ever.
//   - `user_id` is NOT sent: the upstream forces the user to the caller (the
//     token's merchant); `auth.userId` here is `platform:<salesforceId>`,
//     which is not a platform user id.
//   - `location_id: 0` is sent explicitly, as the merchant app does.
//   - `ids` are shop order names ('#1307' / '1307') or Shopify legacy ids
//     (>= 10 digits). Capped at 10 per call (the /mcp tool allows 50).
// The upstream is async: it answers { workflow_id, status: "running" }. The
// outcome is read from GET /integrations/repair-orders/status?workflow_id=...,
// which no agent-door tool exposes yet (see the PR C report).

const agentInputSchema = z.object({
  ids: z
    .array(z.string().min(1))
    .min(1)
    .max(10)
    .describe(
      "Specific store order ids to re-push: the shop order name ('#1307' or '1307') " +
        "or the Shopify legacy id (10+ digits). 1 to 10 per call. Never a date range.",
    ),
  source: integrationSourceField.describe(
    "Store platform the orders came from: shopify, woocommerce or salla.",
  ),
  shop_name: z.string().min(1).optional().describe("Shop name, when the merchant has several shops."),
  site_url: z
    .string()
    .optional()
    .describe("Storefront URL of the shop, e.g. https://acme.myshopify.com (WooCommerce / Salla)."),
  idempotency_key: z
    .string()
    .optional()
    .describe("Optional key: duplicate calls with the same key within 15 minutes return the cached result."),
  environment: environmentField,
});

export const agentSpec: ToolSpec<typeof agentInputSchema, typeof outputSchema> = {
  name: "repair_integration_orders",
  description:
    "Re-push specific failed store orders (Shopify, WooCommerce or Salla) to Quiqup via " +
    "POST /integrations/repair-orders on platform-api, as the merchant. Pass specific order " +
    "ids only (1 to 10); a date range is not accepted. Safe to repeat: an order that already " +
    "exists is skipped. The upstream is asynchronous and answers { workflow_id, status: " +
    '"running" }; the orders are created shortly after, so read them back later rather than ' +
    "retrying immediately. Rate-limit: 5 calls / minute per merchant.",
  inputSchema: agentInputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 5, refillPerSec: 5 / 60 },
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("repair_integration_orders requires an authenticated user");
    }
    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);

    const body: Record<string, unknown> = {
      source: args.source,
      ids: args.ids,
      location_id: 0,
    };
    if (args.shop_name) body.shop_name = args.shop_name;
    if (args.site_url) body.site_url = args.site_url;

    const res = await fetch(`${platformApiBase}/integrations/repair-orders`, {
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
