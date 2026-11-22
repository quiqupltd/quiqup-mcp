import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupFulfilmentClient } from "@/lib/clients/quiqup-fulfilment";
import { environmentField } from "@/lib/clients/quiqup-env";
import { jwtFor } from "@/lib/caller-auth";

// TODO(M4): no cassette, no output schema, no error mapping. M3 thin
// pass-through per Slava's hybrid speed call (2026-05-03).
// Required fields discovered empirically per Agent E probe: sku, name,
// selling_price (minor units, e.g. fils), currency. May surface
// "Business account inactive" on merchants without active product ops.
const inputSchema = z.object({
  sku: z.string().min(1, "sku is required"),
  name: z.string().min(1, "name is required"),
  selling_price: z
    .number()
    .nonnegative("selling_price must be a non-negative number (in minor units, e.g. fils)"),
  currency: z.string().min(1, "currency is required (e.g. AED)"),
  environment: environmentField,
}).passthrough();

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "create_product",
  description:
    "Create a new Quiqup Fulfilment product on platform-api.quiqup.com. Requires sku, name, selling_price (minor units), currency. Additional fields (weight, dimensions, hs_code) accepted via passthrough.",
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) throw new Error("create_product requires an authenticated user");
    const jwt = await jwtFor(auth, args.environment);
    const client = new QuiqupFulfilmentClient({ jwt, environment: args.environment });
    const { environment: _env, ...upstreamBody } = args;
    void _env;
    const data = await client.request("POST", "/api/fulfilment/products", { body: upstreamBody });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
};
