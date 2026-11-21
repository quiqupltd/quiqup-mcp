/**
 * Caller-aware upstream auth: the ONE place a tool gets its Quiqup JWT and
 * the one place an order-ownership check picks its upstream.
 *
 * Two kinds of caller reach the tool handlers:
 *
 *   - Clerk callers (`/mcp`, a person signed in through Clerk OAuth): the
 *     upstream JWT is minted by `getQuiqupReadyJwt` from their Clerk session,
 *     exactly as before.
 *   - Platform-token callers (`/agent/mcp`, a server agent presenting a
 *     merchant's Quiqup platform token): the token IS the upstream JWT. It is
 *     validated once on platform-api `/me` by the agent door's verifier and
 *     then forwarded as-is. No Clerk session exists for them, so the Clerk
 *     path must never be reached (`auth.userId` is `platform:<salesforceId>`,
 *     which is not a Clerk id).
 *
 * This lives outside `lib/quiqup.ts` on purpose: existing tool tests mock
 * `@/lib/quiqup` and `@/lib/middleware/scope`; keeping the dispatch in a
 * separate module means those mocks still apply to the Clerk branch.
 */

import type { QuiqupEnvironment } from "@/lib/clients/quiqup-env";
import { assertOrderBelongsToUser, assertOrderBelongsToPlatformCaller } from "@/lib/middleware/scope";
import { getQuiqupReadyJwt } from "@/lib/quiqup";
import type { AuthContext } from "@/lib/tools/register";

/** True when the caller authenticated with a Quiqup platform token. */
export function isPlatformCaller(auth: AuthContext): boolean {
  return typeof auth.platformJwt === "string" && auth.platformJwt.length > 0;
}

/**
 * Thrown when a platform-token caller asks a tool to act on an environment
 * other than the one its token was verified against. A staging token must
 * never be sent to production (or the reverse) just because a tool argument
 * said so.
 */
export class PlatformEnvironmentMismatchError extends Error {
  constructor(requested: string, actual: string) {
    super(
      `Environment mismatch: this token was verified against \`${actual}\` ` +
        `(X-Quiqup-Environment) but the tool call asked for \`${requested}\`. ` +
        `Omit the environment argument or send the request with the matching header.`,
    );
    this.name = "PlatformEnvironmentMismatchError";
  }
}

/**
 * Resolve the upstream JWT for a tool call.
 *
 * @param auth         the AuthContext the registerTool wrapper built
 * @param environment  the tool's `environment` argument, if it has one
 */
export async function jwtFor(
  auth: AuthContext,
  environment?: QuiqupEnvironment,
): Promise<string> {
  if (isPlatformCaller(auth)) {
    const actual = auth.platformEnvironment ?? "production";
    if (environment !== undefined && environment !== actual) {
      throw new PlatformEnvironmentMismatchError(environment, actual);
    }
    return auth.platformJwt as string;
  }
  if (!auth.userId) {
    throw new Error("jwtFor requires an authenticated user (no userId in auth context).");
  }
  return getQuiqupReadyJwt(auth.userId);
}

/**
 * Ownership check for an order id, per caller kind.
 *
 * Clerk callers keep the existing last-mile probe (`assertOrderBelongsToUser`).
 * Platform-token callers use platform-api (the host their token is valid on):
 * the order must appear in the caller's own order list.
 */
export async function assertOrderOwned(
  auth: AuthContext,
  orderId: string,
  environment?: QuiqupEnvironment,
): Promise<void> {
  if (isPlatformCaller(auth)) {
    const actual = auth.platformEnvironment ?? "production";
    if (environment !== undefined && environment !== actual) {
      throw new PlatformEnvironmentMismatchError(environment, actual);
    }
    await assertOrderBelongsToPlatformCaller(
      orderId,
      auth.userId ?? "platform:unknown",
      { jwt: auth.platformJwt as string, environment: actual },
    );
    return;
  }
  if (!auth.userId) {
    throw new Error("assertOrderOwned requires an authenticated user (no userId in auth context).");
  }
  await assertOrderBelongsToUser(orderId, auth.userId);
}
