import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupFulfilmentClient } from "@/lib/clients/quiqup-fulfilment";
import { environmentField } from "@/lib/clients/quiqup-env";
import { jwtFor } from "@/lib/caller-auth";

// TODO(M4): no cassette, no output schema, no error mapping.
// Note: path uses plural `/inbounds/` for items vs singular `/inbound/` for
// the other inbound endpoints — Quiqup API inconsistency, preserved as-is.
const inputSchema = z.object({
  inbound_id: z.string().min(1, "inbound_id is required"),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "get_inbound_items",
  description:
    "Fetch the GRN (goods receipt note) line items for a Quiqup Fulfilment inbound delivery. Each line covers one SKU with expected vs received quantities.",
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) throw new Error("get_inbound_items requires an authenticated user");
    const jwt = await jwtFor(auth, args.environment);
    const client = new QuiqupFulfilmentClient({ jwt, environment: args.environment });
    const data = await client.request(
      "GET",
      `/api/fulfilment/inbounds/${encodeURIComponent(args.inbound_id)}/items`,
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
};
