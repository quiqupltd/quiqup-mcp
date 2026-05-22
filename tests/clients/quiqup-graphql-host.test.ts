/**
 * MSW-mocked Vitest suite for QuiqupGraphqlHostClient (Phase 5 / Wave 1).
 *
 * Covers the contract the client layer owns:
 *   1. Authorization header carries the Bearer JWT minted via the
 *      Clerk → Quiqup bridge. The Quiqup-GraphQL-host is NOT one of the
 *      two auth-exception clients (Audit + Google Places).
 *   2. Binary base64 envelope for non-JSON responses — `{ contentType,
 *      base64 }` with `base64` round-tripping back to the input bytes.
 *      This is the Phase 3 locked canonical shape Phase 5 PDFs reuse.
 *   3. JSON parsing on `application/json` responses — same client surface
 *      handles both shapes; the tool layer doesn't have to branch.
 *   4. null on 204 No Content responses.
 *   5. Non-2xx → QuiqupGraphqlHostError carrying status + body (distinct
 *      error class — new host family per STATE.md decision 2026-05-20
 *      03-04).
 *   6. `QUIQUP_GRAPHQL_HOST_BASE_URL` env override routes the request to
 *      the override host (WR-05 env-cleanup pattern).
 *   7. `environment: "staging"` routes to graph.staging.quiqup.com.
 *   8. Query params appended via URLSearchParams.
 *
 * WR-05 env-cleanup pattern: both `QUIQUP_GRAPHQL_HOST_BASE_URL` and
 * `QUIQUP_GRAPHQL_HOST_STAGING_BASE_URL` are deleted in beforeEach so a
 * developer with the var set in their shell does not silently route fetches
 * around MSW.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup/msw";
import {
  QuiqupGraphqlHostClient,
  QuiqupGraphqlHostError,
  QUIQUP_GRAPHQL_HOST_BASE_URLS,
  getQuiqupGraphqlHostBaseUrl,
} from "../../lib/clients/quiqup-graphql-host";

const PROD = QUIQUP_GRAPHQL_HOST_BASE_URLS.production;
const STAGING = QUIQUP_GRAPHQL_HOST_BASE_URLS.staging;

const originalProdUrl = process.env.QUIQUP_GRAPHQL_HOST_BASE_URL;
const originalStagingUrl = process.env.QUIQUP_GRAPHQL_HOST_STAGING_BASE_URL;

beforeEach(() => {
  delete process.env.QUIQUP_GRAPHQL_HOST_BASE_URL;
  delete process.env.QUIQUP_GRAPHQL_HOST_STAGING_BASE_URL;
});

afterEach(() => {
  if (originalProdUrl === undefined) {
    delete process.env.QUIQUP_GRAPHQL_HOST_BASE_URL;
  } else {
    process.env.QUIQUP_GRAPHQL_HOST_BASE_URL = originalProdUrl;
  }
  if (originalStagingUrl === undefined) {
    delete process.env.QUIQUP_GRAPHQL_HOST_STAGING_BASE_URL;
  } else {
    process.env.QUIQUP_GRAPHQL_HOST_STAGING_BASE_URL = originalStagingUrl;
  }
});

describe("QuiqupGraphqlHostClient", () => {
  it("sends Authorization: Bearer header", async () => {
    let capturedAuth: string | null = null;
    server.use(
      http.get(`${PROD}/pending_orders_labels`, ({ request }) => {
        capturedAuth = request.headers.get("authorization");
        return new HttpResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        });
      }),
    );

    const client = new QuiqupGraphqlHostClient({ jwt: "test-jwt" });
    await client.request("GET", "/pending_orders_labels");

    expect(capturedAuth).not.toBeNull();
    expect(capturedAuth as unknown as string).toMatch(/^Bearer /);
    expect(capturedAuth).toBe("Bearer test-jwt");
  });

  it("returns base64 envelope for application/pdf responses", async () => {
    // Minimal PDF magic bytes for realism.
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e]);
    server.use(
      http.get(`${PROD}/pending_orders_labels`, () =>
        new HttpResponse(pdfBytes, {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
      ),
    );

    const client = new QuiqupGraphqlHostClient({ jwt: "test-jwt" });
    const result = (await client.request("GET", "/pending_orders_labels")) as {
      contentType: string;
      base64: string;
    };

    expect(result.contentType).toContain("application/pdf");
    expect(typeof result.base64).toBe("string");
    expect(result.base64.length).toBeGreaterThan(0);
    // Round-trip: the base64 must decode back to the bytes the server sent.
    expect(
      Buffer.from(result.base64, "base64").equals(Buffer.from(pdfBytes)),
    ).toBe(true);
  });

  it("parses JSON when Content-Type is application/json", async () => {
    server.use(
      http.get(`${PROD}/pending_orders_labels`, () =>
        HttpResponse.json({ ok: true }),
      ),
    );

    const client = new QuiqupGraphqlHostClient({ jwt: "test-jwt" });
    const result = await client.request("GET", "/pending_orders_labels");
    expect(result).toEqual({ ok: true });
  });

  it("returns null on 204", async () => {
    server.use(
      http.get(`${PROD}/pending_orders_labels`, () =>
        new HttpResponse(null, { status: 204 }),
      ),
    );

    const client = new QuiqupGraphqlHostClient({ jwt: "test-jwt" });
    const result = await client.request("GET", "/pending_orders_labels");
    expect(result).toBeNull();
  });

  it("throws QuiqupGraphqlHostError on non-2xx", async () => {
    server.use(
      http.get(`${PROD}/pending_orders_labels`, () =>
        new HttpResponse("upstream blew up", { status: 502 }),
      ),
    );

    const client = new QuiqupGraphqlHostClient({ jwt: "test-jwt" });
    let thrown: unknown = null;
    try {
      await client.request("GET", "/pending_orders_labels");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(QuiqupGraphqlHostError);
    expect((thrown as QuiqupGraphqlHostError).status).toBe(502);
    expect((thrown as QuiqupGraphqlHostError).body).toContain("upstream blew up");
  });

  it("honours QUIQUP_GRAPHQL_HOST_BASE_URL env override", async () => {
    process.env.QUIQUP_GRAPHQL_HOST_BASE_URL = "https://override.test";
    expect(getQuiqupGraphqlHostBaseUrl("production")).toBe(
      "https://override.test",
    );

    let hit = false;
    server.use(
      http.get("https://override.test/pending_orders_labels", () => {
        hit = true;
        return HttpResponse.json({ ok: true });
      }),
    );

    const client = new QuiqupGraphqlHostClient({ jwt: "test-jwt" });
    const result = await client.request("GET", "/pending_orders_labels");
    expect(hit).toBe(true);
    expect(result).toEqual({ ok: true });
  });

  it("environment: staging routes to staging cluster", async () => {
    let capturedUrl: string | null = null;
    server.use(
      http.get(`${STAGING}/pending_orders_labels`, ({ request }) => {
        capturedUrl = request.url;
        return new HttpResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        });
      }),
    );

    const client = new QuiqupGraphqlHostClient({
      jwt: "test-jwt",
      environment: "staging",
    });
    await client.request("GET", "/pending_orders_labels");

    expect(capturedUrl).not.toBeNull();
    expect(capturedUrl as unknown as string).toContain(
      "graph.staging.quiqup.com",
    );
  });

  it("appends query params via URLSearchParams", async () => {
    let capturedUrl: string | null = null;
    server.use(
      http.get(`${PROD}/pending_orders_labels`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ ok: true });
      }),
    );

    const client = new QuiqupGraphqlHostClient({ jwt: "test-jwt" });
    await client.request("GET", "/pending_orders_labels", {
      query: { foo: "bar", n: 1 },
    });

    expect(capturedUrl).not.toBeNull();
    const u = new URL(capturedUrl as unknown as string);
    expect(u.searchParams.get("foo")).toBe("bar");
    expect(u.searchParams.get("n")).toBe("1");
  });
});
