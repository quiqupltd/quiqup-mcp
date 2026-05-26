/**
 * Quiqup outbound auth — V3b (Clerk session-JWT exchange).
 *
 * Why this file exists, V3b edition:
 * The MCP receives an OAuth `at+jwt` token from Claude.ai (validated in
 * route.ts via `auth({ acceptsToken: 'oauth_token' })`). Quiqup's API gateway
 * speaks Clerk JWTs natively (see `quiqupltd/quiqup-platform`
 * /auth/auth_api/domain/service.go → `getUserFromClerkJWT`) — but ONLY the
 * session-JWT shape with the "default" template's custom claims
 * (`salesforceID`, `email`, `orgID`, `coreID`, `orgRole`, `firstName`, `lastName`,
 * `courierSalesforceID`). Our inbound `at+jwt` doesn't have those claims.
 *
 * So this module is a token translator: take the inbound user's Clerk `userId`,
 * use Clerk's backend SDK to mint a fresh session-shaped JWT for that user
 * with the "default" template, then forward THAT to Quiqup. No Quiqup-side
 * partner credentials are stored. The only stored secret is `CLERK_SECRET_KEY` —
 * the MCP server's identity at the IdP, used both here and for any future
 * actor-token / impersonation flows.
 *
 * Why not the previous V1 (`client_credentials` flow): V1 stored a Quiqup
 * partner OAuth2 client_id/secret in env. The user identity never crossed the
 * outbound boundary, so the BFF held credentials for *both* trust domains.
 * V3b eliminates the outbound credential entirely — the user's Clerk identity
 * is the credential, after a same-IdP shape conversion.
 */

import { createClerkClient } from "@clerk/backend";
import {
  getLastmileBaseUrl,
  getPlatformApiBaseUrl,
  type QuiqupEnvironment,
} from "@/lib/clients/quiqup-env";

// Matches what Quiqdash sends (verified empirically in Clerk dashboard:
// Sessions → JWT templates → "default" — claims include salesforceID etc.).
// Quiqup's auth handler expects exactly this template's output.
const SESSION_JWT_TEMPLATE = "default";

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

type CachedAuth = {
  // The Clerk-managed session row we created (or reused) for this user.
  // Sessions live for hours/days; we reuse them across token rotations.
  sessionId: string;
  // The minted templated JWT. Lifetime ~60s real (per Clerk's session JWT
  // behaviour — the dashboard says longer, but observed real lifetime is short).
  jwt: string;
  // Absolute epoch-ms when we'll re-mint. 50s gives a 10s safety margin.
  expiresAt: number;
};

// Module-scoped cache keyed by Clerk userId. Lost on cold start — that's fine,
// re-creating a session + minting a token is ~one round-trip.
const cache = new Map<string, CachedAuth>();

/**
 * Mints (or returns cached) a Clerk session JWT for the given userId, using
 * the "default" template — i.e. the same shape Quiqup's gateway accepts from
 * Quiqdash.
 *
 * We piggy-back on an existing active Clerk session for the user (e.g. their
 * Quiqdash login) rather than creating a synthetic one — `createSession` on
 * the Backend API is gated/unavailable in production tenants, and reusing
 * the user's real session keeps our impersonation traceable to a real login.
 *
 * `sessionHint` — the Clerk session ID embedded in the inbound OAuth token
 * (`clerkAuth.sessionId` from `auth({ acceptsToken: "oauth_token" })`).
 * When provided, the `getSessionList` round-trip is skipped entirely and the
 * hint session is used directly. This is the mechanism that lets managed-agent
 * OAuth flows work: a merchant who authenticated via the OAuth authorization
 * code flow has a valid Clerk session for their OAuth token, but no interactive
 * Quiqdash session — `getSessionList` would return empty and throw. Passing
 * the hint routes around that failure without changing any tool handler.
 *
 * Callers that don't have a session hint (e.g. the impersonation path, scope
 * helpers, legacy tools) continue to work via `getSessionList` as before.
 */
