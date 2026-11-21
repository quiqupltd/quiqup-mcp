/**
 * `update_partner_address` — partial-update an existing partner address-book
 * entry on platform-api.quiqup.com (Phase 1 / ADDR-03).
 *
 * Endpoint: PATCH https://platform-api.quiqup.com/partner/addresses/{id}
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json, Content-Type: application/json
 *
 * Partial update semantics: only fields included in the call are mutated
 * upstream — omitted fields are left as-is. Mirrors the `create_partner_address`
 * shape (top-level scalars; no `references` field — see poison-memory note
 * in create_partner_address.ts).
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
  id: z.string().min(1, "id is required"),
  address1: z.string().optional(),
  address2: z.string().optional(),
  apartment_number: z.string().optional(),
  town: z.string().optional(),
  country: z
    .string()
    .length(2, "country must be ISO-3166 alpha-2 (e.g. 'AE')")
    .optional()
    .describe("ISO-3166 alpha-2 country code, e.g. 'AE'"),
  coordinates: z
    .object({
      lat: coordinate.optional(),
      lng: coordinate.optional(),
    })
    .refine((c) => c.lat !== undefined || c.lng !== undefined, {
      message: "coordinates: supply lat, lng, or both",
    })
    .optional()
    .describe(
      "Partial-update friendly: supply lat, lng, or both. Omitting either " +
        "leaves the existing upstream value unchanged.",
    ),
  contact_name: z.string().optional(),
  contact_phone: z.string().optional(),
  label: z.string().optional(),
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
  name: "update_partner_address",
  description:
    "Partial update of a partner address-book entry. " +
    "Endpoint: PATCH platform-api.quiqup.com/partner/addresses/{id}. " +
    "Partial update; only fields included in the call are mutated upstream. " +
    "Mirrors `create_partner_address`'s shape (top-level scalars only — do " +
    "NOT pass a `references` array; see poison-memory note). " +
    "Use `list_account_addresses` afterward to confirm the patch landed. " +
    "Error modes: 401/403 = auth issue (run `whoami_platform`); 404 = the " +
    "address id is not visible to this user; 422 = validation failure on " +
    "the supplied fields. " +
    'Example: `{ "id": "addr_123", "label": "Renamed Warehouse" }`.',
  inputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 10, refillPerSec: 10 / 60 },
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("update_partner_address requires an authenticated user");
    }
    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);

    const body: Record<string, unknown> = {};
    if (args.address1 !== undefined) body.address1 = args.address1;
    if (args.address2 !== undefined) body.address2 = args.address2;
    if (args.apartment_number !== undefined)
      body.apartment_number = args.apartment_number;
    if (args.town !== undefined) body.town = args.town;
    if (args.country !== undefined) body.country = args.country;
    if (args.coordinates !== undefined) {
      // Partial-update semantics: only forward the lat / lng the caller
      // actually supplied. Sending `undefined` (or "undefined") for the
      // omitted axis would overwrite upstream state.
      const coordsOut: Record<string, string> = {};
      if (args.coordinates.lat !== undefined) {
        coordsOut.lat = String(args.coordinates.lat);
      }
      if (args.coordinates.lng !== undefined) {
        coordsOut.lng = String(args.coordinates.lng);
      }
      body.coordinates = coordsOut;
    }
    if (args.contact_name !== undefined) body.contact_name = args.contact_name;
    if (args.contact_phone !== undefined) body.contact_phone = args.contact_phone;
    if (args.label !== undefined) body.label = args.label;

    const res = await fetch(
      `${platformApiBase}/partner/addresses/${encodeURIComponent(args.id)}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    if (!res.ok) {
      throw new QuiqupHttpError(res.status, await res.text());
    }

    const data = await res.json();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
};
