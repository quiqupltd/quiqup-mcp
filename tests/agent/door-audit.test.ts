import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { auditPreCallbackErrors, toolCallsIn } from "@/lib/agent-door-audit";
import { captureAudit } from "./helpers";

const who = { userId: "platform:production:001ABC", agent: "carol", salesforceId: "001ABC", environment: "production" };
let audit: ReturnType<typeof captureAudit>;
beforeEach(() => { audit = captureAudit(); });
afterEach(() => audit.restore());

describe("auditPreCallbackErrors", () => {
  it("recognises a real JSON-RPC error response (plain JSON) and records only tool + code", () => {
    auditPreCallbackErrors(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "unpool_order", arguments: { order_id: "secret-arg" } } },
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad secret-arg" } }),
      who,
    );
    const r = audit.records();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ tool: "unpool_order", ok: false, agent: "carol", error: "rejected before tool callback: jsonrpc-error -32602" });
    expect(audit.raw().join("")).not.toContain("secret-arg");
  });

  it("ignores successful calls, tool-level isError results, non tools/call requests and batches correctly", () => {
    auditPreCallbackErrors(
      [
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "a" } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "b" } },
        { jsonrpc: "2.0", id: 3, method: "tools/list" },
      ],
      [
        'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"ok"}]}}',
        'data: {"jsonrpc":"2.0","id":2,"result":{"isError":true,"content":[{"type":"text","text":"Quiqup API returned HTTP 422."}]}}',
        'data: {"jsonrpc":"2.0","id":3,"error":{"code":-1}}',
      ].join("\n"),
      who,
    );
    expect(audit.records()).toHaveLength(0);
  });
});

describe("toolCallsIn (parsed JSON-RPC, not a substring search)", () => {
  it("finds tools/call in a single message and in a batch", () => {
    expect([...toolCallsIn({ id: 1, method: "tools/call", params: { name: "a" } })]).toEqual([["1", "a"]]);
    expect(toolCallsIn([{ id: 1, method: "tools/list" }, { id: 2, method: "tools/call", params: { name: "b" } }]).size).toBe(1);
  });
  it("ignores a non-call that merely contains the text", () => {
    expect(toolCallsIn({ id: 1, method: "tools/list", params: { note: "tools/call" } }).size).toBe(0);
    expect(toolCallsIn(null).size).toBe(0);
  });
});
