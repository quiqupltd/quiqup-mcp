import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupHttpError, QuiqupLastmileClient } from "@/lib/clients/quiqup-lastmile";
import { environmentField } from "@/lib/clients/quiqup-env";
import { jwtFor } from "@/lib/caller-auth";

// `order_id` is a string at the input boundary because URL path components
// are always strings — even though the Quiqup response shape carries `id`
// as a number (see lib/tools/recent-orders.ts). The handler will ToString
// any LLM-supplied number before constructing the URL. Don't "fix" the
// type to z.union([number, string]) — it muddles the contract.
// Flagged in 2026-05-03 review.
const inputSchema = z.object({
  order_id: z.string().min(1, "order_id is required"),
  environment: environmentField,
});

// Subset of fields we surface back to the LLM. Quiqup's response is large;
// we model the load-bearing fields strictly and passthrough the rest so a
// new field doesn't break the schema but a missing required field does.
const outputSchema = z
  .object({
    id: z.number(),
    state: z.string(),
    partner_order_id: z.string().nullable().optional(),
    brand_name: z.string().nullable().optional(),
    created_at: z.string().optional(),
    state_updated_at: z.string().optional(),
  })
  .passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "get_lastmile_order",
  description:
    "Fetch a single Quiqup Last-Mile order by ID from api-ae.quiqup.com.",
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) {
      throw new Error("get_lastmile_order requires an authenticated user");
    }

    // V3b same-IdP exchange: mint a Quiqup-shaped JWT from the Clerk userId
    // (mocked in tests via vi.mock("@/lib/quiqup")).
    const jwt = await jwtFor(auth, args.environment);
    const client = new QuiqupLastmileClient({ jwt, environment: args.environment });

    let response: { order: unknown };
    try {
      response = (await client.getOrder(args.order_id)) as { order: unknown };
    } catch (err) {
      if (err instanceof QuiqupHttpError) {
        if (err.status === 404) {
          throw new Error(`Order not found: ${args.order_id} (Quiqup returned 404)`);
        }
        if (err.status === 401 || err.status === 403) {
          throw new Error(
            `Quiqup authentication failed (${err.status}). The token may be expired or scope-insufficient for this order.`,
          );
        }
        if (err.status >= 500) {
          throw new Error(
            `Quiqup upstream temporarily unavailable (${err.status}). Retry in a few seconds.`,
          );
        }
        throw new Error(`Quiqup returned an unexpected status (${err.status}): ${err.body.slice(0, 200)}`);
      }
      throw err;
    }

    // Quiqup returns `{order: {...}}`; unwrap for the MCP content payload.
    const order = response.order;
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(order, null, 2) },
      ],
    };
  },
};
