import { z } from "zod";
import type { ToolSpec } from "./register";
import { QuiqupFulfilmentClient } from "@/lib/clients/quiqup-fulfilment";
import { environmentField } from "@/lib/clients/quiqup-env";
import { jwtFor } from "@/lib/caller-auth";

// TODO(M4): no cassette, no output schema, no error mapping.
const inputSchema = z.object({
  inbound_id: z.string().min(1, "inbound_id is required"),
  environment: environmentField,
});

const outputSchema = z.object({}).passthrough();

export const spec: ToolSpec<typeof inputSchema, typeof outputSchema> = {
  name: "get_inbound_state_history",
  description:
    "Fetch the state-transition history for a single Quiqup Fulfilment inbound delivery. Each entry is a state change with timestamp, useful for tracing where a delivery is stuck.",
  inputSchema,
  outputSchema,
  handler: async (auth, args) => {
    if (!auth.userId) throw new Error("get_inbound_state_history requires an authenticated user");
    const jwt = await jwtFor(auth, args.environment);
    const client = new QuiqupFulfilmentClient({ jwt, environment: args.environment });
    const data = await client.request(
      "GET",
      `/api/fulfilment/inbound/${encodeURIComponent(args.inbound_id)}/state-history`,
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  },
};
