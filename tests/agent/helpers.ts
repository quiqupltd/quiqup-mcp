import { vi } from "vitest";
import type { AuthContext } from "@/lib/tools/register";
import { AUDIT_PREFIX } from "@/lib/middleware/audit";

export const PLATFORM = "https://platform-api.quiqup.com";
export const PLATFORM_STAGING = "https://platform-api.staging.quiqup.com";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** A JWT-shaped platform token (header typ JWT). Fake, signature is junk. */
export const TOKEN = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ sub: "u1", marker: "SECRET-PAYLOAD" })}.c2lnbmF0dXJl`;
/** A Clerk OAuth access token shape (header typ at+jwt). */
export const CLERK_AT_JWT = `${b64({ alg: "RS256", typ: "at+jwt" })}.${b64({ sub: "user_1" })}.c2lnbmF0dXJl`;

/** AuthContext exactly as registerTool builds it for a platform-token caller. */
export function platformAuth(over: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: "platform:production:001ABC",
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
