import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupLastmileClient } from "@/lib/clients/quiqup-lastmile";
import { PlatformApiClient } from "@/lib/clients/platform-api";
import { environmentField } from "@/lib/clients/quiqup-env";
import {
  AGENT_ORDER_ID_RE,
  assertOrderOwned,
  isPlatformCaller,
  jwtFor,
  nonNumericIdsForAgent,
} from "@/lib/caller-auth";
import { ScopeViolationError } from "@/lib/middleware/scope";

// Per references/lastmile.md: cancellation + batch.
// Upstream contract (validated by evals/lastmile-order-roundtrip.ts):
//   PUT /orders/batch/set_cancelled  body: { order_ids: [<id>, …] }
// Max 10 orders per call — enforced in the input schema below.
//
// M6 guardrails:
//   - per-order scope assertion (assertOrderOwned) BEFORE the
//     destructive PUT. Any 404 from the per-id GET → refuse the whole
//     batch, name the denied ids, leave no upstream PUT trace.
//   - idempotency keyed on caller-supplied `idempotency_key` (15-min TTL).
//   - tight rate-limit: 3 batches / minute (batch cancels should be rare).
//   - audit log on every call.
//
// Two upstream shapes (F28 PR C):
//   - WITHOUT `reason`: exactly the original last-mile call above. Clerk
//     users see no change.
//   - WITH `reason`: the merchant app's route, platform-api
//     PUT /quiqdash/orders/batch/set_cancelled body { orderIds, reason }.
//     `reason` must be one of the names from platform-api
//     GET /orders/partner-cancellation-reasons (validated before any PUT).
//     On the agent door (`/agent/mcp`) `reason` is required.
//     Responses: 201 = cancelled; 202 { status: "pending_projection" } =
//     recorded but not yet readable (do NOT retry, read the order back);
//     422 = non-cancellable state or courier assigned (error mapper shows it).

