/**
 * `create_account_team_member` — provision a Clerk team member on the
 * partner's account (Phase 1 / AUTH-13).
 *
 * Endpoint: POST https://platform-api.quiqup.com/account/team
 * Headers:  Authorization: Bearer <session-JWT>,
 *           Accept: application/json, Content-Type: application/json
 *
 * Per source-doc lines 149-152 this is the Clerk-team binding endpoint: it
 * provisions a Clerk team / org binding for the account post-signup.
 * Adding a team member grants them access to the partner's full data —
 * agents should confirm intent with the user before calling.
 *
 * The destructive-policy gate in PROJECT.md (`confirm: true` for destructive
 * endpoints) is intentionally NOT applied here per the plan's T-01-20
 * disposition: creating a single team member is reversible (the member can
 * be removed upstream) and the destructive-gating policy is scoped to batch
 * operations + DELETEs. See PLAN.md threat-model row T-01-20.
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform`).
 *   - 409       → member already exists on the account.
 *   - 422       → validation failure (inspect body).
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";

const inputSchema = z.object({
  email: z.string().email().describe("Email address of the new team member."),
  first_name: z.string().min(1).optional(),
  last_name: z.string().min(1).optional(),
  role: z
    .string()
    .min(1)
    .describe(
      'Role for the new member, e.g. "admin", "operator", "viewer". The ' +
        "upstream enforces the allowed enum.",
    ),
  idempotency_key: z
    .string()
    .optional()
    .describe(
      "Optional caller-supplied key to dedupe retries within a 15-minute " +
        "window. Strongly recommended — a retry-after-network-blip without " +
        "this key may provision a duplicate invite or return 409.",
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "create_account_team_member",
  description:
    "Provision a new team member on the partner's account via " +
    "POST /account/team on platform-api.quiqup.com. This is the Clerk-team " +
    "binding endpoint — it grants the new member access to the partner's " +
    "FULL data (orders, inventory, settings, finance). " +
    "WARNING: adding a team member is a privilege-escalation action; confirm " +
    "intent with the user (which email, which role) before calling. The " +
    "operation is reversible (the member can be removed upstream) but the " +
    "data exposed during their session is not. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 409 → member " +
    "already exists on the account; 422 → validation failure (inspect body). " +
    'Example: `{ "email": "ops@partner.example", "role": "operator" }`.',
  inputSchema,
  outputSchema,
  // Privilege-escalation action — tight burst limit (5 / minute), idempotency
  // key on retries so a network blip does not provision a duplicate invite,
  // and audit on every call so the action is traceable.
  guardrails: {
    rateLimit: { capacity: 5, refillPerSec: 5 / 60 },
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("create_account_team_member requires an authenticated user");
    }

    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);

    const body: Record<string, unknown> = {
      email: args.email,
      role: args.role,
    };
    if (args.first_name !== undefined) body.first_name = args.first_name;
    if (args.last_name !== undefined) body.last_name = args.last_name;

    const res = await fetch(`${platformApiBase}/account/team`, {
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
