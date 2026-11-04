/**
 * Typed client for the Ex-core (legacy Ruby `ex-core`) API at
 * ex-api.quiqup.com (production) and ex-api.staging.quiqup.com (staging).
 *
 * Service host: docs/quiqup-api-full-frontend-extract.md §1 line 18 names
 * Ex-core as a DISTINCT egress host with the FE env-var family
 * `VITE_EX_API_BASE_URL` / `VITE_EX_API_STAGING_BASE_URL`. On the server
 * the canonical override is `QUIQUP_EX_API_BASE_URL` (matching .env.example
 * and the pre-existing update-order-waypoint tool); the newer
 * `EX_API_BASE_URL` is accepted as an alias for symmetry with the staging
 * variable `EX_API_STAGING_BASE_URL`.
 *
 * Auth model: V3b same-IdP exchange — IDENTICAL to quiqup-lastmile.ts,
 * quiqup-fulfilment.ts, and orders-core-graphql.ts. The handler resolves
 * the user's Clerk session JWT via getQuiqupReadyJwt and forwards it as
 * the bearer token. Ex-core sits behind the SAME Quiqup gateway as the
 * other Quiqup services — this is NOT an auth-exception client (the only
 * auth exception in this project is Google Places).
 *
 * Error model: HTTP non-2xx maps to ExCoreError carrying status + raw
 * body. Separate error class from QuiqupHttpError because Ex-core is a
 * distinct service host with a separate operational backstop on the
 * Quiqup side, even though the auth bridge is shared. The registerTool
 * wrapper unwraps QuiqupHttpError specifically; ExCoreError surfaces as
 * a plain handler exception (acceptable — the tool layer wraps the
 * outcome in its own text content block).
 *
 * Binary-response contract: Ex-core's `GET /orders/download` endpoint
 * returns text/csv (and may return PDF / other binary in future). On a
 * 200 the client inspects `Content-Type`:
 *   - includes `application/json` → return parsed JSON.
 *   - otherwise → return the canonical binary envelope
 *     `{ contentType, base64 }`. The tool layer is responsible for
 *     adding `filenameHint`.
 * This MIRRORS the QuiqupLastmileClient binary branch — same shape so
 * downstream phases (5 PDF labels, 7 CSV inventory, 10 Zoho PDFs) can
 * reuse the contract verbatim.
 *
 * Method shape: a single generic `request(method, path, init?)`. Bracket-
 * style query keys (e.g. `filters[order_id]`) are handled by passing them
 * through `URLSearchParams.set`, which percent-encodes the brackets
 * exactly as the upstream expects.
 */

import {
  type HttpMethod,
} from "./quiqup-lastmile";
import { type QuiqupEnvironment } from "./quiqup-env";

/** Canonical Ex-core base URLs by environment. */
export const EX_CORE_BASE_URLS = {
  production: "https://ex-api.quiqup.com",
  staging: "https://ex-api.staging.quiqup.com",
} as const;

/**
 * Env-var-overridable base-URL resolver. Per-environment overrides:
 *   - staging: process.env.EX_API_STAGING_BASE_URL.
 *   - production: process.env.QUIQUP_EX_API_BASE_URL (canonical, also used
 *     by lib/tools/update-order-waypoint.ts and .env.example) OR the
 *     newer process.env.EX_API_BASE_URL alias for symmetry with the
 *     staging variable.
 * Overrides exist for test/dev hooks (MSW binds to the override host when
 * set) and take precedence over the canonical URLs. Setting prod does NOT
 * affect staging and vice-versa.
 */
export function getExCoreBaseUrl(env: QuiqupEnvironment = "production"): string {
  if (env === "staging") {
    return (
      process.env.EX_API_STAGING_BASE_URL ?? EX_CORE_BASE_URLS.staging
    );
  }
  return (
    process.env.QUIQUP_EX_API_BASE_URL ??
    process.env.EX_API_BASE_URL ??
    EX_CORE_BASE_URLS.production
  );
}

/**
 * Distinct error class for Ex-core upstream failures. Mirrors
 * QuiqupHttpError's shape (status + body) so callers can branch on
 * `err.status` identically.
 */
export class ExCoreError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Ex-core ${status}`);
    this.name = "ExCoreError";
  }
}

export interface ExCoreClientOptions {
  jwt: string;
  /** Explicit base URL override (e.g. for tests). Wins over `environment`. */
  baseUrl?: string;
  /** Selects the cluster when `baseUrl` is not provided. Defaults to production. */
  environment?: QuiqupEnvironment;
}

/** Canonical binary envelope shape returned for non-JSON responses. */
export interface ExCoreBinaryEnvelope {
  contentType: string;
  base64: string;
}

export class ExCoreClient {
  constructor(private readonly opts: ExCoreClientOptions) {}

  /**
   * Generic request — supports both JSON and binary responses.
   *
   * Wire shape: `${method} ${baseUrl}${path}?<query>`.
   * Headers: `Authorization: Bearer <jwt>`, `Accept: *<slash>*` (so the
   * upstream can return text/csv on `/orders/download` without us forcing
   * JSON).
   *
   * Return contract:
   *   - HTTP non-2xx → throws ExCoreError(status, body).
   *   - HTTP 200 with `application/json` content-type → parsed JSON.
   *   - HTTP 200 otherwise → `{ contentType, base64 }` envelope.
   */
  async request(
    method: HttpMethod,
    path: string,
    init: { query?: Record<string, string | number | undefined> } = {},
  ): Promise<unknown> {
    const base = this.opts.baseUrl ?? getExCoreBaseUrl(this.opts.environment);
    const url = new URL(`${base}${path}`);
    if (init.query) {
      for (const [k, v] of Object.entries(init.query)) {
        // URLSearchParams.set percent-encodes bracket-style keys like
        // `filters[order_id]` to `filters%5Border_id%5D` — exactly the
        // form Ex-core's Rails router expects.
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.jwt}`,
        // Accept */* — Ex-core returns text/csv on /orders/download, not
        // application/json. Forcing Accept: application/json would make
        // the upstream 406 on the CSV path.
        Accept: "*/*",
      },
    });
    if (!res.ok) {
      throw new ExCoreError(res.status, await res.text());
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return res.json();
    }
    // Binary / non-JSON path: return the canonical base64 envelope. The
    // tool layer adds filenameHint on top.
    const buf = await res.arrayBuffer();
    return {
      contentType,
      base64: Buffer.from(buf).toString("base64"),
    } satisfies ExCoreBinaryEnvelope;
  }
}
