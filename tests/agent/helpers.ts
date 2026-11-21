import { vi } from "vitest";
import type { AuthContext } from "@/lib/tools/register";
import { AUDIT_PREFIX } from "@/lib/middleware/audit";

export const PLATFORM = "https://platform-api.quiqup.com";
export const PLATFORM_STAGING = "https://platform-api.staging.quiqup.com";
export const TOKEN = "plat-token-SECRET-1";

/** AuthContext exactly as registerTool builds it for a platform-token caller. */
export function platformAuth(over: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: "platform:001ABC",
    orgId: null,
    sessionId: null,
    scopes: [],
    bearerToken: TOKEN,
    effectiveUserId: null,
    impersonatedEmail: null,
    platformJwt: TOKEN,
    platformEnvironment: "production",
    agent: "carol",
    salesforceId: "001ABC",
    ...over,
  };
}

/** Capture `audit:` stdout lines; returns parsed records. */
export function captureAudit() {
  const lines: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    });
  return {
    raw: () => lines.filter((l) => l.startsWith(`${AUDIT_PREFIX} `)),
    records: () =>
      lines
        .filter((l) => l.startsWith(`${AUDIT_PREFIX} `))
        .map((l) => JSON.parse(l.slice(AUDIT_PREFIX.length + 1).trimEnd()) as Record<string, unknown>),
    restore: () => spy.mockRestore(),
  };
}

/** Text of the first text block of a tool result. */
export function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  if (first.type !== "text" || first.text === undefined) throw new Error("expected text block");
  return first.text;
}
