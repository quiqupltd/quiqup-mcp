/**
 * Inbound auth for `/agent/mcp` (server agents): a merchant's Quiqup
 * platform token as the bearer, nothing else.
 *
 * Why this exists: Carol (the onboarding agent) already mints a per-merchant
 * platform token (`POST /admin/oauth/actor-token`). The agent door accepts
 * that token as-is and uses it upstream as-is: no new secret, no minting
 * here. The token is validated once on platform-api `GET /me` for the
 * environment the caller names, and the identity that comes back keys
 * everything per merchant (rate limits, idempotency, audit).
 *
 * Request contract:
 *   Authorization: Bearer <platform token>
 *   X-Quiqup-Environment: production | staging   (optional, default production)
 *   X-Quiqup-Agent: ^[a-z][a-z0-9-]{0,31}$       (required, e.g. "carol")
 *
 * Refusals: bad/missing agent label or bad environment -> 400; invalid or
 * expired token -> 401; an admin or CSR token -> 403 (agents act as exactly
 * one merchant; admin work goes through `/mcp` with a person); `/me` itself
 * unavailable -> 503.
 *
 * Live facts about platform-api `GET /me` (captured against production):
 *   - a bearer that is NOT a JWT is forwarded by the platform to a legacy
 *     service and answered 500 `{"code":"unknown", ... connection refused}`;
 *   - a JWT-shaped bad token is answered 401 `{"code":"unauthenticated",
 *     "message":"api auth failed"}`.
 * So a bearer that is not three base64url segments with a JSON header is
 * refused locally (401) without calling `/me` (that 500 would otherwise look
 * like an outage), a header `typ` of `at+jwt` (a Clerk OAuth access token) is
 * refused locally too, and 503 is kept for a real outage only: a 5xx from
 * `/me` for a well-formed JWT, or a network failure.
 *
 * Secrecy: the raw token is never logged and never used as a cache key. The
 * 50 s verification cache is keyed by sha256(token + environment) and stores
 * only the identity returned by `/me`.
 */

import { createHash } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  getPlatformApiBaseUrl,
  isQuiqupEnvironment,
  type QuiqupEnvironment,
} from "@/lib/clients/quiqup-env";

export const AGENT_LABEL_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const ENVIRONMENT_HEADER = "x-quiqup-environment";
export const AGENT_HEADER = "x-quiqup-agent";
/** Upper bound for reusing a valid `/me` verification (brief: at most 50 s). */
export const VERIFY_CACHE_TTL_MS = 50_000;
const VERIFY_CACHE_MAX_ENTRIES = 500;
const ME_TIMEOUT_MS = 10_000;

export interface PlatformIdentity {
  salesforceId: string;
  coreUserId: number | string | null;
  email: string | null;
  admin: boolean;
  csr: boolean;
  roles: string[];
}

export interface AgentPlatformExtra {
  jwt: string;
  environment: QuiqupEnvironment;
  salesforceId: string;
  coreUserId: number | string | null;
  email: string | null;
  agent: string;
}

export type AgentVerifyResult =
  | { ok: true; authInfo: AuthInfo }
  | {
      ok: false;
      /** 401 means "let withMcpAuth answer with the standard 401 + WWW-Authenticate". */
      status: 400 | 401 | 403 | 503;
      error: string;
      description: string;
    };

const cache = new Map<string, { identity: PlatformIdentity; expiresAt: number }>();
/** Short negative cache: refused tokens (platform said 401/403) skip `/me` for a while. */
export const NEGATIVE_CACHE_TTL_MS = 30_000;
const negativeCache = new Map<string, number>(); // key -> expiresAt

function negativeHit(key: string): boolean {
  const exp = negativeCache.get(key);
  if (exp === undefined) return false;
  if (exp <= Date.now()) {
    negativeCache.delete(key);
    return false;
  }
  return true;
}

function negativeSet(key: string): void {
  if (negativeCache.size >= VERIFY_CACHE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of negativeCache) if (v <= now) negativeCache.delete(k);
    if (negativeCache.size >= VERIFY_CACHE_MAX_ENTRIES) {
      const oldest = negativeCache.keys().next().value;
      if (oldest !== undefined) negativeCache.delete(oldest);
    }
  }
  negativeCache.set(key, Date.now() + NEGATIVE_CACHE_TTL_MS);
}

const B64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * "JWT-shaped": three non-empty base64url segments whose first decodes to a
 * JSON object. Returns the decoded header, or null.
 */
