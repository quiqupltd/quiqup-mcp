/**
 * Inbound auth for `/mcp` (people): Clerk OAuth at+jwt only.
 *
 * Extracted verbatim from `app/[transport]/route.ts` so it can be unit-tested
 * (Next route files may not export extra symbols). Behaviour is unchanged:
 * anything that is not a valid Clerk OAuth access token, including a Quiqup
 * platform token, yields `undefined`, which `withMcpAuth` turns into 401.
 */

import { auth } from "@clerk/nextjs/server";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

export async function verifyClerkOAuth(
  _req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> {
  if (!bearerToken) return undefined;

  const clerkAuth = await auth({ acceptsToken: "oauth_token" });
  if (!clerkAuth?.subject) return undefined;

  return {
    token: bearerToken,
    clientId: clerkAuth.clientId ?? "",
    scopes: clerkAuth.scopes ?? [],
    extra: { clerkAuth },
  };
}
