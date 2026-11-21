import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupFulfilmentClient } from "@/lib/clients/quiqup-fulfilment";
import { environmentField } from "@/lib/clients/quiqup-env";
import { jwtFor } from "@/lib/caller-auth";

// TODO(M4): no cassette, no output schema, no error mapping. M3 thin
// pass-through per Slava's hybrid speed call (2026-05-03).
// Note: prod calls may surface "Business account inactive" on merchants
// without active product/inventory ops — see Agent E report 2026-05-03.
const inputSchema = z.object({
  sku: z.string().min(1, "sku is required"),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "get_product_by_sku",
  description:
    "Fetch a single Quiqup Fulfilment product by SKU from platform-api.quiqup.com. Requires an active fulfilment merchant.",
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) throw new Error("get_product_by_sku requires an authenticated user");
    const jwt = await jwtFor(auth, args.environment);
    const client = new QuiqupFulfilmentClient({ jwt, environment: args.environment });
    const data = await client.request(
      "GET",
      `/api/fulfilment/products/${encodeURIComponent(args.sku)}`,
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
};
