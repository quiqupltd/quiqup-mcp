/**
 * Typed client for the Quiqup Platform API host
 * (platform-api.quiqup.com / platform-api.staging.quiqup.com).
 *
 * Service-host distinctness: this is the helper for the SECOND Quiqup
 * egress host — distinct from Last-Mile (`api-ae.quiqup.com`),
 * Ex-core (`ex-api.quiqup.com`), and the public REST host
 * (`api.quiqup.com`).  Platform API fronts the Quiqdash frontend's
 * "platform / fulfilment / account / reference data" surface — e.g.
 * `/quiqdash/orders/find_by_id_or_barcode`, `/quiqdash/depots`,
 * `/quiqdash/missions`, and account/whoami endpoints.
 *
 * Why this helper exists (03-REVIEW WR-01):
 *   Phase 1 and Phase 2 reviews both flagged the absence of this helper
 *   (WR-07 / WR-01) — every new Platform-API tool was re-deriving the
 *   same six-step ritual inline:
 *     1. getPlatformApiBaseUrl(env)
 *     2. new URL(`${base}${path}`)
 *     3. new URLSearchParams({...})
 *     4. url.search = params.toString()
 *     5. fetch(url, { Authorization: `Bearer ${jwt}`, Accept: "application/json" })
 *     6. if (!res.ok) throw new QuiqupHttpError(res.status, await res.text())
 *   Phase 3 added three more such sites (`find_order_by_id_or_barcode`,
 *   `list_depots`, `list_missions_filter`), bringing the total inline-fetch
 *   count in `lib/tools/` past 50. Each new tool re-paid the same tax:
 *   one typo away from a missing Authorization header, one typo away
 *   from a missed QuiqupHttpError mapping. This helper is the chokepoint
 *   so Phase 4+ tools stop accumulating the deficit. The 03-REVIEW
 *   guidance was explicit: land the helper + migrate the 3 Phase-3 sites,
 *   leave the other ~50 to migrate opportunistically.
 *
 * Auth model: V3b same-IdP exchange — IDENTICAL to quiqup-rest.ts,
 * quiqup-lastmile.ts, quiqup-fulfilment.ts, orders-core-graphql.ts. The
 * caller supplies a session JWT (typically via `getQuiqupReadyJwt`) and
 * the client forwards it as Bearer. NOT an auth-exception client
 * (`lib/clients/audit.ts` and the deprecated `google-places.ts` are the
 * documented exceptions to the Bearer-on-every-egress rule).
 *
 * Error model: HTTP non-2xx maps to `QuiqupHttpError` (imported from
 * `quiqup-lastmile.ts`) carrying status + raw body. The single shared
 * error type lets the `registerTool` wrapper produce the same MCP
 * `isError: true` envelope regardless of which Quiqup host the failure
 * came from. Tools using this client MUST NOT swallow QuiqupHttpError;
 * letting it propagate is what activates the unified error-mapping path
 * in `registerTool`.
 *
 * Response shape: JSON content-type returns the parsed JSON body;
 * non-JSON content-types return a `{ contentType, base64 }` envelope
 * (mirrors `quiqup-rest.ts:124-135` verbatim for symmetry — no Platform
 * API endpoint is known to return non-JSON today, but the branch is
 * here for free). The 204 No Content path returns `null`.
 *
 * Env-var override: `QUIQUP_PLATFORM_API_BASE_URL` /
 * `QUIQUP_PLATFORM_API_STAGING_BASE_URL` are honored by
 * `getPlatformApiBaseUrl` — this client picks up those overrides via
 * the same env resolver, so MSW-mocked tests continue to work without
 * special handling.
 */

import { QuiqupHttpError } from "./quiqup-lastmile";
import {
  getPlatformApiBaseUrl,
  type QuiqupEnvironment,
} from "./quiqup-env";
import { fetchMultipart } from "./_multipart";

