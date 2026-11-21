import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupFulfilmentClient } from "@/lib/clients/quiqup-fulfilment";
import { environmentField } from "@/lib/clients/quiqup-env";
import { jwtFor } from "@/lib/caller-auth";

// TODO(M4): no cassette, no output schema, no error mapping. M3 thin
// pass-through per Slava's hybrid speed call (2026-05-03).
const inputSchema = z.object({
  sku: z.string().min(1, "sku is required"),
  patch: z
    .object({
      name: z.string().min(1).optional(),
      selling_price: z.number().nonnegative().optional(),
      currency: z.string().min(1).optional(),
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
  name: "update_product",
  description:
    "Update an existing Quiqup Fulfilment product (PATCH) by SKU on platform-api.quiqup.com. Pass changed fields under `patch`. Common: name, selling_price, currency. Other fields passthrough.",
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) throw new Error("update_product requires an authenticated user");
    const jwt = await jwtFor(auth, args.environment);
    const client = new QuiqupFulfilmentClient({ jwt, environment: args.environment });
    const data = await client.request(
      "PATCH",
      `/api/fulfilment/products/${encodeURIComponent(args.sku)}`,
      { body: args.patch },
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
};
