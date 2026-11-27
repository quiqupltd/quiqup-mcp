/**
 * MSW-mocked Vitest suite for ExCoreClient (Phase 3 / Wave 4).
 *
 * Covers the contract the client layer owns:
 *   1. Authorization header carries the Bearer JWT minted via the
 *      Clerk → Quiqup bridge. Ex-core sits behind the Quiqup gateway —
 *      it is NOT the auth-exception client (that is Google Places).
 *   2. Binary base64 envelope for non-JSON responses — `{ contentType,
 *      base64 }` with `base64` round-tripping back to the input bytes.
 *      This is the canonical shape Phase 5 (PDFs), 7 (CSV), 10 (Zoho)
 *      will reuse.
 *   3. JSON parsing on `application/json` responses — same client surface
 *      handles both shapes; the tool layer doesn't have to branch.
 *   4. Non-2xx → ExCoreError carrying status + body (distinct error class
 *      from QuiqupHttpError because Ex-core is a separate operational
 *      backstop, even though the auth bridge is shared).
 *   5. `EX_API_BASE_URL` env override routes the request to the override
 *      host — matches the FE's VITE_EX_API_BASE_URL convention.
 *   6. Bracket-style query keys (`filters[order_id]`) percent-encode to
 *      `filters%5Border_id%5D` deterministically via URLSearchParams.set.
 *
 * WR-05 env-cleanup pattern: `EX_API_BASE_URL` and
 * `EX_API_STAGING_BASE_URL` are deleted in beforeEach so a developer with
 * the var set in their shell does not silently route fetches around MSW.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup/msw";
import {
  ExCoreClient,
  ExCoreError,
  EX_CORE_BASE_URLS,
  getExCoreBaseUrl,
} from "../../lib/clients/ex-core";

const PROD = EX_CORE_BASE_URLS.production;

const originalProdUrl = process.env.EX_API_BASE_URL;
const originalCanonicalProdUrl = process.env.QUIQUP_EX_API_BASE_URL;
const originalStagingUrl = process.env.EX_API_STAGING_BASE_URL;

beforeEach(() => {
  delete process.env.EX_API_BASE_URL;
  delete process.env.QUIQUP_EX_API_BASE_URL;
  delete process.env.EX_API_STAGING_BASE_URL;
});

afterEach(() => {
  if (originalCanonicalProdUrl === undefined) {
    delete process.env.QUIQUP_EX_API_BASE_URL;
  } else {
    process.env.QUIQUP_EX_API_BASE_URL = originalCanonicalProdUrl;
  }
  if (originalProdUrl === undefined) {
    delete process.env.EX_API_BASE_URL;
  } else {
    process.env.EX_API_BASE_URL = originalProdUrl;
  }
  if (originalStagingUrl === undefined) {
    delete process.env.EX_API_STAGING_BASE_URL;
  } else {
    process.env.EX_API_STAGING_BASE_URL = originalStagingUrl;
  }
});

describe("ExCoreClient", () => {
  it("sends Authorization: Bearer header", async () => {
    let capturedAuth: string | null = null;
    server.use(
      http.get(`${PROD}/orders/download`, ({ request }) => {
        capturedAuth = request.headers.get("authorization");
        return new HttpResponse("a,b\n1,2\n", {
          status: 200,
          headers: { "Content-Type": "text/csv" },
        });
      }),
    );

    const client = new ExCoreClient({ jwt: "test-jwt" });
    await client.request("GET", "/orders/download");

    expect(capturedAuth).not.toBeNull();
    expect(capturedAuth as unknown as string).toMatch(/^Bearer /);
    expect(capturedAuth).toBe("Bearer test-jwt");
  });

  it("returns base64 envelope for text/csv responses", async () => {
    const csvBytes = "order_id,state\n42,delivered\n";
    server.use(
      http.get(`${PROD}/orders/download`, () =>
        new HttpResponse(csvBytes, {
          status: 200,
          headers: { "Content-Type": "text/csv" },
        }),
      ),
    );

    const client = new ExCoreClient({ jwt: "test-jwt" });
    const result = (await client.request("GET", "/orders/download")) as {
      contentType: string;
      base64: string;
    };

    expect(result.contentType).toContain("text/csv");
    expect(typeof result.base64).toBe("string");
    expect(result.base64.length).toBeGreaterThan(0);
    // Round-trip: the base64 must decode back to the bytes the server sent.
    expect(Buffer.from(result.base64, "base64").toString("utf-8")).toBe(
      csvBytes,
    );
    // And re-encoding the original bytes should produce the same base64
    // (canonical contract for downstream Phase 5/7/10 reuse).
    expect(Buffer.from(csvBytes, "utf-8").toString("base64")).toBe(
      result.base64,
    );
  });

  it("parses JSON when Content-Type is application/json", async () => {
    server.use(
      http.get(`${PROD}/orders/download`, () =>
        HttpResponse.json({ ok: true, count: 3 }),
      ),
    );

    const client = new ExCoreClient({ jwt: "test-jwt" });
    const result = await client.request("GET", "/orders/download");
    expect(result).toEqual({ ok: true, count: 3 });
  });

  it("throws ExCoreError on non-2xx", async () => {
    server.use(
      http.get(`${PROD}/orders/download`, () =>
        new HttpResponse("upstream blew up", { status: 502 }),
      ),
    );

    const client = new ExCoreClient({ jwt: "test-jwt" });
    let thrown: unknown = null;
    try {
      await client.request("GET", "/orders/download");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ExCoreError);
    expect((thrown as ExCoreError).status).toBe(502);
    expect((thrown as ExCoreError).body).toContain("upstream blew up");
  });

  it("honours EX_API_BASE_URL env override", async () => {
    process.env.EX_API_BASE_URL = "https://localhost.test";
    expect(getExCoreBaseUrl("production")).toBe("https://localhost.test");

    let hit = false;
    server.use(
      http.get("https://localhost.test/orders/download", () => {
        hit = true;
        return HttpResponse.json({ ok: true });
      }),
    );

    const client = new ExCoreClient({ jwt: "test-jwt" });
    const result = await client.request("GET", "/orders/download");
    expect(hit).toBe(true);
    expect(result).toEqual({ ok: true });
  });

  it("honours QUIQUP_EX_API_BASE_URL (canonical) env override", () => {
    process.env.QUIQUP_EX_API_BASE_URL = "https://canonical.test";
    expect(getExCoreBaseUrl("production")).toBe("https://canonical.test");
  });

  it("QUIQUP_EX_API_BASE_URL takes precedence over EX_API_BASE_URL alias", () => {
    process.env.QUIQUP_EX_API_BASE_URL = "https://canonical.test";
    process.env.EX_API_BASE_URL = "https://alias.test";
    expect(getExCoreBaseUrl("production")).toBe("https://canonical.test");
  });

  it("encodes bracket-style filter query keys", async () => {
    let capturedUrl: string | null = null;
    server.use(
      http.get(`${PROD}/orders/download`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ ok: true });
      }),
    );

    const client = new ExCoreClient({ jwt: "test-jwt" });
    await client.request("GET", "/orders/download", {
      query: { "filters[order_id]": "1,2,3" },
    });

    expect(capturedUrl).not.toBeNull();
    const u = capturedUrl as unknown as string;
    // Percent-encoded form on the wire.
    expect(u).toContain("filters%5Border_id%5D=1%2C2%2C3");
    // And decodeURIComponent recovers the literal `filters[order_id]=1,2,3`.
    const decoded = decodeURIComponent(new URL(u).search.slice(1));
    expect(decoded).toContain("filters[order_id]=1,2,3");
  });
});