export interface PlatformApiClientOptions {
  jwt: string;
  /** Explicit base URL override (e.g. for tests). Wins over `environment`. */
  baseUrl?: string;
  /** Selects the cluster when `baseUrl` is not provided. Defaults to production. */
  environment?: QuiqupEnvironment;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export class PlatformApiClient {
  constructor(private readonly opts: PlatformApiClientOptions) {}

  /**
   * Generic typed pass-through. Mirrors `QuiqupRestClient.request`
   * line-for-line so a maintainer reading either helper sees the same
   * shape. Body is JSON-serialised when present; query is appended via
   * URLSearchParams (undefined values are skipped so callers can spread
   * partial maps).
   *
   * Headers (in spread order — later keys win on collision):
   *   (1) Authorization: Bearer <jwt>
   *   (2) Accept: application/json
   *   (3) Content-Type: application/json (only when body is present)
   *   (4) Optional `extraHeaders` are spread LAST and therefore override
   *       defaults — used by Phase-5 `download_slip` (api-version: 20180108 +
   *       Accept: application/pdf) and reserved for Phase-8
   *       `list_carrier_capabilities` (x-api-version: 20240101).
   *
   * The `extraHeaders` parameter is optional — when absent (the default for
   * every Phase 1-4 caller) the method behaves identically to its
   * pre-Phase-5 form.
   *
   * FOOTGUN: a caller passing `extraHeaders: { Authorization: "..." }` WOULD
   * override the Bearer token because Authorization is added at position (1)
   * and extraHeaders spread at position (4). This tool does NOT pass an
   * Authorization key in extraHeaders; future callers MUST NOT either.
   * (T-05-16)
   *
   * The JSON-vs-binary content-type branch is preserved verbatim from
   * `quiqup-rest.ts:124-135` per the 03-REVIEW WR-01 fix guidance.
   */
  async request(
    method: HttpMethod,
    path: string,
    init: {
      body?: unknown;
      query?: Record<string, string | number | boolean | undefined>;
      extraHeaders?: Record<string, string>;
    } = {},
  ): Promise<unknown> {
    const base =
      this.opts.baseUrl ?? getPlatformApiBaseUrl(this.opts.environment);
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
        ...(init.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        ...(init.extraHeaders ?? {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) {
      throw new QuiqupHttpError(res.status, await res.text());
    }
    if (res.status === 204) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return res.json();
    }
    // Binary or other non-JSON: return base64. Mirrors quiqup-rest.ts
    // verbatim — no Platform API endpoint is known to use this branch
    // today, but the symmetry keeps the helpers interchangeable.
    const buf = await res.arrayBuffer();
    return {
      contentType,
      base64: Buffer.from(buf).toString("base64"),
    };
  }

  /**
   * Multipart POST/PUT against the Platform host. Used by
   * `bulk_create_orders` (ORDC-05 — POST /quiqdash/bulk_orders) and any
   * future Platform multipart consumer (Phase 6 bulk-validate /
   * bulk-commit product CSVs land here).
   *
   * CRITICAL: this method does NOT set `Content-Type`. The runtime sets
   * `multipart/form-data; boundary=...` from the FormData body. Manually
   * overriding clobbers the boundary and the upstream rejects the body.
   * The canonical 03-04 lockup — re-tested at every call site AND
   * grep-gated at the per-tool source level.
   *
   * Behavior delegates to `lib/clients/_multipart.ts::fetchMultipart`
   * (hoisted by 04-04 Task 2). This method is a host-aware wrapper that
   * resolves the Platform base URL from `opts.environment` and forwards
   * the JWT.
   */
  async requestMultipart(
    method: HttpMethod,
    path: string,
    formData: FormData,
  ): Promise<unknown> {
    const base =
      this.opts.baseUrl ?? getPlatformApiBaseUrl(this.opts.environment);
    const url = `${base}${path}`;
    return fetchMultipart(method, url, this.opts.jwt, formData);
  }
}
