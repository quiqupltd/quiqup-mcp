import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupFulfilmentClient } from "@/lib/clients/quiqup-fulfilment";
import { environmentField } from "@/lib/clients/quiqup-env";
import { jwtFor } from "@/lib/caller-auth";

// TODO(M4): no cassette, no output schema, no error mapping.
//
// Cancellation guardrail: per the quiqup-api skill SKILL.md, any PATCH that
// sets `status` to a terminal value (cancelled, voided, refunded, closed,
// aborted) is a guardrailed cancellation case. Reject those status values at
// the input schema — surface a clear error pointing the LLM at the dedicated
// disabled cancel tools (which won't ship until M6 lands scope/audit/idempotency).
const TERMINAL_STATUSES = ["cancelled", "voided", "refunded", "closed", "aborted"] as const;

const inputSchema = z.object({
  order_id: z.string().min(1, "order_id is required"),
  patch: z
    .object({
      status: z
        .string()
        .refine(
          (s) => !TERMINAL_STATUSES.includes(s as (typeof TERMINAL_STATUSES)[number]),
          {
            message:
              "status cannot be set to a terminal value (cancelled/voided/refunded/closed/aborted) via update_fulfilment_order. Cancellation tools are disabled pending M6 guardrails.",
          },
        )
        .optional(),
    })
    .passthrough()
    .refine(
      (obj) => Object.keys(obj).length > 0,
      { message: "patch must contain at least one field to update" },
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "update_fulfilment_order",
  description:
    "Update an existing Quiqup Fulfilment order (PATCH) on platform-api.quiqup.com. Pass changed fields under `patch`. The schema rejects terminal status values (cancelled/voided/refunded/closed/aborted) — those route through dedicated cancel tools (currently disabled pending M6 guardrails).",
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) throw new Error("update_fulfilment_order requires an authenticated user");
    const jwt = await jwtFor(auth, args.environment);
    const client = new QuiqupFulfilmentClient({ jwt, environment: args.environment });
    const data = await client.request(
      "PATCH",
      `/api/fulfilment/orders/${encodeURIComponent(args.order_id)}`,
      { body: args.patch },
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
};
