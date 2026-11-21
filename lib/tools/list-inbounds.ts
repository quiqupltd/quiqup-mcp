import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupFulfilmentClient } from "@/lib/clients/quiqup-fulfilment";
import { environmentField } from "@/lib/clients/quiqup-env";
import { jwtFor } from "@/lib/caller-auth";

// TODO(M4): no cassette, no output schema, no error mapping.
const inputSchema = z.object({
  page: z.number().int().positive().optional(),
  per_page: z.number().int().positive().max(200).optional(),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "list_inbounds",
  description:
    "List all inbound deliveries (paginated). Each entry covers one scheduled inbound shipment to a Quiqup warehouse with its current state.",
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) throw new Error("list_inbounds requires an authenticated user");
    const jwt = await jwtFor(auth, args.environment);
    const client = new QuiqupFulfilmentClient({ jwt, environment: args.environment });
    const data = await client.request("GET", "/api/fulfilment/inbounds", {
      query: { page: args.page, per_page: args.per_page },
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
};