export async function getQuiqupReadyJwt(
  userId: string,
  sessionHint?: string | null,
): Promise<string> {
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.jwt;

  // Resolution order: cached sessionId > inbound hint > getSessionList.
  //
  // The hint path is used by managed-agent OAuth flows where the merchant has
  // no active interactive Quiqdash session. The sessionId comes from the
  // validated OAuth token (sid claim) and is forwarded by registerTool's
  // pre-warm step — so by the time any tool handler calls us, the cache is
  // already populated and this branch is only hit on the very first call per
  // request on a cold cache.
  let sessionId: string | undefined = cached?.sessionId ?? sessionHint ?? undefined;

  if (!sessionId) {
    // No hint and no cached session — fall back to listing active sessions.
    // Works for Quiqdash (interactive) users. Fails for OAuth-only merchants:
    // pass `sessionHint` (from registerTool's pre-warm) to avoid this path.
    const sessions = await clerk.sessions.getSessionList({
      userId,
      status: "active",
      limit: 1,
    });
    if (sessions.data.length === 0) {
      throw new Error(
        `No active Clerk session for userId ${userId}. ` +
          `Interactive users: sign into Quiqdash first. ` +
          `Managed-agent flows: ensure the OAuth sessionId is forwarded via ` +
          `the registerTool pre-warm (auth.sessionId → getQuiqupReadyJwt hint).`,
      );
    }
    sessionId = sessions.data[0].id;
  }

  // Mint a fresh JWT for this session with the templated claims.
  let jwt: string;
  try {
    const result = await clerk.sessions.getToken(sessionId, SESSION_JWT_TEMPLATE);
    jwt = result.jwt;
  } catch (err) {
    // The session may have been revoked between calls. Try to recover:
    // 1. Re-list active sessions (covers interactive Quiqdash users).
    // 2. If the list is empty (OAuth-only merchant, no interactive session),
    //    and the hint differs from the failed sessionId, try the hint once
    //    more — the OAuth session may have rotated underneath us.
    // 3. Otherwise rethrow so the caller gets a clear auth error.
    const sessions = await clerk.sessions.getSessionList({
      userId,
      status: "active",
      limit: 1,
    });

    let fallbackSessionId: string | undefined = sessions.data[0]?.id;

    if (!fallbackSessionId && sessionHint && sessionHint !== sessionId) {
      // OAuth-only path: the hint session is different from the one that
      // failed — try it as a last resort before giving up.
      fallbackSessionId = sessionHint;
    }

    if (!fallbackSessionId) {
      throw new Error(
        `Clerk session ${sessionId} unusable and no replacement active session exists ` +
          `for ${userId}. Underlying: ${(err as Error).message}`,
      );
    }

    sessionId = fallbackSessionId;
    const result = await clerk.sessions.getToken(sessionId, SESSION_JWT_TEMPLATE);
    jwt = result.jwt;
  }

  // sessionId is always defined by this point: the try block uses the value
  // resolved above; the catch block always assigns `fallbackSessionId` before
  // calling getToken (which would throw if it were undefined). The non-null
  // assertion makes the narrowing explicit to the type checker.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  cache.set(userId, {
    sessionId: sessionId!,
    jwt,
    expiresAt: Date.now() + 50_000,
  });
  return jwt;
}

// ---------------------------------------------------------------------------
// Impersonation helpers
// ---------------------------------------------------------------------------

/**
 * Thrown by `assertCallerIsAdminOrCsr` when the authenticated caller does not
 * hold an admin or CSR role on platform-api.quiqup.com. This is the gate
 * that prevents non-admin users from using `on_behalf_of_email`.
 */
export class ImpersonationForbiddenError extends Error {
  constructor(userId: string) {
    super(
      `userId=${userId} is not a Quiqup admin or CSR — on_behalf_of_email requires ` +
        "admin or CSR role (verified via platform-api /me). Run `whoami_platform` to " +
        "check your role before retrying.",
    );
    this.name = "ImpersonationForbiddenError";
  }
}

