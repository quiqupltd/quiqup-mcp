/**
 * registerTool vs registerAgentTool: what each door offers, and the
 * fail-closed identity check between doors.
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAgentTool, registerTool, type ToolSpec } from "@/lib/tools/register";
import { environmentField } from "@/lib/clients/quiqup-env";
import { TOKEN } from "./helpers";

vi.mock("@/lib/quiqup", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getQuiqupReadyJwt: vi.fn(async () => "clerk-jwt") };
});

const spec: ToolSpec<z.ZodObject<{ order_id: z.ZodString; environment: typeof environmentField }>, z.ZodTypeAny> = {
  name: "stub_tool",
  description: "stub",
  inputSchema: z.object({ order_id: z.string(), environment: environmentField }),
  outputSchema: z.object({}).passthrough(),
  handler: vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }] })),
};

type Captured = {
  name: string;
  config: { inputSchema: Record<string, unknown> };
  cb: (args: Record<string, unknown>, extra: { authInfo?: unknown }) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }>;
};
function fakeServer() {
  const captured: Captured[] = [];
  const server = {
    registerTool: (name: string, config: Captured["config"], cb: Captured["cb"]) => {
      captured.push({ name, config, cb });
    },
  } as unknown as McpServer;
  return { server, captured };
}

const platformInfo = {
  token: TOKEN,
  clientId: "agent:carol",
  scopes: [],
  extra: {
    platform: { jwt: TOKEN, environment: "production", salesforceId: "001ABC", coreUserId: 1, email: "m@x.com", agent: "carol" },
  },
};
const clerkInfo = {
  token: "clerk-oauth",
  clientId: "c",
  scopes: [],
  extra: { clerkAuth: { subject: "user_1", sessionId: "s", orgId: null, scopes: [] } },
};

describe("schemas per door", () => {
  it("/mcp (registerTool) offers on_behalf_of_email and environment", () => {
    const { server, captured } = fakeServer();
    registerTool(server, spec);
    expect(Object.keys(captured[0].config.inputSchema)).toEqual(
      expect.arrayContaining(["order_id", "environment", "on_behalf_of_email"]),
    );
  });

  it("/agent/mcp (registerAgentTool) offers neither on_behalf_of_email nor environment", () => {
    const { server, captured } = fakeServer();
    registerAgentTool(server, spec);
    const keys = Object.keys(captured[0].config.inputSchema);
    expect(keys).toEqual(["order_id"]);
  });

  it("registering on the agent door does not mutate the spec's own schema", () => {
    const { server } = fakeServer();
    registerAgentTool(server, spec);
    expect(Object.keys(spec.inputSchema.shape)).toContain("environment");
  });
});

describe("door/identity consistency (fail closed)", () => {
  it("agent door runs a platform-token caller, with userId platform:<salesforceId> and the token as jwt", async () => {
    const seen: unknown[] = [];
    const s: typeof spec = {
      ...spec,
      handler: async (auth) => {
        seen.push(auth);
        return { content: [{ type: "text" as const, text: "ran" }] };
      },
    };
    const { server, captured } = fakeServer();
    registerAgentTool(server, s);
    const r = await captured[0].cb({ order_id: "1" }, { authInfo: platformInfo });
    expect(r.isError).toBeFalsy();
    expect(seen[0]).toMatchObject({
      userId: "platform:production:001ABC",
      sessionId: null,
      platformJwt: TOKEN,
      platformEnvironment: "production",
      agent: "carol",
      salesforceId: "001ABC",
    });
  });

  it("agent door refuses a caller that is not a platform-token caller (never falls back to Clerk)", async () => {
    const { server, captured } = fakeServer();
    registerAgentTool(server, spec);
    const r = await captured[0].cb({ order_id: "1" }, { authInfo: clerkInfo });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("/agent/mcp requires a Quiqup platform token");
  });

  it("/mcp refuses a platform-token caller", async () => {
    const { server, captured } = fakeServer();
    registerTool(server, spec);
    const r = await captured[0].cb({ order_id: "1" }, { authInfo: platformInfo });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("not accepted on /mcp");
  });

  it("an incomplete platform context throws rather than running", async () => {
    const { server, captured } = fakeServer();
    registerAgentTool(server, spec);
    await expect(
      captured[0].cb(
        { order_id: "1" },
        { authInfo: { ...platformInfo, extra: { platform: { jwt: TOKEN } } } },
      ),
    ).rejects.toThrow(/incomplete/);
  });
});