const inputSchema = z.object({
  order_ids: z.array(z.string().min(1)).min(1).max(10),
  reason: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Cancellation reason NAME, exactly as returned by `list_partner_cancellation_reasons` " +
        "(platform-api GET /orders/partner-cancellation-reasons). When set, the merchant-app " +
        "cancel route is used (PUT /quiqdash/orders/batch/set_cancelled). Required on the " +
        "agent door (/agent/mcp); optional on /mcp, where omitting it keeps the original " +
        "last-mile cancel.",
    ),
  idempotency_key: z.string().optional(),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

// Agent door: numeric order ids only and `reason` required, in the schema itself.
const agentInputSchema = inputSchema.extend({
  order_ids: z
    .array(z.string().regex(AGENT_ORDER_ID_RE, "numeric client order id (1 to 12 digits)"))
    .min(1)
    .max(10),
  reason: z
    .string()
    .min(1)
    .describe(
      "Cancellation reason NAME, exactly as returned by `list_partner_cancellation_reasons`. Required.",
    ),
});

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "cancel_lastmile_orders_batch",
  description:
    "Cancel one or more pending Quiqup Last-Mile orders in a single batch (up to 10 orders per call). Each order is scope-checked under the caller's session before the batch PUT runs; if any order is not visible to the caller the whole batch is refused. Supply an optional `idempotency_key` to make retries safe within a 15-minute window. Optional `reason` (a name from `list_partner_cancellation_reasons`) switches to the merchant-app cancel route; it is REQUIRED on /agent/mcp. A 202 `pending_projection` answer means the cancel is recorded but not yet readable: do not retry, read the order back.",
  inputSchema,
  agentInputSchema,
  outputSchema,
  guardrails: {
    rateLimit: { capacity: 3, refillPerSec: 3 / 60 }, // tight: 3 batches/min
    idempotency: { keyArg: "idempotency_key", ttlMs: 15 * 60 * 1000 },
    audit: true,
  },
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error(
        "cancel_lastmile_orders_batch requires an authenticated user",
      );
    }

    const platformCaller = isPlatformCaller(auth);
    if (platformCaller && !args.reason) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              "Batch cancel refused: `reason` is required on /agent/mcp. Call " +
              "`list_partner_cancellation_reasons` and pass one of the returned names.",
          },
        ],
        isError: true,
      };
    }

    const badIds = nonNumericIdsForAgent(auth, args.order_ids);
    if (badIds.length > 0) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Batch cancel refused: order ids must be numeric client order ids ` +
              `(1 to 12 digits); got ${badIds.join(", ")}. No cancel was attempted.`,
          },
        ],
        isError: true,
      };
    }

    // 0. With a reason, validate it against the merchant-visible list BEFORE
    //    anything else runs (cheap GET, zero side effects). Names only: the
    //    internal /quiqdash/orders/cancellation-reasons list is never used.
    if (args.reason) {
      const reasonJwt = await jwtFor(auth, args.environment);
      const reasonClient = new PlatformApiClient({
        jwt: reasonJwt,
        environment: args.environment,
      });
      const allowed = extractReasonNames(
        await reasonClient.request("GET", "/orders/partner-cancellation-reasons"),
      );
      if (!allowed.includes(args.reason)) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Batch cancel refused: reason ${JSON.stringify(args.reason)} is not a ` +
                `partner cancellation reason. Allowed names: ${allowed.join(" | ")}. ` +
                `No cancel was attempted.`,
            },
          ],
          isError: true,
        };
      }
    }

    // 1. Per-id scope assertion. Collect denials rather than throwing on the
    //    first one so the error message can name every offending id at once
    //    (the LLM caller can then drop the bad ids and retry without a
    //    binary-search dance).
    const denied: string[] = [];
    for (const id of args.order_ids) {
      try {
        await assertOrderOwned(auth, id, args.environment, "set_cancelled");
      } catch (err) {
        if (err instanceof ScopeViolationError) {
          denied.push(id);
        } else {
          throw err;
        }
      }
    }
    if (denied.length > 0) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Batch cancel refused: ${denied.length} order id(s) not visible ` +
              `under your session: ${denied.join(", ")}. No upstream cancel was ` +
              `attempted. Drop the inaccessible id(s) and retry.`,
          },
        ],
        isError: true,
      };
    }

    // 2. All ids in scope: fire the cancel.
    const jwt = await jwtFor(auth, args.environment);

    if (args.reason) {
      const platform = new PlatformApiClient({ jwt, environment: args.environment });
      const data = await platform.request("PUT", "/quiqdash/orders/batch/set_cancelled", {
        body: { orderIds: args.order_ids, reason: args.reason },
      });
      const pending =
        data !== null &&
        typeof data === "object" &&
        (data as { status?: unknown }).status === "pending_projection";
      return {
        content: [
          {
            type: "text" as const,
            text: pending
              ? `Cancel recorded for ${args.order_ids.length} order(s) but not yet readable ` +
                `(pending_projection). Do NOT retry; read the order(s) back to confirm.\n\n` +
                `Upstream response:\n${JSON.stringify(data, null, 2)}`
              : `Cancelled ${args.order_ids.length} order(s) (reason: ${args.reason}).\n\n` +
                `Upstream response:\n${JSON.stringify(data, null, 2)}`,
          },
        ],
      };
    }

    const client = new QuiqupLastmileClient({ jwt, environment: args.environment });
    const data = await client.request("PUT", "/orders/batch/set_cancelled", {
      body: { order_ids: args.order_ids },
    });

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Cancelled ${args.order_ids.length} order(s).\n\n` +
            `Upstream response:\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    };
  },
};

/** `{ reasons: [{ id, name, tooltip }] }` (or a bare array) -> the names. */
function extractReasonNames(body: unknown): string[] {
  const rows = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { reasons?: unknown }).reasons)
      ? (body as { reasons: unknown[] }).reasons
      : [];
  return rows
    .map((r) => (r && typeof r === "object" ? (r as { name?: unknown }).name : r))
    .filter((n): n is string => typeof n === "string");
}
