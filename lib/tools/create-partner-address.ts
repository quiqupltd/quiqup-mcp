/**
 * `create_partner_address` — add a new entry to the partner address book on
 * platform-api.quiqup.com (Phase 1 / ADDR-02).
 *
 * Endpoint: POST https://platform-api.quiqup.com/partner/addresses
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json, Content-Type: application/json
 *
 * IMPORTANT — `references` poison memory:
 *   The order-creation endpoints have an upstream-poison `references` array
 *   that triggers obscure 422s when present alongside other identifiers. To
 *   avoid the LLM grafting that shape onto address payloads, this tool's
 *   schema deliberately uses TOP-LEVEL scalar fields only and DOES NOT
 *   expose any `references` field. Do not add one.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

// Reject NaN / Infinity at the schema layer so the handler never ships the
// literal string "NaN" upstream (the handler unconditionally String()s the
// value before sending). String form must be a numeric literal so that
// `Number(value)` is a finite, real number on the upstream side too.
const coordinate = z.union([
  z
    .number()
    .finite()
    .refine((n) => !Number.isNaN(n), "coordinate must be a real number"),
  z
    .string()
    .regex(/^-?\d+(\.\d+)?$/, "coordinate string must be a numeric literal"),
]);

const inputSchema = z.object({
  address1: z.string().min(1, "address1 is required"),
  address2: z.string().optional(),
  apartment_number: z.string().optional(),
  town: z.string().min(1, "town is required"),
  country: z
    .string()
    .length(2, "country must be ISO-3166 alpha-2 (e.g. 'AE')")
    .describe("ISO-3166 alpha-2 country code"),
  coordinates: z.object({ lat: coordinate, lng: coordinate }),
  contact_name: z.string().optional(),
  contact_phone: z.string().optional(),
  label: z
    .string()
    .optional()
    .describe('Human-readable label e.g. "Main Warehouse"'),
  idempotency_key: z
    .string()
    .optional()
    .describe(
      "Optional caller-supplied key to dedupe retries within a 15-minute window.",
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "create_partner_address",
  description:
    "Create a new partner address-book entry. " +
    "Endpoint: POST platform-api.quiqup.com/partner/addresses. " +
    "Required: address1, town, country (ISO-3166 alpha-2), coordinates {lat,lng}. " +
    "Optional: address2, apartment_number, contact_name, contact_phone, label. " +
    "Uses top-level scalar fields — do NOT pass a `references` array (known " +
    "upstream poison on order endpoints; mirrored here for consistency). " +
    "Pair with `list_account_addresses` to confirm the entry landed and " +
    "with `update_partner_address` for partial edits. " +
    "Error modes: 401/403 indicate an auth issue (run `whoami_platform`); " +
    "422 indicates upstream validation failed — inspect attribute_errors[] " +
    "for the rejected field. " +
    'Example: `{ "address1": "Warehouse 42, Al Quoz", "town": "Dubai", ' +
    '"country": "AE", "coordinates": { "lat": 25.13, "lng": 55.22 }, ' +
    '"label": "Main Warehouse" }`.',
  inputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 10, refillPerSec: 10 / 60 },
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("create_partner_address requires an authenticated user");
    }
    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);

    const body: Record<string, unknown> = {
      address1: args.address1,
      town: args.town,
      country: args.country,
      coordinates: {
        lat: String(args.coordinates.lat),
        lng: String(args.coordinates.lng),
      },
    };
    if (args.address2 !== undefined) body.address2 = args.address2;
    if (args.apartment_number !== undefined)
      body.apartment_number = args.apartment_number;
    if (args.contact_name !== undefined) body.contact_name = args.contact_name;
    if (args.contact_phone !== undefined) body.contact_phone = args.contact_phone;
    if (args.label !== undefined) body.label = args.label;

    const res = await fetch(`${platformApiBase}/partner/addresses`, {
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
