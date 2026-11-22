/**
 * `create_internal_fulfilment_order` — Phase 4 / ORDC-04.
 *
 * Endpoint: POST https://platform-api.quiqup.com/internal/fulfilment/orders
 * Headers:  Authorization: Bearer <session-JWT>, Accept: application/json,
 *           Content-Type: application/json
 *
 * Phase semantics: this tool creates an INTERNAL fulfilment order — the
 * "warehouse pick-pack-ship" variant of the Quiqup order surface. Compare
 * `create_lastmile_order` (ORDC-01, existing) which creates a
 * point-to-point delivery order without warehouse pick-pack. Use this
 * tool when the order's products live in Quiqup-operated stock that
 * needs picking before dispatch; use create_lastmile_order when the
 * partner ships from their own warehouse.
 *
 * Body shape (per source-doc §6 line 2319 `POST /internal/fulfilment/orders`):
 *   Required: needs_manual_confirmation, origin_address, partner_order_id,
 *             payment_amount, payment_mode, service_kind, shipping_address,
 *             source.
 *   Optional: billing_address, billing_identifier, carrier, currency,
 *             delivery_options, incoterm, initial_order_id, is_return,
 *             mark_as_ready_for_collection, notes, products,
 *             registration_numbers.
 *
 * Identity binding (BL-04 server-side):
 *   The input schema has NO `user_id` / `actor_id` / `actor_email` /
 *   `partner_id` field. The partner identity is bound server-side from
 *   `auth.userId` via the V3b same-IdP exchange — the upstream gateway
 *   already resolves the partner from the session JWT, so caller-
 *   supplied identity is at best ignored and at worst a cross-tenant
 *   smuggling vector. Locked out by the schema shape itself.
 *
 * Guardrails (BL-01 canonical write-tool pattern):
 *   - rateLimit 10/min — order creation should be rare; bursts are misuse.
 *   - idempotency on `idempotency_key` (15min TTL) — safe retries.
 *   - audit: true — repudiation defence + Wave-3 BL-01 inherited pattern.
 *
 * NOT destructive-gated: no resource is overwritten. The downstream
 * `create_mission` companion (MISS-01) is also non-destructive per D-05.
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform`).
 *   - 422       → upstream validation rejection — inspect attribute_errors
 *                 in the response body for the offending field.
 *   - 5xx       → upstream temporarily unavailable, retry.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { PlatformApiClient } from "@/lib/clients/platform-api";
import { environmentField } from "@/lib/clients/quiqup-env";
import { jwtFor } from "@/lib/caller-auth";

// Address shape — matches source-doc §6 line 2324..2340 (billing_address)
// and §6 line 2351..2367 (origin_address / shipping_address). The three
// addresses share the SAME shape on the wire so we reuse one Zod schema.
const addressSchema = z.object({
  address1: z.string().min(1),
  address2: z.string().optional(),
  city: z.string().min(1),
  coordinate: z.record(z.string(), z.unknown()).optional(),
  country: z.string().optional(),
  country_code: z.string().min(1),
  email: z.string().min(1),
  first_name: z.string().min(1),
  ksa_national_address: z.string().optional(),
  last_name: z.string().optional(),
  name: z.string().optional(),
  notes: z.string().optional(),
  phone: z.string().min(1),
  postcode: z.string().optional(),
  state: z.string().optional(),
});

const inputSchema = z.object({
  // Required body fields per source-doc §6.
  needs_manual_confirmation: z
    .boolean()
    .describe(
      "If true the order is held in a pre-confirmation state until a " +
        "manual step releases it; if false the order proceeds straight " +
        "to fulfilment. Per source-doc §6 the field is required (not " +
        "defaulted upstream) so we keep it required client-side too.",
    ),
  origin_address: addressSchema.describe(
    "Pick-up / origin address. Required per source-doc §6.",
  ),
  partner_order_id: z
    .string()
    .min(1)
    .describe(
      "Partner-supplied order identifier — the partner's own reference " +
        "for this order. Must be unique within the partner's namespace.",
    ),
  payment_amount: z
    .number()
    .describe("Order total in the smallest unit of `currency` (or 0 for prepaid)."),
  payment_mode: z
    .string()
    .min(1)
    .describe(
      "Payment mode (typical values: 'prepaid', 'cod'). Free-form string " +
        "to avoid hardcoding an enum that drifts when upstream adds modes.",
    ),
  service_kind: z
    .string()
    .min(1)
    .describe(
      "Service tier (e.g. 'same_day', 'next_day'). Call `list_service_kinds` " +
        "to discover valid values for the current partner.",
    ),
  shipping_address: addressSchema.describe(
    "Destination / shipping address. Required per source-doc §6.",
  ),
  source: z
    .string()
    .min(1)
    .describe(
      "Channel marker for analytics / routing — e.g. 'shopify', 'manual', " +
        "'api'. Free-form per source-doc §6.",
    ),
  // Optional body fields.
  billing_address: addressSchema.optional(),
  billing_identifier: z.string().optional(),
  carrier: z.string().optional(),
  currency: z.string().optional(),
  delivery_options: z.array(z.string()).optional(),
  incoterm: z.string().optional(),
  initial_order_id: z.string().optional(),
  is_return: z.boolean().optional(),
  mark_as_ready_for_collection: z.boolean().optional(),
  notes: z.string().optional(),
  products: z
    .array(
      z.object({
        quantity: z.number().int().positive(),
        sku: z.string().min(1),
      }),
    )
    .optional()
    .describe("Per-product line items (sku + quantity)."),
  registration_numbers: z
    .array(
      z.object({
        issuer_country_code: z.string().min(1),
        type_code: z.string().min(1),
        value: z.string().min(1),
      }),
    )
    .optional(),
  // Idempotency + environment — wrapper-consumed, NOT forwarded in body.
  idempotency_key: z
    .string()
    .optional()
    .describe(
      "Optional client-supplied key. Duplicate calls with the same key " +
        "within 15 minutes return the cached result without re-firing " +
        "the upstream POST. NOT included in the upstream body — consumed " +
        "by the registerTool wrapper for the idempotency cache key.",
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "create_internal_fulfilment_order",
  description:
    "POST /internal/fulfilment/orders (Platform host — platform-api.quiqup.com). " +
    "Create an INTERNAL fulfilment order — the 'warehouse pick-pack-ship' " +
    "variant of the Quiqup order surface. Use this when the order's products " +
    "live in Quiqup-operated stock that needs picking before dispatch. " +
    "Use `create_lastmile_order` (ORDC-01) instead when the partner ships " +
    "from their own warehouse and Quiqup is only the last-mile carrier. " +
    "Required body: needs_manual_confirmation, origin_address, " +
    "shipping_address, partner_order_id, payment_amount, payment_mode, " +
    "service_kind, source. Optional: billing_address, products, " +
    "registration_numbers, delivery_options, plus several metadata fields. " +
    "Identity binding: this tool does NOT accept caller-supplied user/" +
    "actor/partner fields. The partner identity is bound server-side to " +
    "the authenticated user (auth.userId) via the V3b same-IdP exchange. " +
    "Idempotency: pass `idempotency_key` to dedupe retries within 15 min. " +
    "NOT destructive-gated — order creation is additive, no resource is " +
    "overwritten. Error modes: 401/403 → auth issue (run `whoami_platform`); " +
    "422 → validation error (inspect attribute_errors in body); 5xx → retry.",
  inputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 10, refillPerSec: 10 / 60 },
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error(
        "create_internal_fulfilment_order requires an authenticated user",
      );
    }

    // Strip wrapper-only fields from the upstream body. `idempotency_key`
    // is consumed by the registerTool wrapper (not forwarded), and
    // `environment` selects the cluster (also not forwarded).
    const { idempotency_key: _idem, environment: _env, ...body } = args;
    // Reference suppressed-vars so unused-imports rules don't complain.
    void _idem;
    void _env;

    const jwt = await jwtFor(auth, args.environment);
    const client = new PlatformApiClient({
      jwt,
      environment: args.environment,
    });
    const data = await client.request("POST", "/internal/fulfilment/orders", {
      body,
    });

    return {
      content: [
        { type: "text" as const, text: JSON.stringify(data, null, 2) },
      ],
    };
  },
};
