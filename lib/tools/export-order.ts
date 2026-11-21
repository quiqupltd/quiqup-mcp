/**
 * `export_order` (ORDS-03) — request a re-export of a single Quiqup order
 * to downstream integrations via the Quiqup REST public API.
 *
 * Endpoint: PUT /orders/export/{id} on api.quiqup.com (production) /
 *           api.staging.quiqup.com (staging).
 *
 * Despite being an HTTP PUT, this is a READ-SHAPED operation per the
 * upstream's quirky API: the call requests a re-export of the order's
 * data to whichever integrations the merchant has wired up. It does not
 * mutate the order itself; it triggers an outbound side-effect that is
 * idempotent at the integration layer (re-exporting the same order
 * twice is a no-op for the receiving integration). For that reason
 * this tool is NOT destructive-gated — there is no `confirm: true`
 * field. Per-order scope-checked under the caller's session BEFORE the
 * PUT runs (a hostile or buggy caller cannot trigger an export for
 * another tenant's order).
 *
 * Phase-4 / Wave-3 single-order mutation. Direct handler (no factory).
 *
 * Auth: V3b Clerk → Quiqup session-JWT bridge — IDENTICAL to every
 * other Quiqup-side write tool. `jwtFor(auth, args.environment)` mints
 * the Bearer token; the handler refuses to run when `auth.userId` is
 * null (T-04-17 — auth gate runs BEFORE any work).
 *
 * Guardrails: non-destructive baseline — 10/min rate-limit (re-exports
 * should be infrequent but not as throttled as the canonical 3/min
 * destructive cap), idempotency-key for safe retry, audit-on for the
 * outbound-export trail.
 *
 * Error modes:
 *   - 401/403 → auth issue, run `whoami_platform`.
 *   - 404     → order not visible under caller's session (scope assertion
 *               also rejects this case before the PUT).
 *   - 5xx     → upstream temporarily unavailable, retry.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupRestClient } from "@/lib/clients/quiqup-rest";
import { environmentField } from "@/lib/clients/quiqup-env";
import { jwtFor } from "@/lib/caller-auth";
import { assertOrderOwned } from "@/lib/caller-auth";

const inputSchema = z.object({
  order_id: z
    .string()
    .min(1)
    .describe(
      "Quiqup order id (clientOrderID, rendered as string by the upstream). " +
        "Find via `lookup_orders_ids` or `recent_orders`. Path-encoded by " +
        "the handler before the upstream PUT.",
    ),
  idempotency_key: z
    .string()
    .optional()
    .describe(
      "Optional caller-supplied key to dedupe retries within a 15-minute " +
        "window. Recommended so at-least-once agent retries don't pile up " +
        "duplicate re-export requests on the integration side.",
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "export_order",
  description:
    "Trigger Quiqup's order-export side-effect for a single order. " +
    "Endpoint: PUT /orders/export/{id} (Quiqup REST host — api.quiqup.com). " +
    "Despite being an HTTP PUT, this is a read-shaped operation — it " +
    "requests a re-export of the order's data to whichever integrations " +
    "the merchant has wired up; it does NOT mutate the order itself. For " +
    "that reason this tool is NOT destructive-gated (no `confirm: true` " +
    "field). Per-order scope-checked under the caller's session BEFORE " +
    "firing — a hostile or buggy caller cannot trigger an export for " +
    "another tenant's order. " +
    "Idempotency: supply `idempotency_key` to make at-least-once retries " +
    "safe within a 15-minute window. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 404 → " +
    "order not visible under your session (scope assertion catches this " +
    "before the PUT); 5xx → upstream temporarily unavailable, retry. " +
    'Example: `{ "order_id": "12345", "environment": "production" }`.',
  inputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 10, refillPerSec: 10 / 60 }, // 10/min — non-destructive
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    // 1. Auth gate (T-04-17 — outermost, before any work).
    if (!auth.userId) {
      throw new Error("export_order requires an authenticated user");
    }

    // 2. Per-order scope assertion (T-04-16) — refuse cross-tenant exports
    //    BEFORE the PUT lands. assertOrderBelongsToUser throws
    //    ScopeViolationError on 404; let it propagate so the registerTool
    //    wrapper renders the canonical scope-violation result.
    await assertOrderOwned(auth, args.order_id, args.environment);

    // 3. Mint JWT, build the Quiqup REST client, fire the PUT.
    const jwt = await jwtFor(auth, args.environment);
    const client = new QuiqupRestClient({ jwt, environment: args.environment });

    // encodeURIComponent for path-param hygiene (T-04-18 — prevents
    // injection of `/` or `?` characters into the URL path).
    const data = await client.request(
      "PUT",
      `/orders/export/${encodeURIComponent(args.order_id)}`,
    );

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Re-export requested for order ${args.order_id}.\n\n` +
            `Upstream response:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  },
};
