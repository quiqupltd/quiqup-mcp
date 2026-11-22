/**
 * `create_mission` — Phase 4 / MISS-01.
 *
 * Endpoint: POST https://platform-api.quiqup.com/quiqdash/missions
 * Headers:  Authorization: Bearer <session-JWT>, Accept: application/json,
 *           Content-Type: application/json
 *
 * Body shape (per source-doc §8 line 2760 `POST /quiqdash/missions`):
 *   { depotId: string, orderIds: string[], type: string, zone: string }
 *
 * Phase semantics: a mission is a "delivery sortie" covering 1-N orders
 * assigned to a depot and a delivery zone. After creating a mission with
 * an initial order set, agents use `transfer_mission_orders` (MISS-02) to
 * move additional orders into the mission — that companion tool IS
 * destructive-gated because it MOVES orders between missions, but this
 * CREATE is non-destructive because no resource is overwritten.
 *
 * D-05 — Mission-tool destructive gating asymmetry:
 *   - `create_mission` (MISS-01) → NOT destructive-gated. Pure additive
 *     creation; the worst the LLM can do is create a junk mission that
 *     can be ignored or destroyed. Standard write-tool guardrails apply.
 *   - `transfer_mission_orders` (MISS-02) → DESTRUCTIVE-gated. Moves
 *     orders between missions; affects dispatch state on the SOURCE
 *     mission too. Tight 3/min rate-limit + confirm:true + dry_run.
 *
 * Identity binding (BL-04 server-side):
 *   The input schema has NO `user_id` / `actor_id` / `actor_email` /
 *   `partner_id` field. The partner identity is bound server-side from
 *   `auth.userId` — caller-supplied identity is at best ignored and at
 *   worst a cross-tenant smuggling vector. Locked out by schema shape.
 *
 * Guardrails (BL-01 canonical write-tool pattern):
 *   - rateLimit 10/min — mission creation should be rare; bursts misuse.
 *   - idempotency on `idempotency_key` (15min TTL) — safe retries.
 *   - audit: true — repudiation defence.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { PlatformApiClient } from "@/lib/clients/platform-api";
import { environmentField } from "@/lib/clients/quiqup-env";
import { jwtFor } from "@/lib/caller-auth";

const inputSchema = z.object({
  depotId: z
    .string()
    .min(1)
    .describe(
      "ID of the depot the mission departs from. Call `list_depots` to " +
        "discover valid depot IDs for the current partner.",
    ),
  orderIds: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      "Initial set of order IDs to assign to the mission. Must contain " +
        "at least one order. Use `transfer_mission_orders` to add or " +
        "move further orders after creation.",
    ),
  type: z
    .string()
    .min(1)
    .describe(
      "Mission type (e.g. 'delivery', 'collection'). Free-form per " +
        "source-doc §8 — upstream may add types over time.",
    ),
  zone: z
    .string()
    .min(1)
    .describe(
      "Delivery zone tag for routing (e.g. 'DXB-1'). Free-form per " +
        "source-doc §8.",
    ),
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
  name: "create_mission",
  description:
    "POST /quiqdash/missions (Platform host — platform-api.quiqup.com). " +
    "Create a new mission — a delivery sortie covering 1-N orders, " +
    "assigned to a depot and a delivery zone. After creation, use " +
    "`transfer_mission_orders` (MISS-02) to add or move further orders " +
    "into the mission. Required body: depotId (call `list_depots` to " +
    "discover valid values), orderIds (initial set, min 1), type " +
    "(e.g. 'delivery'), zone (e.g. 'DXB-1'). " +
    "NOT destructive-gated (D-05): mission creation is additive — no " +
    "resource is overwritten. Companion tool `transfer_mission_orders` " +
    "IS destructive-gated because it moves orders between missions. " +
    "Identity binding: this tool does NOT accept caller-supplied user/" +
    "actor/partner fields — identity is bound server-side to auth.userId. " +
    "Idempotency: pass `idempotency_key` to dedupe retries within 15 min. " +
    "Error modes: 401/403 → auth (run `whoami_platform`); 422 → upstream " +
    "validation; 5xx → retry.",
  inputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 10, refillPerSec: 10 / 60 },
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("create_mission requires an authenticated user");
    }

    // Strip wrapper-only fields from the upstream body.
    const { idempotency_key: _idem, environment: _env, ...body } = args;
    void _idem;
    void _env;

    const jwt = await jwtFor(auth, args.environment);
    const client = new PlatformApiClient({
      jwt,
      environment: args.environment,
    });
    const data = await client.request("POST", "/quiqdash/missions", { body });

    return {
      content: [
        { type: "text" as const, text: JSON.stringify(data, null, 2) },
      ],
    };
  },
};
