/**
 * `decide_feature_flags_bulk` — evaluate the feature-flag set for the
 * current account on platform-api.quiqup.com (Phase 1 / AUTH-10).
 *
 * Endpoint: POST https://platform-api.quiqup.com/featureflags/decide-bulk
 * Headers:  Authorization: Bearer <session-JWT>,
 *           Accept: application/json, Content-Type: application/json
 *
 * Request body (per docs/quiqup-api-full-frontend-extract.md):
 *   { Features: string[], Identifier: string }
 *
 * SECURITY INVARIANT (T-01-18 in PLAN.md):
 *   `Identifier` is sourced server-side from `auth.userId` (the Clerk
 *   subject). It is NOT accepted as a tool input. Even if the LLM tries to
 *   smuggle an `Identifier` field via args, the handler builds the upstream
 *   body from the auth context only — so the agent cannot decide flags for
 *   an arbitrary account via this tool. This is the must-have
 *   "decide_feature_flags_bulk binds the input Identifier to the caller's
 *   Clerk session" baked into code.
 *
 * Note: the frontend defaults to all-enabled on upstream failure (graceful
 * degradation in the UI). DO NOT replicate that fallback here — surface
 * errors honestly via QuiqupHttpError so the agent sees the real upstream
 * state instead of silently believing all flags are on.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({
  features: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      'Feature flag names to evaluate, e.g. ["new_dashboard", "experimental_export"]',
    ),
  environment: environmentField,
});

const outputSchema = z.record(z.string(), z.unknown());

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "decide_feature_flags_bulk",
  description:
    "Evaluate the feature-flag set for the current account via " +
    "POST /featureflags/decide-bulk on platform-api.quiqup.com. Returns the " +
    "flag map for the requested feature names. " +
    "The flag-evaluation Identifier is bound to your Clerk session — you " +
    "cannot evaluate flags for another account via this tool. If you need " +
    "cross-account flag inspection, that is an admin scope not exposed in " +
    "this MCP. " +
    "Unlike the QuiqDash frontend (which defaults to all-enabled on upstream " +
    "failure as graceful UI degradation), this tool surfaces upstream errors " +
    "honestly via QuiqupHttpError — do not assume a flag is on if the call " +
    "fails. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 5xx → retry. " +
    'Example: `{ "features": ["new_dashboard", "experimental_export"] }`.',
  inputSchema,
  outputSchema,
  // Read-shaped POST: no idempotency or rate-limit needed, but audit IS
  // emitted because the response reveals the partner's feature surface
  // (useful trail if a session ever asks "what flags did we evaluate?").
  guardrails: {
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("decide_feature_flags_bulk requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);

    // SECURITY: Identifier is derived from auth.userId, NOT args. Even if the
    // LLM tried to smuggle an Identifier into args (which the schema does
    // not expose anyway), it would be ignored here.
    const body = {
      Features: args.features,
      Identifier: auth.userId,
    };

    const res = await fetch(`${platformApiBase}/featureflags/decide-bulk`, {
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
