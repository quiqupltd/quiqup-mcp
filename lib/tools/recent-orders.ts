import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { environmentField } from "@/lib/clients/quiqup-env";
import { quiqupLastmileGet } from "@/lib/quiqup";
import { ORDER_STATES } from "@/lib/order-states";

// `pending` stays the default ("what's open right now"). The state list
// lives in lib/order-states.ts (sc-34635).

// Only the fields we actually surface back. Quiqup's `/orders` response is
// large (full origin/destination address blocks, items, products, tracking
// URLs); typing only the projection we need keeps this file readable.
interface OrdersResponse {
  current_page: number;
  per_page: number;
  total: number;
  total_pages: number;
  results: Array<{
    id: number;
    uuid: string;
    state: string;
    partner_order_id: string | null;
    brand_name: string | null;
    created_at: string;
    state_updated_at: string;
    destination?: { contact_name?: string; emirate?: string };
    item_quantity_count?: number;
  }>;
}

function isoDaysAgo(days: number): string {
  // Quiqup's `from`/`to` filters take YYYY-MM-DD strings (UTC).
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function registerRecentOrders(server: McpServer): void {
  server.registerTool(
    "recent_orders",
    {
      title: "Recent Quiqup Orders",
      description:
        "Lists recent Quiqup last-mile orders from api-ae.quiqup.com filtered " +
        "by state and date range. Returns a compact projection (id, " +
        "partner_order_id, brand, state, contact, qty). Auth model: the inbound " +
        "OAuth at+jwt is exchanged via Clerk's backend SDK for a session-JWT " +
        "(template 'default') minted for the SAME user, then forwarded to " +
        "Quiqup. The user's Clerk identity is the only credential; no " +
        "Quiqup-side partner secret is stored on this server.",
      inputSchema: {
        // V1 input surface mirrors the skill's CLI shape so the mental model
        // is the same whether you're calling from Claude or the terminal.
        state: z
          .enum(ORDER_STATES)
          .default("pending")
          .describe(
            "Quiqup order state to filter by (the codes `list_quiqup_order_states` " +
              "returns). Delivered orders are `delivery_complete`; failed " +
              "deliveries are `delivery_failed`.",
          ),
        from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Inclusive start date YYYY-MM-DD. Defaults to 7 days ago."),
        to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Inclusive end date YYYY-MM-DD. Defaults to today (UTC)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(5)
          .describe("Max orders to return (1-50). Default 5 keeps responses small."),
        environment: environmentField,
      },
    },
    async (args, extra) => {
      // Pull the authenticated user's Clerk subject from the inbound AuthInfo
      // (set in route.ts by withMcpAuth's verifier). This is the user identity
      // we'll re-mint a session JWT for via Clerk's backend SDK.
      const clerkAuth = (extra.authInfo?.extra as { clerkAuth?: { subject?: string } } | undefined)?.clerkAuth;
      const userId = clerkAuth?.subject;
      if (!userId) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: "no userId in auth context" }) },
          ],
        };
      }

      // Defaults computed at call time so 'today' tracks the actual clock,
      // not the moment the Lambda cold-started.
      const from = args.from ?? isoDaysAgo(7);
      const to = args.to ?? isoDaysAgo(0);
      const state = args.state ?? "pending";
      const limit = args.limit ?? 5;

      // Quiqup requires all five filters: state, from, to, page, per_page.
      // Bracket encoding for `filters[state]` is handled by URLSearchParams
      // inside quiqupLastmileGet — callers pass the literal key.
      const data = await quiqupLastmileGet<OrdersResponse>(
        "/orders",
        {
          "filters[state]": state,
          from,
          to,
          page: 1,
          per_page: limit,
        },
        userId,
        args.environment ?? "production",
      );

      // Project the raw response to a chat-friendly shape. The full Quiqup
      // payload runs ~150 lines per order; we return ~10 fields per row.
      const rows = data.results.map((o) => ({
        id: o.id,
        uuid: o.uuid,
        state: o.state,
        partner_order_id: o.partner_order_id,
        brand: o.brand_name,
        contact: o.destination?.contact_name ?? null,
        emirate: o.destination?.emirate ?? null,
        items: o.item_quantity_count ?? null,
        created_at: o.created_at,
        state_updated_at: o.state_updated_at,
      }));

      const summary = {
        query: { state, from, to, limit },
        // `total` is authoritative for "how many match" across all pages.
        total_matching: data.total,
        returned: rows.length,
        orders: rows,
      };

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(summary, null, 2) },
        ],
      };
    },
  );
}
