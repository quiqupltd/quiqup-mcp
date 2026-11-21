import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { AGENT_HEADER, AGENT_LABEL_RE, verifyAgentRequest } from "@/lib/agent-auth";
import { emitAuditRecord } from "@/lib/middleware/audit";
import { registerAgentTool } from "@/lib/tools/register";

/**
 * `/agent/mcp` - the door for server agents (Carol).
 *
 * Accepts ONLY a merchant's Quiqup platform token as the bearer (validated on
 * platform-api /me, forwarded upstream as-is) plus the X-Quiqup-Agent label
 * header. Never a Clerk OAuth token. Serves a small allowlist of order tools;
 * everything else is simply not registered here. `/mcp` (people, Clerk OAuth,
 * every tool) lives in app/[transport]/route.ts and is unaffected.
 *
 * Every call on this door is audited with the agent and the merchant
 * (see invokeWithGuardrails in lib/tools/register.ts).
 *
 * To add a tool to this door, import its spec below and register it with
 * `registerAgentTool`. The tool-surface snapshot for this door
 * (evals/snapshots/tool-surface-agent.json) must change in the same PR.
 */

// Order reads (platform-api).
import { spec as findOrderByIdOrBarcodeSpec } from "@/lib/tools/find-order-by-id-or-barcode";
import { spec as listPartnerCancellationReasonsSpec } from "@/lib/tools/list-partner-cancellation-reasons";

// Inventory reads (fulfilment routes on platform-api, account-scoped by the token).
import { spec as listInventorySpec } from "@/lib/tools/list-inventory";
import { spec as getInventoryBySkuSpec } from "@/lib/tools/get-inventory-by-sku";

// Order writes (platform-api, merchant routes). Cancel needs a `reason` here.
import { spec as cancelLastmileOrdersBatchSpec } from "@/lib/tools/cancel-lastmile-orders-batch";
import { spec as sendOrdersForCollectionSpec } from "@/lib/tools/send-orders-for-collection";
import { agentSpec as unpoolOrderAgentSpec } from "@/lib/tools/unpool-order";
import { agentSpec as repairIntegrationOrdersAgentSpec } from "@/lib/tools/repair-integration-orders";

export const maxDuration = 60;

const handler = createMcpHandler(
  (server) => {
    registerAgentTool(server, findOrderByIdOrBarcodeSpec);
    registerAgentTool(server, listPartnerCancellationReasonsSpec);
    registerAgentTool(server, listInventorySpec);
    registerAgentTool(server, getInventoryBySkuSpec);

    registerAgentTool(server, cancelLastmileOrdersBatchSpec);
    registerAgentTool(server, sendOrdersForCollectionSpec);
    registerAgentTool(server, unpoolOrderAgentSpec);
    registerAgentTool(server, repairIntegrationOrdersAgentSpec);
  },
  {
    serverInfo: { name: "Quiqup Orders (agent)", version: "0.1.0" },
  },
  // SSE needs Redis and is not part of the MCP spec any more: streamable HTTP only.
  { basePath: "/agent", disableSse: true },
);

// The verified identity travels from the pre-check below into withMcpAuth's
// verifier on the very same Request object (never via a shared variable, so
// concurrent requests cannot see each other's identity).
const verified = new WeakMap<Request, AuthInfo>();

const authed = withMcpAuth(
  handler,
  async (req) => verified.get(req),
  { required: true, resourceMetadataPath: "/.well-known/oauth-protected-resource" },
);

async function agentHandler(req: Request): Promise<Response> {
  const result = await verifyAgentRequest(req);
  if (!result.ok) {
    // A refused door call is still a call: record it (agent label only if it
    // is well-formed; never the token, never the raw header value).
    const label = req.headers.get(AGENT_HEADER)?.trim() ?? "";
    emitAuditRecord({
      userId: null,
      orgId: null,
      tool: "agent_door_auth",
      args: {},
      durationMs: 0,
      ok: false,
      error: `door-refused: ${result.status} ${result.error}`,
      agent: AGENT_LABEL_RE.test(label) ? label : null,
    });
  }
  if (result.ok) {
    verified.set(req, result.authInfo);
  } else if (result.status !== 401) {
    return new Response(
      JSON.stringify({ error: result.error, error_description: result.description }),
      { status: result.status, headers: { "Content-Type": "application/json" } },
    );
  }
  // 401 (and success): withMcpAuth answers. No identity in the WeakMap means
  // it returns the standard 401 + WWW-Authenticate.
  return authed(req);
}

export { agentHandler as GET, agentHandler as POST };
