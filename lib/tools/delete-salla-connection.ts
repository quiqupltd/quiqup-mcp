/**
 * `delete_salla_connection` — DESTRUCTIVE: delete a Salla integration
 * connection by id on platform-api.quiqup.com (Phase 2 / INTG-22).
 *
 * Endpoint: DELETE https://platform-api.quiqup.com/integrations/connections/{id}
 * Headers:  Authorization: Bearer <session-JWT> (Clerk → Quiqup actor-token bridge),
 *           Accept: application/json
 *           (NO body)
 *
 * Response shape: empty (per source-doc lines 4358-4360). This MCP layer
 * synthesizes a structured echo `{ ok: true, deleted: { id }, upstream_status }`
 * so the agent sees a positive confirmation rather than an empty body.
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
 * Companion-tool path:
 *   - `list_integration_connections` (filter source==='salla') discovers the id.
 *   - `get_salla_connection` (02-04) returns the FULL post-state for the
 *     connection (shop_name + site_url + is_fulfillment) — USE IT TO PREVIEW
 *     what you are about to delete BEFORE you set `confirm: true`.
 *
 * Error modes:
 *   - 401 / 403 → auth issue (run `whoami_platform`).
 *   - 404       → connection already deleted upstream, or never existed —
 *                 verify via `list_integration_connections`.
 *   - 5xx       → upstream temporarily unavailable; retry.
 */

import { z } from "zod";
import type { ToolSpec } from "./register";
import { jwtFor } from "@/lib/caller-auth";
import { QuiqupHttpError } from "@/lib/clients/quiqup-lastmile";
import { environmentField, getPlatformApiBaseUrl } from "@/lib/clients/quiqup-env";
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
  id: z
    .string()
    .min(1)
    .describe(
      "Salla connection id — get it from " +
        "`list_integration_connections[].id` where source==='salla', and " +
        "PREVIEW the shop_name + site_url via `get_salla_connection` BEFORE " +
        "you set `confirm: true`. URL-encoded by the handler before the " +
        "upstream call.",
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
  name: "delete_salla_connection",
  description:
    "DESTRUCTIVE: delete a Salla integration connection by id via DELETE " +
    "/integrations/connections/{id} on platform-api.quiqup.com. This is " +
    "irreversible — the connection is removed upstream. " +
    "GATE: `confirm: true` MUST be set; otherwise the tool returns a " +
    "structured isError result naming the connection id that WOULD have " +
    "been deleted, and NO upstream call is made. " +
    "Preview path: pair `confirm: true` with `dry_run: true` to run every " +
    "pre-flight check (auth, confirm) without issuing the upstream DELETE. " +
    "Companion reads: use `list_integration_connections` (filter " +
    "source==='salla') to discover the id, then call " +
    "`get_salla_connection` to preview the shop_name + site_url + " +
    "is_fulfillment for the connection BEFORE you commit. " +
    "Idempotency: supply `idempotency_key` to make retries safe within 15 " +
    "minutes — a replay returns the cached result rather than re-issuing " +
    "the DELETE (which would 404 on the second hit since the connection " +
    "is already gone). " +
    "Rate limit: TIGHT 3/min cap on this tool — destructive sweeps are " +
    "intentionally throttled. " +
    "Error modes: 401/403 → auth issue (run `whoami_platform`); 404 → " +
    "connection already deleted upstream or never existed (verify via " +
    "`list_integration_connections`); 5xx → upstream temporarily " +
    "unavailable, retry. " +
    'Example: `{ "id": "conn_abc123", "confirm": true, "environment": "production" }`.',
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
        "delete_salla_connection requires an authenticated user",
      );
    }

    // 2. Destructive confirm gate (canonical Phase 2+ pattern).
    try {
      // 02-REVIEW WR-09: sanitize args before interpolating into LLM-visible
      // error text — strips newlines/control chars and caps length so a
      // log-injection or copy-the-whole-row id doesn't echo back verbatim.
      requireConfirm(
        "delete_salla_connection",
        args,
        `Salla connection id ${JSON.stringify(sanitizeForResourceText(args.id))}`,
      );
    } catch (err) {
      if (err instanceof ConfirmationRequiredError) {
        return buildConfirmationRequiredResult(err);
      }
      throw err;
    }

    // 3. Source-scope pre-flight (02-REVIEW BL-03): this tool deletes Salla
    //    connections only. The upstream endpoint
    //    `DELETE /integrations/connections/{id}` is FAMILY-AGNOSTIC — it will
    //    happily delete a Shopify or WooCommerce connection if the LLM (or
    //    an upstream copy-paste error) supplied the wrong id. The tool name,
    //    description, and confirmation echo all imply Salla scope; this
    //    pre-flight enforces it.
    //
    //    The pre-flight runs BEFORE the dry-run short-circuit so a dry-run
    //    preview also fails when the id resolves to a non-Salla connection.
    //    Cost: one extra GET; the tool is rate-limited to 3/min anyway. Also
    //    serves as a JWT-bridge exercise (compare 02-REVIEW WR-04: the
    //    previous dry-run path skipped the bridge entirely).
    const jwt = await jwtFor(auth, args.environment);
    const platformApiBase = getPlatformApiBaseUrl(args.environment);

    const preRes = await fetch(
      `${platformApiBase}/integrations/connections/${encodeURIComponent(args.id)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/json",
        },
      },
    );
    if (!preRes.ok) {
      // Forward 404 / 401 / etc. unchanged so the LLM sees the canonical
      // upstream error path.
      throw new QuiqupHttpError(preRes.status, await preRes.text());
    }
    const peek = (await preRes.json()) as {
      connection?: { source?: string };
    };
    const peekSource = peek.connection?.source;
    if (peekSource !== "salla") {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text:
              `delete_salla_connection refused: connection ${args.id} has source=${String(peekSource)}, ` +
              `not 'salla'. NO upstream DELETE was issued. ` +
              `Use delete_integration_source({ source: "${String(peekSource)}", shop_name: <...> }) instead, ` +
              `or verify the id via list_integration_connections.`,
          },
        ],
      };
    }

    // 4. Dry-run short-circuit — runs AFTER confirm + source-check.
    if (isDryRun(args)) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                dry_run: true,
                would_delete: { id: args.id, source: "salla" },
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
    //    minted above for the source-check pre-flight).
    const res = await fetch(
      `${platformApiBase}/integrations/connections/${encodeURIComponent(args.id)}`,
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

    // 6. Synthesize a structured echo — upstream returns empty per source-doc.
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              ok: true,
              deleted: { id: args.id },
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
