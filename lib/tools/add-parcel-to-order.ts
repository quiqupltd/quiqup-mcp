import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupLastmileClient } from "@/lib/clients/quiqup-lastmile";
import { environmentField } from "@/lib/clients/quiqup-env";
import { jwtFor } from "@/lib/caller-auth";

// TODO(M4): no cassette, no output schema, no error mapping.
// Per references/lastmile.md: adds a new parcel/item to a pending order.
// Adds billable surface — flag for M6 audit log when guardrails ship.
const inputSchema = z.object({
  order_id: z.string().min(1, "order_id is required"),
  parcel: z.object({}).passthrough(),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "add_parcel_to_order",
  description:
    "Add a parcel (item) to a pending Quiqup Last-Mile order. The order must be in `pending` state. Pass the parcel body under `parcel` — see Quiqup last-mile API docs for the parcel schema (dimensions, weight, item description, barcode).",
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) throw new Error("add_parcel_to_order requires an authenticated user");
    const jwt = await jwtFor(auth, args.environment);
    const client = new QuiqupLastmileClient({ jwt, environment: args.environment });
    const data = await client.request(
      "POST",
      `/orders/${encodeURIComponent(args.order_id)}/parcels`,
      { body: args.parcel },
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
};
