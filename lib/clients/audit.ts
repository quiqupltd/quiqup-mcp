/**
 * Typed client for the Quiqup Audit service at audit.quiqup.com.
 *
 * Auth model: V3b same-IdP exchange, IDENTICAL to quiqup-lastmile.ts and
 * ex-core.ts. The handler resolves the caller's Clerk session JWT (the
 * "default" template) via `getQuiqupReadyJwt` and this client forwards it as
 * `Authorization: Bearer <jwt>`.
 *
 * This client used to send NO Authorization header, on the belief that Audit
 * was "public read or service-internal" and "does not speak Clerk
 * session-JWTs". Both were wrong: Audit verifies the same Clerk tokens as
 * Quiqdash (clerk.quiqup.com), and from sc-30350 it requires them on every
 * read, scoping merchants to their own account's events and showing Quiqup
 * staff everything. A request without a valid token gets a 401, so do NOT
 * remove the header. The only remaining auth exception in this project is
 * google-places.ts.
 *
 * Error model: HTTP non-2xx maps to `AuditError` (status + raw body). A
 * separate error class — not `QuiqupHttpError` — because Audit is not a
 * Quiqup-prefixed service in our internal nomenclature, and conflating
 * their error contracts would muddle which tool emitted what. Tools that
 * want the unified `isError: true` envelope from the registerTool wrapper
 * can translate AuditError → QuiqupHttpError at the tool boundary (the
 * google-places.ts → lookup-google-place.ts handoff is the precedent).
 * 401 = the token is missing or invalid; 403 = the user is neither Quiqup
 * staff nor linked to an account.
 *
 * Endpoint shape (per source-doc §19 B lines 4258-4263):
 *   GET {AUDIT_BASE_URL}/events?resourceID.eq=<orderUuid>
 *     → { events: [{ eventID, resourceID, occurredAt, actor, action, changes }] }
 */

import type { QuiqupEnvironment } from "./quiqup-env";

/**
 * Canonical Audit service host URLs. Env-var overrides
 * (`AUDIT_BASE_URL` / `AUDIT_STAGING_BASE_URL`) take precedence —
 * see `getAuditBaseUrl`.
 */
export const AUDIT_BASE_URLS = {
  production: "https://audit.quiqup.com",
  staging: "https://audit.staging.quiqup.com",
} as const;

/**
 * Env-var-overridable base-URL resolver. Mirrors the prod/staging
 * convention used by `getLastmileBaseUrl` / `getPlatformApiBaseUrl` /
 * `getQuiqupRestBaseUrl`. Overrides are per-environment: setting prod
 * does not affect staging, and vice-versa.
 */
export function getAuditBaseUrl(
  env: QuiqupEnvironment = "production",
): string {
  if (env === "staging") {
    return (
      process.env.AUDIT_STAGING_BASE_URL ?? AUDIT_BASE_URLS.staging
    );
  }
  return process.env.AUDIT_BASE_URL ?? AUDIT_BASE_URLS.production;
}

export class AuditError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Audit ${status}`);
    this.name = "AuditError";
  }
}

export interface AuditClientOptions {
  /** Caller's Clerk session JWT (from `getQuiqupReadyJwt`), forwarded as the Bearer token. */
  jwt: string;
  /** Explicit base URL override (e.g. for tests). Wins over `environment`. */
  baseUrl?: string;
  /** Selects the cluster when `baseUrl` is not provided. Defaults to production. */
  environment?: QuiqupEnvironment;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface AuditRequestInit {
  query?: Record<string, string | number | undefined>;
}

export class AuditClient {
  constructor(private readonly opts: AuditClientOptions) {}

  /**
   * Issue a request against the Audit service. Query parameters are
   * appended via URLSearchParams — dotted keys (e.g. `resourceID.eq`)
   * round-trip intact, which is critical for the documented
   * resourceID.eq=<uuid> filter shape.
   *
   * Headers sent:
   *   - Accept: application/json
   *   - Authorization: Bearer <caller's Clerk session JWT>
   */
  async request(
    method: HttpMethod,
    path: string,
    init: AuditRequestInit = {},
  ): Promise<unknown> {
    const base = this.opts.baseUrl ?? getAuditBaseUrl(this.opts.environment);
    const url = new URL(`${base}${path}`);
    if (init.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const res = await fetch(url.toString(), {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.opts.jwt}`,
      },
    });

    if (!res.ok) {
      throw new AuditError(res.status, await res.text());
    }
    if (res.status === 204) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return res.json();
    }
    return res.text();
  }
}
