/**
 * Typed client for the Quiqup REST public-API surface at
 * api.quiqup.com (production) / api.staging.quiqup.com (staging).
 *
 * Service-host distinctness: this is the THIRD Quiqup egress host in the
 * project, distinct from Last-Mile and Fulfilment:
 *   - `api-ae.quiqup.com`           → Last-Mile REST (UAE-cluster fulfilment
 *                                     surface — `quiqup-lastmile.ts`).
 *   - `platform-api.quiqup.com`     → Platform / Fulfilment / account /
 *                                     reference data (`quiqup-fulfilment.ts`).
 *   - `api.quiqup.com`              → THIS module. The "public Quiqup REST"
 *                                     surface fronting endpoints typed in
 *                                     the Quiqdash frontend's
 *                                     `app/lib/orders.ts` — e.g.
 *                                     `/orders/{id}/history`,
 *                                     `/orders/export/{id}`,
 *                                     `/orders/partner-cancellation-reasons`.
 * The hosts are NOT interchangeable: the gateways route to different BE
 * services. Tools that need this surface MUST import from this module;
 * do not redirect a different client by overriding its baseUrl.
 *
 * Auth model: V3b same-IdP exchange — IDENTICAL to quiqup-lastmile.ts and
 * quiqup-fulfilment.ts. The handler resolves the user's Clerk session
 * JWT via `getQuiqupReadyJwt` and forwards it as the Bearer token. No
 * Quiqup-side partner secret is stored on this server. This is NOT an
 * auth-exception client — `lib/clients/google-places.ts` is where the
 * no-Bearer pattern lives.
 *
 * Error model: HTTP non-2xx maps to `QuiqupHttpError` (imported from
 * `quiqup-lastmile.ts`) carrying status + raw body. The single shared
 * error type lets the `registerTool` wrapper produce the same MCP
 * `isError: true` envelope regardless of which Quiqup host the failure
 * came from. Each outbound `fetch()` is bounded by a 25s
 * `AbortSignal.timeout(25_000)` so a stalled upstream surfaces as a
 * labelled `TimeoutError` (agent-actionable) instead of an opaque
 * `fetch failed`; 25s sits below the route-level `maxDuration = 60`
 * declared in `app/[transport]/route.ts`.
 *
 * Response shape: JSON content-type returns the parsed JSON body;
 * non-JSON content-types (CSV / PDF — e.g. `/orders/export/{id}` will
 * use this when wired in a later wave) return a `{ contentType, base64 }`
 * envelope to keep the wire path symmetric with the other Quiqup REST
 * clients. The 204 No Content path returns `null`.
 */

import { QuiqupHttpError } from "./quiqup-lastmile";
import type { QuiqupEnvironment } from "./quiqup-env";

/**
 * Canonical Quiqup REST host URLs. Env-var overrides (QUIQUP_REST_BASE_URL /
 * QUIQUP_REST_STAGING_BASE_URL) take precedence — see `getQuiqupRestBaseUrl`.
 */
export const QUIQUP_REST_BASE_URLS = {
  production: "https://api.quiqup.com",
  staging: "https://api.staging.quiqup.com",
} as const;

/**
 * Env-var-overridable base-URL resolver. Mirrors the prod/staging
 * convention used by `getLastmileBaseUrl` / `getPlatformApiBaseUrl`.
 * Overrides are per-environment: setting prod does not affect staging,
 * and vice-versa.
 */
export function getQuiqupRestBaseUrl(
  env: QuiqupEnvironment = "production",
): string {
  if (env === "staging") {
    return (
      process.env.QUIQUP_REST_STAGING_BASE_URL ?? QUIQUP_REST_BASE_URLS.staging
    );
  }
  return (
    process.env.QUIQUP_REST_BASE_URL ?? QUIQUP_REST_BASE_URLS.production
  );
}

export interface QuiqupRestClientOptions {
  jwt: string;
  /** Explicit base URL override (e.g. for tests). Wins over `environment`. */
  baseUrl?: string;
  /** Selects the cluster when `baseUrl` is not provided. Defaults to production. */
  environment?: QuiqupEnvironment;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export class QuiqupRestClient {
  constructor(private readonly opts: QuiqupRestClientOptions) {}

  /**
   * Generic typed-pass-through. Body is JSON-serialised when present;
   * query is appended as `?key=value` via URLSearchParams (undefined
   * values are skipped so callers can spread partial maps).
   *
   * Headers:
   *   - Authorization: Bearer <jwt>
   *   - Accept: application/json
   *   - Content-Type: application/json (only when body is present)
   *
   * Mirrors `QuiqupLastmileClient.request` line-for-line, including the
   * JSON-vs-binary content-type branch for future CSV/PDF endpoints on
   * this host.
   */
  async request(
    method: HttpMethod,
    path: string,
    init: { body?: unknown; query?: Record<string, string | number | undefined> } = {},
  ): Promise<unknown> {
    const base = this.opts.baseUrl ?? getQuiqupRestBaseUrl(this.opts.environment);
    const url = new URL(`${base}${path}`);
    if (init.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.jwt}`,
        Accept: "application/json",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) {
      throw new QuiqupHttpError(res.status, await res.text());
    }
    if (res.status === 204) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return res.json();
    }
    // Binary or other non-JSON (e.g. CSV/PDF on /orders/export/{id}): return base64.
    const buf = await res.arrayBuffer();
    return {
      contentType,
      base64: Buffer.from(buf).toString("base64"),
    };
  }
}
