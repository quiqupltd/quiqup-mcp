/**
 * `update_account` — update the signed-in partner's account profile on
 * platform-api.quiqup.com (Phase 1 / AUTH-07).
 *
 * Endpoint: PUT https://platform-api.quiqup.com/accounts
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json, Content-Type: application/json
 *
 * AUTH-07 vs FIN-05 disambiguation (this is the CANONICAL policy carved into
 * the codebase — see STATE.md decision-log entry 2026-05-19):
 *   - `update_account` (this tool, AUTH-07) — broad partner profile payload
 *     covering general settings AND bank details. The upstream endpoint
 *     (PUT /accounts) is shared with finance's useUpdateBankDetails, so
 *     bank fields are present here per the source-doc reality.
 *   - `update_bank_details` (FIN-05, Phase 10, NOT YET IMPLEMENTED) —
 *     constrained bank-details-only variant against the same PUT /accounts.
 *     Narrower input schema; safer for bank-only mutations.
 *
 * Companion read: `get_account` (AUTH-03) reads the same resource. The
 * frontend invalidates `["get", "/account"]` after a successful PUT — agents
 * should re-read via get_account for the post-update view.
 *
 * IMPORTANT — `references` poison memory:
 *   The order-creation endpoints have an upstream-poison `references` array
 *   that triggers obscure 422s when present alongside other identifiers. The
 *   account-update endpoint does not use it, but to keep the poison out of
 *   LLM-visible schemas across this surface, this tool's schema deliberately
 *   uses TOP-LEVEL scalar fields only and DOES NOT expose any `references`
 *   field. Do not add one.
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform` to confirm the JWT resolves).
 *   - 422       → validation failure (inspect attribute_errors[]).
 *   - 5xx       → upstream temporarily unavailable; retry after a few seconds.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

// All fields optional — the frontend treats PUT /accounts as a partial-update
// upsert (see use-account.tsx:127 useUpdateAccount). Mirror that. `settings`
// is z.record() because upstream accepts an open blob there.
const inputSchema = z.object({
  name: z.string().optional(),
  display_name: z.string().optional(),
  contact_phone: z.string().optional(),
  contact_email: z.string().optional(),
  billing_email: z.string().optional(),
  default_currency: z.string().optional(),
  region_code: z.string().optional(),
  service_offering: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  bank_name: z.string().min(1).max(140).optional(),
  bank_account_number: z.string().min(4).max(34).optional(),
  bank_iban: z
    .string()
    .regex(
      /^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/i,
      "IBAN must start with two letters followed by two digits (ISO 13616)",
    )
    .optional(),
  bank_swift: z
    .string()
    .regex(
      /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/i,
      "SWIFT/BIC must be 8 or 11 characters (ISO 9362)",
    )
    .optional(),
  bank_account_holder: z.string().min(1).max(140).optional(),
  idempotency_key: z
    .string()
    .optional()
    .describe(
      "Optional caller-supplied key to dedupe retries within a 15-minute " +
        "window. Recommended when updating bank fields.",
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "update_account",
  description:
    "Update the partner's account profile via PUT /accounts. " +
    "This is the broad-payload variant of PUT /accounts. The same endpoint " +
    "is also wrapped by `update_bank_details` (FIN-05, Phase 10) as a " +
    "constrained bank-details-only variant. RULE: if you only need to " +
    "update bank fields (bank_name, bank_account_number, bank_iban, " +
    "bank_swift, bank_account_holder), prefer `update_bank_details` once it " +
    "exists — its narrower input schema is safer. Use `update_account` for " +
    "any non-bank field, or when mixing bank and non-bank fields in one call. " +
    "Use `get_account` (AUTH-03) to read the current state before mutating; " +
    "after a successful update, the frontend invalidates [\"get\", \"/account\"] " +
    "— agents should re-read for the post-update view. " +
    "All fields are optional (partial update). Do NOT pass a `references` " +
    "array — that is poison memory from the order endpoints and is not used here. " +
    "Error modes: 401/403 indicate an auth issue (run `whoami_platform`); " +
    "422 indicates upstream validation failure (inspect the body); 5xx is " +
    "upstream-unavailable — retry in a few seconds. " +
    'Example: `{ "display_name": "Acme Partner", "contact_phone": "+971501234567" }`.',
  inputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 10, refillPerSec: 10 / 60 },
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("update_account requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);

    // Build body from only the fields the caller actually supplied. Avoids
    // sending `undefined` keys upstream which can confuse partial-update
    // semantics on some Rails endpoints.
    const body: Record<string, unknown> = {};
    if (args.name !== undefined) body.name = args.name;
    if (args.display_name !== undefined) body.display_name = args.display_name;
    if (args.contact_phone !== undefined) body.contact_phone = args.contact_phone;
    if (args.contact_email !== undefined) body.contact_email = args.contact_email;
    if (args.billing_email !== undefined) body.billing_email = args.billing_email;
    if (args.default_currency !== undefined)
      body.default_currency = args.default_currency;
    if (args.region_code !== undefined) body.region_code = args.region_code;
    if (args.service_offering !== undefined)
      body.service_offering = args.service_offering;
    if (args.settings !== undefined) {
      // Bound the serialised settings blob — an LLM emitting a giant nested
      // object would otherwise ship MBs upstream and balloon the audit-log
      // line. 64KB is generous for real settings shapes but cheap to guard.
      const serialised = JSON.stringify(args.settings);
      if (serialised.length > 64_000) {
        throw new Error(
          "settings blob exceeds 64KB; narrow the payload to just the keys you intend to update",
        );
      }
      body.settings = args.settings;
    }
    if (args.bank_name !== undefined) body.bank_name = args.bank_name;
    if (args.bank_account_number !== undefined)
      body.bank_account_number = args.bank_account_number;
    if (args.bank_iban !== undefined) body.bank_iban = args.bank_iban;
    if (args.bank_swift !== undefined) body.bank_swift = args.bank_swift;
    if (args.bank_account_holder !== undefined)
      body.bank_account_holder = args.bank_account_holder;

    const res = await fetch(`${platformApiBase}/accounts`, {
      method: "PUT",
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