/**
 * Look up a Clerk user by their email address and return the Clerk userId.
 *
 * Uses the Clerk Backend SDK's `users.getUserList()` with an emailAddress
 * filter — this is the same `CLERK_SECRET_KEY`-gated SDK already used by
 * `getQuiqupReadyJwt`. Returns the first matching userId (Clerk enforces
 * email uniqueness within a tenant so there is at most one result).
 *
 * Throws if no matching user is found so callers receive a clear error
 * instead of silently minting a JWT for the wrong account.
 */
export async function lookupClerkUserByEmail(email: string): Promise<string> {
  const result = await clerk.users.getUserList({ emailAddress: [email] });
  if (result.data.length === 0) {
    throw new Error(
      `No Clerk user found with email ${email}. Verify the address is a registered ` +
        "Quiqup account and retry.",
    );
  }
  // Non-null assertion: we checked data.length === 0 above.
  // Clerk's SDK types `User.id` as `string | undefined` in some versions,
  // but a real user record always has an id — the undefined is defensive.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return result.data[0]!.id!;
}

/**
 * Verify that `callerUserId` holds an admin or CSR role on platform-api.
 *
 * Mints the caller's Quiqup session JWT (via `getQuiqupReadyJwt`) and calls
 * `GET /me` on platform-api. The response carries `admin: boolean` and
 * `csr: boolean` flags that Quiqup's backend populates from its own role
 * store — this is the authoritative source, not a JWT claim we trust blindly.
 *
 * Throws `ImpersonationForbiddenError` when neither flag is true, so the
 * `on_behalf_of_email` gate fails BEFORE any target email lookup (preventing
 * even the Clerk userId exfiltration that a successful lookup would enable).
 *
 * @param callerUserId  The authenticated MCP session's Clerk userId.
 * @param environment   Quiqup environment to verify against. Defaults to production.
 */
export async function assertCallerIsAdminOrCsr(
  callerUserId: string,
  environment: QuiqupEnvironment = "production",
): Promise<void> {
  const jwt = await getQuiqupReadyJwt(callerUserId);
  const base = getPlatformApiBaseUrl(environment);
  const res = await fetch(`${base}/me`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/json",
      "x-api-version": "1",
    },
  });
  if (!res.ok) {
    throw new Error(
      `Failed to verify admin status: platform-api /me returned HTTP ${res.status}. ` +
        "Run `whoami_platform` to diagnose auth.",
    );
  }
  const me = (await res.json()) as { admin?: boolean; csr?: boolean };
  if (!me.admin && !me.csr) {
    throw new ImpersonationForbiddenError(callerUserId);
  }
}

// ---------------------------------------------------------------------------

/**
 * Authenticated GET against the Quiqup last-mile API on behalf of the given
 * Clerk userId. The user's identity (via the minted session JWT) IS the
 * outbound credential — no separate Quiqup OAuth client involved.
 *
 * Pass query keys verbatim (e.g. `filters[state]`); URLSearchParams
 * percent-encodes the brackets that fetch otherwise rejects.
 */
export async function quiqupLastmileGet<T = unknown>(
  path: string,
  query: Record<string, string | number>,
  userId: string,
  environment: QuiqupEnvironment = "production",
): Promise<T> {
  if (!userId) {
    throw new Error(
      "quiqupLastmileGet requires the authenticated Clerk userId — pass clerkAuth.subject from the inbound AuthInfo.",
    );
  }
  if (!process.env.CLERK_SECRET_KEY) {
    throw new Error(
      "Missing CLERK_SECRET_KEY — required for backend session minting. Set it in Vercel env.",
    );
  }

  const jwt = await getQuiqupReadyJwt(userId);

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) qs.append(k, String(v));
  const base = getLastmileBaseUrl(environment);
  const url = `${base}${path}${qs.size ? `?${qs.toString()}` : ""}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Quiqup ${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}
