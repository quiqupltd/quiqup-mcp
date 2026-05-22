/**
 * Typed client for the Quiqup-GraphQL-host REST surface at
 * graph.quiqup.com (production) and graph.staging.quiqup.com (staging).
 *
 * Service host: docs/quiqup-api-full-frontend-extract.md §1 line 20 names
 * the FE env-var family as `VITE_QUIQUP_GRAPHQL_BASE_URL` and line 39
 * names the production and staging URLs. This is a STANDALONE host with no
 * fallback aliasing to other env vars. Server-side overrides are
 * `QUIQUP_GRAPHQL_HOST_BASE_URL` (production) and
 * `QUIQUP_GRAPHQL_HOST_STAGING_BASE_URL` (staging) — deliberately distinct
 * from `QUIQUP_ORDERS_GRAPH_URL` (the Orders Core GraphQL var from 03-01)
 * so a maintainer cannot confuse the two hosts.
 *
 * Naming-vs-protocol clarification: the host is named "Quiqup GraphQL"
 * historically (per the FE env-var family prefix), but the endpoints
 * exposed here are REST-shaped GET requests — `GET /pending_orders_labels`,
 * `GET /return_order_label/{orderId}`, `GET /order_label/{order_ids}` — all
 * returning PDF responses. This client wraps that REST surface. Do NOT
 * confuse with `lib/clients/orders-core-graphql.ts` (true GraphQL POSTs
 * against a DIFFERENT host `orders-api.quiqup.com/graph`).
 *
 * Auth model: V3b same-IdP exchange — IDENTICAL to quiqup-lastmile.ts,
 * quiqup-rest.ts, orders-core-rest.ts, and ex-core.ts. The handler resolves
 * the user's Clerk session JWT via getQuiqupReadyJwt and forwards it as
 * `Authorization: Bearer <jwt>`. This is NOT an auth-exception client (the
 * only two auth exceptions remain Audit and Google Places per the STATE.md
 * auth-isolation invariant).
 *
 * Error model: introduces a NEW error class `QuiqupGraphqlHostError`
 * mirroring `ExCoreError` (status + body + name). Per STATE.md decision
 * 2026-05-20 03-04: "New service-host families get their own error class".
 * Sibling clients of an existing host family reuse the existing class; this
 * is a NEW host family, so it gets its own class.
 *
 * Binary handling: the host returns PDF bodies on all three documented
 * endpoints. The client inspects `Content-Type` and returns the canonical
 * envelope `{ contentType, base64 }` for non-JSON responses (mirroring the
 * QuiqupLastmileClient / ExCoreClient binary branch verbatim). Tools layer
 * the `filenameHint` on top — preserves the Phase 3 locked wire shape so
 * Phase 7 (inventory CSV) and Phase 10 (Zoho PDFs) can reuse it.
 */

import { type HttpMethod } from "./quiqup-lastmile";
import { type QuiqupEnvironment } from "./quiqup-env";

/** Canonical Quiqup-GraphQL-host base URLs by environment. */
export const QUIQUP_GRAPHQL_HOST_BASE_URLS = {
  production: "https://graph.quiqup.com",
  staging: "https://graph.staging.quiqup.com",
} as const;

/**
 * Env-var-overridable base-URL resolver. Per-environment overrides:
 *   - staging:    process.env.QUIQUP_GRAPHQL_HOST_STAGING_BASE_URL.
 *   - production: process.env.QUIQUP_GRAPHQL_HOST_BASE_URL.
 *
 * These names are deliberately distinct from `QUIQUP_ORDERS_GRAPH_URL`
 * (the Orders Core GraphQL var from 03-01) so a maintainer cannot confuse
 * the two hosts. No fallback to other env vars — this is a standalone host
 * with no FE-side aliasing (source-doc §1 line 20 names
 * `VITE_QUIQUP_GRAPHQL_BASE_URL` as a standalone family).
 *
 * Overrides exist for test/dev hooks (MSW binds to the override host when
 * set) and take precedence over the canonical URLs. Setting prod does NOT
 * affect staging and vice-versa.
 */
export function getQuiqupGraphqlHostBaseUrl(
  env: QuiqupEnvironment = "production",
): string {
  if (env === "staging") {
    return (
      process.env.QUIQUP_GRAPHQL_HOST_STAGING_BASE_URL ??
      QUIQUP_GRAPHQL_HOST_BASE_URLS.staging
    );
  }
  return (
    process.env.QUIQUP_GRAPHQL_HOST_BASE_URL ??
    QUIQUP_GRAPHQL_HOST_BASE_URLS.production
  );
}

/**
 * Distinct error class for Quiqup-GraphQL-host upstream failures. Mirrors
 * ExCoreError's shape (status + body) so callers can branch on `err.status`
 * identically. Per STATE.md decision 2026-05-20 03-04: this is a NEW host
 * family, so it gets its own error class rather than reusing QuiqupHttpError.
 */
export class QuiqupGraphqlHostError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Quiqup GraphQL host ${status}`);
    this.name = "QuiqupGraphqlHostError";
  }
}

export interface QuiqupGraphqlHostClientOptions {
  jwt: string;
  /** Explicit base URL override (e.g. for tests). Wins over `environment`. */
  baseUrl?: string;
  /** Selects the cluster when `baseUrl` is not provided. Defaults to production. */
  environment?: QuiqupEnvironment;
}

/** Canonical binary envelope shape returned for non-JSON responses. */
export interface QuiqupGraphqlHostBinaryEnvelope {
  contentType: string;
  base64: string;
}

export class QuiqupGraphqlHostClient {
  constructor(private readonly opts: QuiqupGraphqlHostClientOptions) {}

  /**
   * Generic request — supports both JSON and binary responses.
   *
   * Wire shape: `${method} ${baseUrl}${path}?<query>`.
   * Headers: `Authorization: Bearer <jwt>`, `Accept: *<slash>*` (so the
   * upstream can return application/pdf on `/pending_orders_labels` without
   * us forcing JSON — forcing Accept: application/json would 406 the PDF
   * path).
   *
   * Return contract:
   *   - HTTP non-2xx → throws QuiqupGraphqlHostError(status, body).
   *   - HTTP 204     → returns null.
   *   - HTTP 200 with `application/json` content-type → parsed JSON.
   *   - HTTP 200 otherwise → `{ contentType, base64 }` envelope (canonical
   *     Phase 3 binary shape; tool layer adds filenameHint on top).
   */
  async request(
    method: HttpMethod,
    path: string,
    init: {
      query?: Record<string, string | number | boolean | undefined>;
    } = {},
  ): Promise<unknown> {
    const base =
      this.opts.baseUrl ??
      getQuiqupGraphqlHostBaseUrl(this.opts.environment);
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
        // Accept */* — the upstream returns application/pdf on all three
        // documented endpoints. Forcing Accept: application/json would
        // make the upstream 406 on the PDF path.
        Accept: "*/*",
      },
    });

    if (!res.ok) {
      throw new QuiqupGraphqlHostError(res.status, await res.text());
    }

    if (res.status === 204) {
      return null;
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return res.json();
    }

    // Binary / non-JSON path: return the canonical base64 envelope. The
    // tool layer adds filenameHint on top (mirrors ExCoreClient binary
    // branch verbatim — same shape so Phase 5/7/10 can reuse the contract).
    const buf = await res.arrayBuffer();
    return {
      contentType,
      base64: Buffer.from(buf).toString("base64"),
    } satisfies QuiqupGraphqlHostBinaryEnvelope;
  }
}
