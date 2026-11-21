import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupFulfilmentClient } from "@/lib/clients/quiqup-fulfilment";
import { environmentField } from "@/lib/clients/quiqup-env";
import { jwtFor } from "@/lib/caller-auth";

// TODO(M4): no cassette, no output schema, no error mapping.
const inputSchema = z.object({
  sku: z.string().min(1, "sku is required"),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "list_sku_batches",
  description:
    "List all batches for a Quiqup Fulfilment product SKU. Each batch represents a tracked lot (expiry date, received date, supplier reference) of the same SKU.",
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) throw new Error("list_sku_batches requires an authenticated user");
    const jwt = await jwtFor(auth, args.environment);
    const client = new QuiqupFulfilmentClient({ jwt, environment: args.environment });
    const data = await client.request(
      "GET",
      `/api/fulfilment/inventory/${encodeURIComponent(args.sku)}/batches`,
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
};