function jwtHeader(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((p) => B64URL_SEGMENT.test(p))) return null;
  try {
    const header: unknown = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    return header !== null && typeof header === "object" && !Array.isArray(header)
      ? (header as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function cacheKey(token: string, environment: QuiqupEnvironment): string {
  return createHash("sha256").update(`${environment}\0${token}`).digest("hex");
}

function cacheGet(key: string): PlatformIdentity | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.identity;
}

function cacheSet(key: string, identity: PlatformIdentity): void {
  if (cache.size >= VERIFY_CACHE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
    // Still full: drop the oldest insertion (Map keeps insertion order).
    if (cache.size >= VERIFY_CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }
  cache.set(key, { identity, expiresAt: Date.now() + VERIFY_CACHE_TTL_MS });
}

/** Tests only. */
export function _resetAgentAuthCacheForTests(): void {
  cache.clear();
  negativeCache.clear();
}
/** Tests only: lets a test prove the raw token is never stored. */
export function _agentAuthCacheSnapshotForTests(): Array<{ key: string; value: string }> {
  return [
    ...[...cache].map(([key, v]) => ({ key, value: JSON.stringify(v) })),
    ...[...negativeCache].map(([key, v]) => ({ key, value: String(v) })),
  ];
}

type MeResponse = {
  salesforce_id?: unknown;
  core_api_user_id?: unknown;
  email?: unknown;
  admin?: unknown;
  csr?: unknown;
  roles?: unknown;
};

/** Returns the identity, `"invalid"` for 401/403/other 4xx, or `"unavailable"`. */
async function fetchIdentity(
  token: string,
  environment: QuiqupEnvironment,
): Promise<PlatformIdentity | "invalid" | "unavailable"> {
  let res: Response;
  try {
    res = await fetch(`${getPlatformApiBaseUrl(environment)}/me`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "x-api-version": "1",
      },
      signal: AbortSignal.timeout(ME_TIMEOUT_MS),
    });
  } catch {
    // Network error / timeout. Deliberately no logging of the error object:
    // some runtimes include request headers in it.
    return "unavailable";
  }
  if (res.status >= 500) return "unavailable";
  if (!res.ok) return "invalid";

  let me: MeResponse;
  try {
    me = (await res.json()) as MeResponse;
  } catch {
    return "unavailable";
  }
  // A token that resolves but carries no Salesforce id cannot be keyed per
  // merchant. Treat it as not usable on this door.
  if (typeof me.salesforce_id !== "string" || me.salesforce_id.length === 0) {
    return "invalid";
  }
  return {
    salesforceId: me.salesforce_id,
    coreUserId:
      typeof me.core_api_user_id === "number" || typeof me.core_api_user_id === "string"
        ? me.core_api_user_id
        : null,
    email: typeof me.email === "string" ? me.email : null,
    admin: me.admin === true,
    csr: me.csr === true,
    roles: Array.isArray(me.roles) ? me.roles.filter((r): r is string => typeof r === "string") : [],
  };
}

/**
 * Validate one inbound `/agent/mcp` request. Never throws.
 */
export async function verifyAgentRequest(req: Request): Promise<AgentVerifyResult> {
  const authHeader = req.headers.get("authorization");
  const [type, token] = authHeader?.split(" ") ?? [];
  const bearer = type?.toLowerCase() === "bearer" && token ? token : undefined;
  if (!bearer) {
    return {
      ok: false,
      status: 401,
      error: "invalid_token",
      description: "Missing bearer token.",
    };
  }

  const header = jwtHeader(bearer);
  if (!header) {
    // Never forwarded to /me: platform-api answers a non-JWT with a 500.
    return {
      ok: false,
      status: 401,
      error: "invalid_token",
      description: "Bearer token is not a JWT.",
    };
  }
  if (typeof header.typ === "string" && header.typ.toLowerCase() === "at+jwt") {
    return {
      ok: false,
      status: 401,
      error: "invalid_token",
      description: "Clerk OAuth access tokens are not accepted on /agent/mcp; use a Quiqup platform token.",
    };
  }

  const agent = req.headers.get(AGENT_HEADER)?.trim() ?? "";
  if (!AGENT_LABEL_RE.test(agent)) {
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      description:
        "X-Quiqup-Agent header is required and must match ^[a-z][a-z0-9-]{0,31}$ (e.g. \"carol\").",
    };
  }

  const envRaw = req.headers.get(ENVIRONMENT_HEADER)?.trim() || "production";
  if (!isQuiqupEnvironment(envRaw)) {
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      description: "X-Quiqup-Environment must be `production` or `staging`.",
    };
  }
  const environment = envRaw;

  const key = cacheKey(bearer, environment);
  let identity = cacheGet(key);
  if (!identity && negativeHit(key)) {
    return {
      ok: false,
      status: 401,
      error: "invalid_token",
      description: "Quiqup platform-api did not accept this token.",
    };
  }
  if (!identity) {
    const fetched = await fetchIdentity(bearer, environment);
    if (fetched === "invalid") {
      negativeSet(key);
      return {
        ok: false,
        status: 401,
        error: "invalid_token",
        description: "Quiqup platform-api did not accept this token.",
      };
    }
    if (fetched === "unavailable") {
      return {
        ok: false,
        status: 503,
        error: "temporarily_unavailable",
        description: "Could not verify the token against platform-api /me. Retry shortly.",
      };
    }
    identity = fetched;
    cacheSet(key, identity);
  }

  if (identity.admin || identity.csr) {
    return {
      ok: false,
      status: 403,
      error: "forbidden",
      description:
        "Admin and CSR tokens are not accepted on /agent/mcp: agents act as exactly one " +
        "merchant. Use /mcp with a person for admin work.",
    };
  }

  const platform: AgentPlatformExtra = {
    jwt: bearer,
    environment,
    salesforceId: identity.salesforceId,
    coreUserId: identity.coreUserId,
    email: identity.email,
    agent,
  };
  return {
    ok: true,
    authInfo: {
      token: bearer,
      clientId: `agent:${agent}`,
      scopes: [],
      extra: { platform },
    },
  };
}
