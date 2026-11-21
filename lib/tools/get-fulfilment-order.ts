import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupFulfilmentClient } from "@/lib/clients/quiqup-fulfilment";
import { environmentField } from "@/lib/clients/quiqup-env";
import { jwtFor } from "@/lib/caller-auth";

// TODO(M4): no cassette, no output schema, no error mapping.
// Cross-border note: partner_export / non-AE-destination orders may 404 here
// per references/endpoints.md. Use the lastmile export route in those cases.
const inputSchema = z.object({
  order_id: z.string().min(1, "order_id is required"),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "get_fulfilment_order",
  description:
    "Fetch a single Quiqup Fulfilment order by ID from platform-api.quiqup.com. For cross-border orders (service_kind partner_export or non-AE destinations), this may 404 — those route via the last-mile export endpoint.",
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) throw new Error("get_fulfilment_order requires an authenticated user");
    const jwt = await jwtFor(auth, args.environment);
    const client = new QuiqupFulfilmentClient({ jwt, environment: args.environment });
    const data = await client.request(
      "GET",
      `/api/fulfilment/orders/${encodeURIComponent(args.order_id)}`,
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
};
