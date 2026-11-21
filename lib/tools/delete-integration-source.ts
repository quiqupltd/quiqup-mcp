/**
 * `delete_integration_source` — DESTRUCTIVE: delete an integration connection
 * by source + shop_name on platform-api.quiqup.com (Phase 2 / INTG-02).
 *
 * Endpoint: DELETE https://platform-api.quiqup.com/{source}/delete/{shopName}
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json
 *           (NO body — DELETE carries path params only)
 *
 * Response shape: NOT in upstream openapi.json (source-doc lines 174-182).
 * This MCP layer synthesizes a structured echo
 * `{ ok: true, deleted: { source, shop_name }, upstream_status }` so the
 * agent sees a positive confirmation rather than an empty body.
 *
 * Destructive contract (canonical Phase 2+ pattern, see
 * lib/middleware/destructive.ts):
 *   - `confirm: true` MUST be set. Otherwise `requireConfirm` throws
 *     `ConfirmationRequiredError` and the handler returns a structured
 *     isError result naming the resource. NO upstream call is made.
 *   - `dry_run: true` short-circuits AFTER auth + confirm but BEFORE the
 *     upstream DELETE. Pair with `confirm: true` to exercise the gate.
 *   - Tight 3/min rate limit (deletes should be rare).
 *   - audit: true on every call — including rejected (no-confirm) attempts.
 *
 * Companion-tool path: source `shop_name` from
 * `list_integration_connections[].shop_name` for the connection you intend
 * to delete. The `source` enum mirrors `list_integration_connections[].source`.
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform`).
 *   - 404       → connection already deleted upstream, or never existed —
 *                 verify via `list_integration_connections`.
 *   - 422       → canonical replay semantic (e.g. shop already deleted).
 *   - 5xx       → upstream temporarily unavailable; retry.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl, integrationSourceField } from "@/lib/clients/quiqup-env";
import {
  ConfirmationRequiredError,
  buildConfirmationRequiredResult,
  destructiveConfirmField,
  destructiveDryRunField,
  isDryRun,
  requireConfirm,
  sanitizeForResourceText,
} from "@/lib/middleware/destructive";

const inputSchema = z.object({
  // 02-REVIEW WR-05: use the shared `integrationSourceField` so the read side
  // (list_integration_connections[].source doc) and this delete side cannot
  // silently drift when a fourth family lands upstream.
  source: integrationSourceField.describe(
    "Integration source — MUST match the connection's `source` field as " +
      "returned by `list_integration_connections`. Enum-bound to prevent " +
      "path injection (any other value is rejected at schema-parse).",
  ),
  shop_name: z
    .string()
    .min(1)
    .describe(
      "Shop short-name — the value returned by " +
        "`list_integration_connections[].shop_name` for the connection you " +
        "intend to delete. URL-encoded by the handler before the upstream call.",
    ),
  confirm: destructiveConfirmField,
  dry_run: destructiveDryRunField,
  idempotency_key: z
    .string()
    .optional()
    .describe(
      "Optional caller-supplied key to dedupe retries within a 15-minute " +
        "window. Recommended for destructive ops to make at-least-once " +
        "agent retries safe.",
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "delete_integration_source",
  description:
    "DESTRUCTIVE: delete an integration connection by source + shop_name " +
    "via DELETE /{source}/delete/{shopName} on platform-api.quiqup.com. " +
    "This is irreversible — the connection is removed upstream. " +
    "GATE: `confirm: true` MUST be set; otherwise the tool returns a " +
    "structured isError result naming the resource that WOULD have been " +
    "deleted, and NO upstream call is made. " +
    "Preview path: pair `confirm: true` with `dry_run: true` to run every " +
    "pre-flight check (auth, confirm) without issuing the upstream DELETE " +
    "— useful for verifying you have the correct source/shop_name before " +
    "committing. " +
    "Companion read: source the `shop_name` argument from " +
    "`list_integration_connections[].shop_name` (and verify the matching " +
    "source field) BEFORE you set `confirm: true`. " +
    "Idempotency: supply `idempotency_key` to make retries safe within 15 " +
    "minutes — a replay returns the cached result rather than re-issuing " +
    "the DELETE (which would 422/404 on the second hit since the shop is " +
    "already gone). " +
    "Rate limit: TIGHT 3/min cap on this tool — destructive sweeps are " +
    "intentionally throttled. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 404 → " +
    "connection already deleted upstream or never existed (verify via " +
    "`list_integration_connections`); 422 → canonical replay semantic if " +
    "the shop is already deleted; 5xx → upstream temporarily unavailable, " +
    "retry. " +
    'Example: `{ "source": "shopify", "shop_name": "acme", "confirm": true, "environment": "production" }`.',
  inputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 3, refillPerSec: 3 / 60 }, // tight: 3 deletes/min
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    // 1. Auth gate — outermost. Layered BEFORE requireConfirm so a missing
    //    auth call never reaches the destructive gate (T-02-37).
    if (!auth.userId) {
      throw new Error(
        "delete_integration_source requires an authenticated user",
      );
    }

    // 2. Destructive confirm gate (canonical Phase 2+ pattern). Throws
    //    ConfirmationRequiredError if args.confirm !== true. Caught locally
    //    and converted to a structured isError result so registerTool's
    //    error-mapping does not need to know about destructive semantics.
    try {
      // 02-REVIEW WR-09: sanitize args.shop_name before interpolating into
      // LLM-visible error text. `args.source` is already enum-bound so it's
      // safe verbatim.
      requireConfirm(
        "delete_integration_source",
        args,
        `${args.source} connection for shop ${JSON.stringify(sanitizeForResourceText(args.shop_name))}`,
      );
    } catch (err) {
      if (err instanceof ConfirmationRequiredError) {
        return buildConfirmationRequiredResult(err);
      }
      throw err;
    }

    // 3. JWT bridge — minted ABOVE the dry-run short-circuit (02-REVIEW WR-04)
    //    so a dry-run preview also exercises the Clerk → Quiqup actor-token
    //    bridge. Without this, an agent could dry-run a delete from a userId
    //    whose `getQuiqupReadyJwt` would actually fail (revoked Clerk session,
    //    mid-token-rotation) and get a green "would_delete" response.
    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);

    // 4. Dry-run short-circuit — runs AFTER confirm + JWT mint (dry_run cannot
    //    bypass confirm; see T-02-39).
    if (isDryRun(args)) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                dry_run: true,
                would_delete: {
                  source: args.source,
                  shop_name: args.shop_name,
                },
                note:
                  "No upstream DELETE was issued because dry_run=true. " +
                  "Re-call with dry_run:false (or omit dry_run) to perform " +
                  "the deletion.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // 5. Live destructive path — fire DELETE (jwt + platformApiBase already
    //    minted above so dry-run exercises the bridge too).
    const res = await fetch(
      `${platformApiBase}/${encodeURIComponent(args.source)}/delete/${encodeURIComponent(args.shop_name)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/json",
        },
      },
    );

    if (!res.ok) {
      throw new QuiqupHttpError(res.status, await res.text());
    }

    // 5. Synthesize a structured echo — upstream response is not in the
    //    OpenAPI schema, so we provide a deterministic positive
    //    confirmation rather than passing through an unknown body.
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              ok: true,
              deleted: { source: args.source, shop_name: args.shop_name },
              upstream_status: res.status,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};
