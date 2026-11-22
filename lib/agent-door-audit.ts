/**
 * Door-level audit for `/agent/mcp`: `tools/call` requests that end in a
 * JSON-RPC error BEFORE the tool callback runs (input validation, unknown
 * tool). The per-tool audit lives inside the registered callback, so those
 * calls would otherwise leave no record.
 *
 * mcp SDK 1.x reports both cases to the client as a normal result with
 * `isError: true` and text "MCP error -32602: Input validation error ..." or
 * "MCP error -32602: Tool <x> not found" (older paths use a real JSON-RPC
 * `error`); both shapes are recognised. A tool that runs and fails returns
 * isError text without that prefix and is audited by the tool wrapper, so it
 * is not double counted here.
 *
 * Only the tool name, agent, merchant, environment and the JSON-RPC error
 * code are recorded: never arguments (a validation message can echo them)
 * and never the token.
 */

import { emitAuditRecord } from "@/lib/middleware/audit";

type JsonRpcMessage = {
  id?: unknown;
  method?: unknown;
  params?: { name?: unknown };
  error?: { code?: unknown };
  result?: { isError?: unknown; content?: Array<{ type?: unknown; text?: unknown }> };
};

function asArray(body: unknown): JsonRpcMessage[] {
  if (Array.isArray(body)) return body as JsonRpcMessage[];
  return body && typeof body === "object" ? [body as JsonRpcMessage] : [];
}

/** `tools/call` requests in a (possibly batched) JSON-RPC request body: id -> tool name. */
export function toolCallsIn(body: unknown): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of asArray(body)) {
    if (m.method === "tools/call" && m.id !== undefined && m.id !== null) {
      out.set(String(m.id), typeof m.params?.name === "string" ? m.params.name : "(unnamed)");
    }
  }
  return out;
}

/** JSON-RPC messages in a response body, plain JSON or SSE `data:` lines. */
export function messagesIn(text: string): JsonRpcMessage[] {
  const msgs: JsonRpcMessage[] = [];
  const candidates = text.includes("data:")
    ? text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
    : [text];
  for (const c of candidates) {
    try {
      msgs.push(...asArray(JSON.parse(c)));
    } catch {
      // not JSON: ignore
    }
  }
  return msgs;
}

/** Category of a pre-callback rejection, or null when the message is not one. */
function preCallbackKind(m: JsonRpcMessage): string | null {
  if (m.error !== undefined) return `jsonrpc-error ${String(m.error.code ?? "unknown")}`;
  if (m.result?.isError === true) {
    const text = m.result.content?.find((c) => c.type === "text")?.text;
    if (typeof text === "string") {
      if (/^MCP error -?\d+: Input validation error/.test(text)) return "input-validation";
      if (/^MCP error -?\d+: Tool .+ not found/.test(text)) return "unknown-tool";
    }
  }
  return null;
}

/** Emit one audit record per `tools/call` rejected before its tool callback ran. */
export function auditPreCallbackErrors(
  requestBody: unknown,
  responseText: string,
  who: { userId: string; agent: string; salesforceId: string; environment: string },
): void {
  const calls = toolCallsIn(requestBody);
  if (calls.size === 0) return;
  for (const m of messagesIn(responseText)) {
    if (m.id === undefined || m.id === null) continue;
    const tool = calls.get(String(m.id));
    if (tool === undefined) continue;
    const kind = preCallbackKind(m);
    if (kind === null) continue;
    emitAuditRecord({
      userId: who.userId,
      orgId: null,
      tool,
      args: {},
      durationMs: 0,
      ok: false,
      error: `rejected before tool callback: ${kind}`,
      agent: who.agent,
      salesforceId: who.salesforceId,
      environment: who.environment,
    });
  }
}
