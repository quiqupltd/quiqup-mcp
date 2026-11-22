import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupLastmileClient } from "@/lib/clients/quiqup-lastmile";
import { environmentField } from "@/lib/clients/quiqup-env";
import { jwtFor } from "@/lib/caller-auth";

// TODO(M4): no cassette, no output schema, no error mapping.
// Per references/lastmile.md: only `payment_mode` and `payment_amount` are
// mutable, and only on `pending` orders. Schema enforces the field whitelist
// at the input boundary; the API enforces the state precondition.
const inputSchema = z.object({
  order_id: z.string().min(1, "order_id is required"),
  patch: z
    .object({
      payment_mode: z.string().optional(),
      payment_amount: z.number().optional(),
    })
    .refine(
      (obj) => Object.keys(obj).length > 0,
      { message: "patch must contain payment_mode and/or payment_amount" },
    ),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "update_lastmile_order",
  description:
    "Update a pending Quiqup Last-Mile order. ONLY `payment_mode` and `payment_amount` are mutable, and ONLY while the order is in `pending` state. The API rejects updates on non-pending orders.",
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) throw new Error("update_lastmile_order requires an authenticated user");
    const jwt = await jwtFor(auth, args.environment);
    const client = new QuiqupLastmileClient({ jwt, environment: args.environment });
    const data = await client.request(
      "PUT",
      `/orders/${encodeURIComponent(args.order_id)}`,
      { body: args.patch },
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
};
