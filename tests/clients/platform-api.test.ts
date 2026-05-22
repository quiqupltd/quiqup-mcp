/**
 * MSW-mocked Vitest suite for PlatformApiClient (Phase 5 / Plan 03).
 *
 * Covers the backwards-compatible extraHeaders extension introduced in
 * plan 05-03 to support `download_slip` (api-version: 20180108 +
 * Accept: application/pdf). Also reserved for Phase-8
 * `list_carrier_capabilities` (x-api-version: 20240101).
 *
 * Contract tested here:
 *   1. `extraHeaders` values are forwarded verbatim to the upstream.
 *   2. `extraHeaders` can override the default Accept: application/json
 *      (the key use case for download_slip).
 *   3. When `extraHeaders` is omitted the method is identical to its
 *      pre-Phase-5 form — existing Phase 1-4 callers are unaffected.
 *   4. Backwards-compat guard: a typical Phase-1-style GET produces
 *      ONLY the standard headers (Authorization + Accept), not an
 *      empty key from the spread.
 *   5. Multiple extraHeaders keys are all forwarded (e.g. both
 *      api-version and Accept simultaneously for download_slip).
 *
 * WR-05 env-cleanup: QUIQUP_PLATFORM_API_BASE_URL and
 * QUIQUP_PLATFORM_API_STAGING_BASE_URL are deleted in beforeEach so a
 * developer's shell env cannot route fetches around MSW.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup/msw";
import { PlatformApiClient } from "../../lib/clients/platform-api";

const PLATFORM_PROD = "https://platform-api.quiqup.com";
const PLATFORM_STAGING = "https://platform-api.staging.quiqup.com";

const originalProdUrl = process.env.QUIQUP_PLATFORM_API_BASE_URL;
const originalStagingUrl = process.env.QUIQUP_PLATFORM_API_STAGING_BASE_URL;

beforeEach(() => {
  delete process.env.QUIQUP_PLATFORM_API_BASE_URL;
  delete process.env.QUIQUP_PLATFORM_API_STAGING_BASE_URL;
});

afterEach(() => {
  if (originalProdUrl === undefined) {
    delete process.env.QUIQUP_PLATFORM_API_BASE_URL;
  } else {
    process.env.QUIQUP_PLATFORM_API_BASE_URL = originalProdUrl;
  }
  if (originalStagingUrl === undefined) {
    delete process.env.QUIQUP_PLATFORM_API_STAGING_BASE_URL;
  } else {
    process.env.QUIQUP_PLATFORM_API_STAGING_BASE_URL = originalStagingUrl;
  }
});

describe("PlatformApiClient.request() — extraHeaders extension (05-03)", () => {
  it("forwards extraHeaders verbatim to the upstream", async () => {
    let capturedApiVersion: string | null = null;
    let capturedAccept: string | null = null;
    server.use(
      http.get(`${PLATFORM_PROD}/slips/picking-list`, ({ request }) => {
        capturedApiVersion = request.headers.get("api-version");
        capturedAccept = request.headers.get("accept");
        return new HttpResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        });
      }),
    );

    const client = new PlatformApiClient({ jwt: "test-jwt" });
    await client.request("GET", "/slips/picking-list", {
      extraHeaders: { "api-version": "20180108", Accept: "application/pdf" },
    });

    expect(capturedApiVersion).toBe("20180108");
    expect(capturedAccept).toBe("application/pdf");
  });

  it("extraHeaders override the default Accept: application/json", async () => {
    let capturedAccept: string | null = null;
    server.use(
      http.get(`${PLATFORM_PROD}/slips/picking-list`, ({ request }) => {
        capturedAccept = request.headers.get("accept");
        return new HttpResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        });
      }),
    );

    const client = new PlatformApiClient({ jwt: "test-jwt" });
    await client.request("GET", "/slips/picking-list", {
      extraHeaders: { Accept: "application/pdf" },
    });

    // Must be application/pdf, NOT application/json (default).
    expect(capturedAccept).toBe("application/pdf");
    expect(capturedAccept).not.toBe("application/json");
  });

  it("omits extraHeaders when not provided — default Accept is application/json", async () => {
    let capturedAccept: string | null = null;
    server.use(
      http.get(`${PLATFORM_PROD}/account`, ({ request }) => {
        capturedAccept = request.headers.get("accept");
        return HttpResponse.json({ id: 1 });
      }),
    );

    const client = new PlatformApiClient({ jwt: "test-jwt" });
    await client.request("GET", "/account");

    expect(capturedAccept).toBe("application/json");
  });

  it("backwards-compat — existing Phase 1-4 caller produces only standard headers (no empty key from spread)", async () => {
    const capturedHeaders: Record<string, string> = {};
    server.use(
      http.get(`${PLATFORM_PROD}/account`, ({ request }) => {
        request.headers.forEach((value, key) => {
          capturedHeaders[key] = value;
        });
        return HttpResponse.json({ id: 1 });
      }),
    );

    const client = new PlatformApiClient({ jwt: "test-jwt" });
    await client.request("GET", "/account");

    // The standard headers MUST be present.
    expect(capturedHeaders["authorization"]).toMatch(/^Bearer /);
    expect(capturedHeaders["accept"]).toBe("application/json");
    // No empty-string key should appear (would indicate a bad spread).
    expect("" in capturedHeaders).toBe(false);
    // No Content-Type on a bodyless GET.
    expect(capturedHeaders["content-type"]).toBeUndefined();
  });

  it("forwards all extraHeaders keys simultaneously (multi-header — Phase-5 download_slip shape)", async () => {
    const capturedHeaders: Record<string, string> = {};
    server.use(
      http.get(`${PLATFORM_PROD}/slips/packing-list`, ({ request }) => {
        request.headers.forEach((value, key) => {
          capturedHeaders[key] = value;
        });
        return new HttpResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        });
      }),
    );

    const client = new PlatformApiClient({ jwt: "test-jwt" });
    await client.request("GET", "/slips/packing-list", {
      extraHeaders: { "api-version": "20180108", Accept: "application/pdf" },
    });

    expect(capturedHeaders["api-version"]).toBe("20180108");
    expect(capturedHeaders["accept"]).toBe("application/pdf");
    expect(capturedHeaders["authorization"]).toMatch(/^Bearer /);
  });
});
