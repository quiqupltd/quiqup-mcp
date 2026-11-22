/**
 * Route-level tests: the two doors, end to end through mcp-handler.
 *   /mcp        Clerk OAuth only (people), every tool.
 *   /agent/mcp  Quiqup platform token only (agents), the allowlist.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { server } from "../setup/msw";
import { _resetAgentAuthCacheForTests } from "@/lib/agent-auth";
import { _resetForTests as resetIdempotency } from "@/lib/middleware/idempotency";
import { _resetForTests as resetRateLimit } from "@/lib/middleware/rate-limit";
import { CLERK_AT_JWT, PLATFORM, PLATFORM_STAGING, TOKEN, captureAudit } from "./helpers";

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ subject: undefined })),
}));
import { auth as clerkAuthFn } from "@clerk/nextjs/server";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_BASELINE = (
  JSON.parse(readFileSync(resolve(HERE, "../../evals/snapshots/tool-surface-agent.json"), "utf8")) as {
    tools: Record<string, string>;
  }
).tools;

const ME_OK = { salesforce_id: "001ABC", core_api_user_id: 1, email: "m@example.com", admin: false, csr: false };

function rpc(
  url: string,
  headers: Record<string, string>,
  body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
) {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
async function rpcResult(res: Response): Promise<{ result?: any; error?: any }> {
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return line ? JSON.parse(line.slice(6)) : JSON.parse(text);
}

const agentHeaders = { Authorization: `Bearer ${TOKEN}`, "X-Quiqup-Agent": "carol" };

beforeEach(() => {
  _resetAgentAuthCacheForTests();
  resetIdempotency();
  resetRateLimit();
  vi.mocked(clerkAuthFn).mockReset();
  vi.mocked(clerkAuthFn).mockResolvedValue({ subject: undefined } as never);
  delete process.env.QUIQUP_PLATFORM_API_BASE_URL;
  delete process.env.QUIQUP_PLATFORM_API_STAGING_BASE_URL;
});
afterEach(() => vi.restoreAllMocks());

describe("/mcp (people, Clerk OAuth)", () => {
  it("rejects a Quiqup platform token with 401 (it is not a Clerk OAuth token) and never calls platform-api", async () => {
    const { POST } = await import("@/app/[transport]/route");
    // No msw handlers: any /me call would error the test.
    const res = await POST(rpc("http://localhost/mcp", { Authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("rejects a missing bearer with 401", async () => {
    const { POST } = await import("@/app/[transport]/route");
    expect((await POST(rpc("http://localhost/mcp", {}))).status).toBe(401);
  });

  it("still accepts a Clerk OAuth token and serves every tool, with on_behalf_of_email offered", async () => {
    vi.mocked(clerkAuthFn).mockResolvedValue({
      subject: "user_123",
      clientId: "client_1",
      scopes: ["email"],
      sessionId: "sess_1",
    } as never);
    const { POST } = await import("@/app/[transport]/route");
    const res = await POST(rpc("http://localhost/mcp", { Authorization: "Bearer clerk-oauth-token" }));
    expect(res.status).toBe(200);
    const { result } = await rpcResult(res);
    const names: string[] = result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("send_orders_for_collection");
    expect(names).toContain("cancel_lastmile_orders_batch");
    expect(names).toContain("recent_orders");
    expect(names).toContain("claims_dump");
    const cancel = result.tools.find((t: { name: string }) => t.name === "cancel_lastmile_orders_batch");
    expect(Object.keys(cancel.inputSchema.properties)).toEqual(
      expect.arrayContaining(["order_ids", "reason", "idempotency_key", "environment", "on_behalf_of_email"]),
    );
    expect(cancel.inputSchema.required).toEqual(["order_ids"]); // reason optional on /mcp
  });
});

describe("/agent/mcp (agents, platform token)", () => {
  it("refuses a Clerk OAuth token (typ at+jwt) locally: 401, no /me call, Clerk never consulted", async () => {
    // No /me handler: a call would fail the test.
    const { POST } = await import("@/app/agent/[transport]/route");
    const res = await POST(rpc("http://localhost/agent/mcp", { ...agentHeaders, Authorization: `Bearer ${CLERK_AT_JWT}` }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("invalid_token");
    expect(clerkAuthFn).not.toHaveBeenCalled();
  });

  it("refuses a missing X-Quiqup-Agent with 400", async () => {
    const { POST } = await import("@/app/agent/[transport]/route");
    const res = await POST(rpc("http://localhost/agent/mcp", { Authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(400);
    expect((await res.json()).error_description).toContain("X-Quiqup-Agent");
  });

  it("refuses an admin token with 403 and audits the refusal (agent label, no token)", async () => {
    server.use(http.get(`${PLATFORM}/me`, () => HttpResponse.json({ ...ME_OK, admin: true })));
    const audit = captureAudit();
    try {
      const { POST } = await import("@/app/agent/[transport]/route");
      const res = await POST(rpc("http://localhost/agent/mcp", agentHeaders));
      expect(res.status).toBe(403);
      expect(audit.records()).toHaveLength(1);
      expect(audit.records()[0]).toMatchObject({
        tool: "agent_door_auth",
        ok: false,
        agent: "carol",
        error: "door-refused: 403 forbidden",
      });
      expect(audit.raw().join("")).not.toContain(TOKEN);
    } finally {
      audit.restore();
    }
  });

  it("serves exactly the allowlist (matches the snapshot), without on_behalf_of_email or environment", async () => {
    server.use(http.get(`${PLATFORM}/me`, () => HttpResponse.json(ME_OK)));
    const { POST } = await import("@/app/agent/[transport]/route");
    const res = await POST(rpc("http://localhost/agent/mcp", agentHeaders));
    expect(res.status).toBe(200);
    const { result } = await rpcResult(res);
    const names = result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(Object.keys(AGENT_BASELINE).sort());
    for (const t of result.tools) {
      const props = Object.keys(t.inputSchema.properties ?? {});
      expect(props).not.toContain("on_behalf_of_email");
      expect(props).not.toContain("environment");
    }
    const cancel = result.tools.find((t: { name: string }) => t.name === "cancel_lastmile_orders_batch");
    expect(Object.keys(cancel.inputSchema.properties)).toContain("reason");
  });

  it("end to end: tools/call forwards the platform token upstream and audits agent + merchant", async () => {
    let seenAuth: string | null = null;
    server.use(
      http.get(`${PLATFORM}/me`, () => HttpResponse.json(ME_OK)),
      http.get(`${PLATFORM}/quiqdash/orders`, () => HttpResponse.json({ results: [{ id: 123, uuid: "u" }] })),
      http.get(`${PLATFORM}/quiqdash/orders/find_by_id_or_barcode`, ({ request }) => {
        seenAuth = request.headers.get("authorization");
        return HttpResponse.json({ found_by: "id", order: { id: 123, state: "pending" } });
      }),
    );
    const audit = captureAudit();
    try {
      const { POST } = await import("@/app/agent/[transport]/route");
      const res = await POST(
        rpc("http://localhost/agent/mcp", agentHeaders, {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "find_order_by_id_or_barcode", arguments: { value: "123", intention: "set_cancelled" } },
        }),
      );
      const { result } = await rpcResult(res);
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('"state": "pending"');
      expect(seenAuth).toBe(`Bearer ${TOKEN}`);
      expect(audit.records()).toHaveLength(1);
      expect(audit.records()[0]).toMatchObject({
        tool: "find_order_by_id_or_barcode",
        userId: "platform:production:001ABC",
        agent: "carol",
        salesforceId: "001ABC",
        environment: "production",
        ok: true,
      });
      expect(audit.raw().join("")).not.toContain(TOKEN);
    } finally {
      audit.restore();
    }
  });

  it("X-Quiqup-Environment: staging routes verification AND tool calls to staging", async () => {
    let stagingMe = false;
    let stagingFind = false;
    server.use(
      http.get(`${PLATFORM_STAGING}/me`, () => {
        stagingMe = true;
        return HttpResponse.json(ME_OK);
      }),
      http.get(`${PLATFORM_STAGING}/quiqdash/orders/find_by_id_or_barcode`, () => {
        stagingFind = true;
        return HttpResponse.json({ order: {} });
      }),
    );
    const audit = captureAudit();
    try {
      const { POST } = await import("@/app/agent/[transport]/route");
      const res = await POST(
        rpc("http://localhost/agent/mcp", { ...agentHeaders, "X-Quiqup-Environment": "staging" }, {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "find_order_by_id_or_barcode", arguments: { value: "1", intention: "set_cancelled" } },
        }),
      );
      await rpcResult(res); // the tool runs while the response stream is read
      expect(stagingMe && stagingFind).toBe(true);
      expect(audit.records()[0]).toMatchObject({ environment: "staging" });
    } finally {
      audit.restore();
    }
  });

  it("audits tools/call requests that fail validation or name an unknown tool (JSON-RPC error before the callback), no args", async () => {
    server.use(http.get(`${PLATFORM}/me`, () => HttpResponse.json(ME_OK)));
    const audit = captureAudit();
    try {
      const { POST } = await import("@/app/agent/[transport]/route");
      const call = (id: number, name: string, args: unknown) =>
        POST(
          rpc("http://localhost/agent/mcp", agentHeaders, {
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        ).then((r) => r.text());
      // 11 ids: fails the input schema before the callback.
      await call(10, "send_orders_for_collection", {
        order_ids: Array.from({ length: 11 }, (_, i) => String(i + 1)),
        confirm: true,
      });
      // not an allowlisted tool
      await call(11, "set_delivery_complete", { order_ids: ["1"], secret: "do-not-log" });
      const recs = audit.records();
      expect(recs.map((r) => r.tool).sort()).toEqual(["send_orders_for_collection", "set_delivery_complete"]);
      for (const r of recs) {
        expect(r).toMatchObject({
          ok: false,
          agent: "carol",
          salesforceId: "001ABC",
          environment: "production",
          userId: "platform:production:001ABC",
        });
        expect(String(r.error)).toContain("rejected before tool callback");
        expect(r.argsRedacted).toEqual({});
      }
      expect(recs.map((r) => r.error).sort()).toEqual([
        "rejected before tool callback: input-validation",
        "rejected before tool callback: unknown-tool",
      ]);
      expect(audit.raw().join("")).not.toContain("do-not-log");
    } finally {
      audit.restore();
    }
  });

  it("a tool call that reaches the callback is audited once, not twice", async () => {
    server.use(
      http.get(`${PLATFORM}/me`, () => HttpResponse.json(ME_OK)),
      http.get(`${PLATFORM}/orders/partner-cancellation-reasons`, () => HttpResponse.json({ reasons: [] })),
    );
    const audit = captureAudit();
    try {
      const { POST } = await import("@/app/agent/[transport]/route");
      const res = await POST(
        rpc("http://localhost/agent/mcp", agentHeaders, {
          jsonrpc: "2.0",
          id: 20,
          method: "tools/call",
          params: { name: "list_partner_cancellation_reasons", arguments: {} },
        }),
      );
      await res.text();
      expect(audit.records()).toHaveLength(1);
    } finally {
      audit.restore();
    }
  });

  it("a tool outside the allowlist is simply not there", async () => {
    server.use(http.get(`${PLATFORM}/me`, () => HttpResponse.json(ME_OK)));
    const { POST } = await import("@/app/agent/[transport]/route");
    const res = await POST(
      rpc("http://localhost/agent/mcp", agentHeaders, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "set_delivery_complete", arguments: { order_ids: ["1"], confirm: true } },
      }),
    );
    const body = await rpcResult(res);
    // Unknown tool: either a JSON-RPC error or an isError result, never a success.
    expect(body.error ?? body.result?.isError).toBeTruthy();
  });
});
