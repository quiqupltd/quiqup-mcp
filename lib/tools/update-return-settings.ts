/**
 * `update_return_settings` — update the partner's return-policy settings on
 * platform-api.quiqup.com (Phase 1 / AUTH-12).
 *
 * Endpoint: PUT https://platform-api.quiqup.com/api/accounts/{accountID}/return-settings
 * Headers:  Authorization: Bearer <session-JWT>,
 *           Accept: application/json, Content-Type: application/json
 *
 * NOTE on path prefix:
 *   /api/accounts/{accountID}/... — NOT /accounts/{id}/.... Source-doc
 *   lines 134-141 are authoritative.
 *
 * Partial-update semantics — only fields included in the call are mutated;
 * pair with `get_return_settings` to confirm the post-update state.
 *
 * Twin read: `get_return_settings` (AUTH-11).
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform`).
 *   - 422       → validation failure (inspect body).
 *   - 5xx       → upstream temporarily unavailable; retry.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({
  account_id: z
    .string()
    .min(1)
    .default("me")
    .describe(
      'Account id; "me" resolves to the signed-in partner. The id travels in ' +
        "the URL path, NOT in the request body.",
    ),
  return_window_days: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Number of days a return is accepted after delivery."),
  allowed_reasons: z
    .array(z.string())
    .optional()
    .describe(
      "Allowed return reasons (free-form codes; the upstream validates the set).",
    ),
  settings: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Open settings blob — additional return-policy knobs."),
  idempotency_key: z
    .string()
    .optional()
    .describe(
      "Optional caller-supplied key to dedupe retries within a 15-minute " +
        "window.",
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "update_return_settings",
  description:
    "Update the partner's return-policy settings via " +
    "PUT /api/accounts/{account_id}/return-settings on platform-api.quiqup.com. " +
    "Partial update — only fields included in the call are mutated; pair with " +
    "`get_return_settings` to confirm the post-update state. " +
    "The `account_id` field travels in the URL path, not the request body. " +
    "Path prefix note: this endpoint lives under /api/accounts/... (NOT the " +
    "/accounts/... prefix used elsewhere in this surface). " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 422 → " +
    "validation failure (inspect body); 5xx → retry. " +
    'Example: `{ "account_id": "me", "return_window_days": 14, "allowed_reasons": ["damaged", "wrong_item"] }`.',
  inputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 10, refillPerSec: 10 / 60 },
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("update_return_settings requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);
    const accountId = args.account_id ?? "me";
    const url = `${platformApiBase}/api/accounts/${encodeURIComponent(accountId)}/return-settings`;

    // Build body from only the fields the caller actually supplied. Note:
    // account_id and environment are deliberately excluded — account_id goes
    // in the path, environment is a client-side selector.
    const body: Record<string, unknown> = {};
    if (args.return_window_days !== undefined)
      body.return_window_days = args.return_window_days;
    if (args.allowed_reasons !== undefined)
      body.allowed_reasons = args.allowed_reasons;
    if (args.settings !== undefined) {
      // Bound the serialised settings blob — same rationale as
      // update_account: an LLM emitting a giant nested object would
      // otherwise ship MBs upstream and balloon the audit-log line.
      const serialised = JSON.stringify(args.settings);
      if (serialised.length > 64_000) {
        throw new Error(
          "settings blob exceeds 64KB; narrow the payload to just the keys you intend to update",
        );
      }
      body.settings = args.settings;
    }

    const res = await fetch(url, {
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
