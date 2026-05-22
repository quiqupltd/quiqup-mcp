/**
 * MSW-mocked Vitest suite for Phase-5 Labels, Slips & PDFs tools.
 *
 * This file is the single test file for the whole phase's tool tests.
 * Wave 2 (download_return_label) and Wave 3 (download_slip) will add
 * additional `describe()` blocks here — this task seeds it with the
 * first describe block for `download_pending_labels` (MISS-03).
 *
 * Coverage contract for download_pending_labels:
 *   - Happy path returns the canonical dual resource+text content blocks.
 *   - Unauthenticated callers are rejected before fetch.
 *   - environment: "staging" routes to graph.staging.quiqup.com.
 *   - Authorization: Bearer header is forwarded to the upstream.
 *   - Input schema has exactly ["environment"] — no extra fields.
 *   - No `guardrails` block (read-only tool per download_orders_export precedent).
 *
 * WR-05 env cleanup: QUIQUP_GRAPHQL_HOST_BASE_URL and
 * QUIQUP_GRAPHQL_HOST_STAGING_BASE_URL are deleted in beforeEach so a
 * developer's shell cannot route fetches around MSW.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup/msw";

vi.mock("@/lib/quiqup", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getQuiqupReadyJwt: vi.fn(async (_userId: string) => "test-jwt-for-msw"),
  };
});

const auth = {
  userId: "user_test",
  orgId: null,
  sessionId: "sess_test",
  scopes: ["write"],
  bearerToken: "inbound_at_jwt_unused_in_v3b",
};

const authAnon = {
  userId: null,
  orgId: null,
  sessionId: null,
  scopes: [],
  bearerToken: null,
};

const GRAPHQL_HOST_PROD = "https://graph.quiqup.com";
const GRAPHQL_HOST_STAGING = "https://graph.staging.quiqup.com";

const originalEnv = {
  QUIQUP_GRAPHQL_HOST_BASE_URL: process.env.QUIQUP_GRAPHQL_HOST_BASE_URL,
  QUIQUP_GRAPHQL_HOST_STAGING_BASE_URL:
    process.env.QUIQUP_GRAPHQL_HOST_STAGING_BASE_URL,
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.QUIQUP_GRAPHQL_HOST_BASE_URL;
  delete process.env.QUIQUP_GRAPHQL_HOST_STAGING_BASE_URL;
});

afterEach(() => {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
});

describe("download_pending_labels", () => {
  it("happy path returns the dual content block envelope", async () => {
    // Minimal PDF magic bytes.
    const pdfBytes = new Uint8Array([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34,
    ]);
    server.use(
      http.get(`${GRAPHQL_HOST_PROD}/pending_orders_labels`, () =>
        new HttpResponse(pdfBytes, {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
      ),
    );

    const mod = await import("../../lib/tools/download-pending-labels");
    const result = await mod.spec.handler(auth, { environment: "production" });

    // Two content blocks: resource block + metadata text block.
    expect(result.content).toHaveLength(2);

    // Block 0 MUST be a `resource` block — binary-envelope-contract.
    const resourceBlock = result.content[0];
    if (resourceBlock.type !== "resource") {
      throw new Error(
        `expected a "resource" block at index 0, got "${resourceBlock.type}"`,
      );
    }
    const resourcePayload = resourceBlock.resource as {
      uri: string;
      mimeType?: string;
      blob?: string;
    };
    expect(resourcePayload.mimeType).toContain("application/pdf");
    expect(resourcePayload.uri).toBe("quiqup-label://pending-orders.pdf");
    expect(typeof resourcePayload.blob).toBe("string");
    expect((resourcePayload.blob as string).length).toBeGreaterThan(0);
    // Round-trip: base64 must decode back to the bytes the server sent.
    expect(
      Buffer.from(resourcePayload.blob as string, "base64").equals(
        Buffer.from(pdfBytes),
      ),
    ).toBe(true);

    // Block 1 is the metadata `text` block.
    const metaBlock = result.content[1];
    if (metaBlock.type !== "text") {
      throw new Error("expected text block at index 1");
    }
    const parsed = JSON.parse(metaBlock.text);
    expect(parsed.contentType).toContain("application/pdf");
    expect(typeof parsed.base64).toBe("string");
    expect(parsed.base64.length).toBeGreaterThan(0);
    expect(parsed.filenameHint).toBe("pending-orders.pdf");
    // base64 deep-equals the resource blob.
    expect(parsed.base64).toBe(resourcePayload.blob);
    // Round-trip from the text-block base64.
    expect(
      Buffer.from(parsed.base64, "base64").equals(Buffer.from(pdfBytes)),
    ).toBe(true);
  });

  it("rejects unauthenticated callers", async () => {
    const mod = await import("../../lib/tools/download-pending-labels");
    await expect(
      mod.spec.handler(authAnon, { environment: "production" }),
    ).rejects.toThrow(/requires an authenticated user/);
  });

  it("forwards environment: staging to the staging host", async () => {
    let requestCount = 0;
    server.use(
      http.get(`${GRAPHQL_HOST_STAGING}/pending_orders_labels`, () => {
        requestCount++;
        return new HttpResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        });
      }),
    );

    const mod = await import("../../lib/tools/download-pending-labels");
    await mod.spec.handler(auth, { environment: "staging" });

    expect(requestCount).toBe(1);
  });

  it("forwards Authorization: Bearer header", async () => {
    let capturedAuth: string | null = null;
    server.use(
      http.get(`${GRAPHQL_HOST_PROD}/pending_orders_labels`, ({ request }) => {
        capturedAuth = request.headers.get("authorization");
        return new HttpResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        });
      }),
    );

    const mod = await import("../../lib/tools/download-pending-labels");
    await mod.spec.handler(auth, { environment: "production" });

    expect(capturedAuth).not.toBeNull();
    expect(capturedAuth as unknown as string).toMatch(/^Bearer /);
  });

  it("input schema accepts no additional fields beyond environment", async () => {
    const mod = await import("../../lib/tools/download-pending-labels");
    const keys = Object.keys(mod.spec.inputSchema.shape);
    expect(keys).toEqual(["environment"]);
  });

  it("has NO guardrails block (read-only tool)", async () => {
    const mod = await import("../../lib/tools/download-pending-labels");
    expect(mod.spec.guardrails).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Wave 2: download_return_label (MISS-05)
// ---------------------------------------------------------------------------
describe("download_return_label", () => {
  it("happy path returns the dual content block envelope", async () => {
    // Minimal PDF magic bytes.
    const pdfBytes = new Uint8Array([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34,
    ]);
    server.use(
      http.get(`${GRAPHQL_HOST_PROD}/return_order_label/57282`, () =>
        new HttpResponse(pdfBytes, {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
      ),
    );

    const mod = await import("../../lib/tools/download-return-label");
    const result = await mod.spec.handler(auth, {
      order_id: "57282",
      environment: "production",
    });

    // Two content blocks: resource block + metadata text block.
    expect(result.content).toHaveLength(2);

    // Block 0 MUST be a `resource` block — binary-envelope-contract.
    const resourceBlock = result.content[0];
    if (resourceBlock.type !== "resource") {
      throw new Error(
        `expected a "resource" block at index 0, got "${resourceBlock.type}"`,
      );
    }
    const resourcePayload = resourceBlock.resource as {
      uri: string;
      mimeType?: string;
      blob?: string;
    };
    expect(resourcePayload.mimeType).toContain("application/pdf");
    expect(resourcePayload.uri).toBe(
      "quiqup-label://return-label-57282.pdf",
    );
    expect(typeof resourcePayload.blob).toBe("string");
    expect((resourcePayload.blob as string).length).toBeGreaterThan(0);
    // Round-trip: base64 must decode back to the bytes the server sent.
    expect(
      Buffer.from(resourcePayload.blob as string, "base64").equals(
        Buffer.from(pdfBytes),
      ),
    ).toBe(true);

    // Block 1 is the metadata `text` block.
    const metaBlock = result.content[1];
    if (metaBlock.type !== "text") {
      throw new Error("expected text block at index 1");
    }
    const parsed = JSON.parse(metaBlock.text);
    expect(parsed.contentType).toContain("application/pdf");
    expect(typeof parsed.base64).toBe("string");
    expect(parsed.base64.length).toBeGreaterThan(0);
    expect(parsed.filenameHint).toBe("return-label-57282.pdf");
    // base64 deep-equals the resource blob.
    expect(parsed.base64).toBe(resourcePayload.blob);
    // Round-trip from the text-block base64.
    expect(
      Buffer.from(parsed.base64, "base64").equals(Buffer.from(pdfBytes)),
    ).toBe(true);
  });

  it("encodes order_id in the URL path (T-03-24 / T-05-10)", async () => {
    // The slash in "57282/admin" MUST be percent-encoded in the outbound URL.
    let capturedPath: string | null = null;
    server.use(
      http.get(
        `${GRAPHQL_HOST_PROD}/return_order_label/57282%2Fadmin`,
        ({ request }) => {
          capturedPath = new URL(request.url).pathname;
          return new HttpResponse(
            new Uint8Array([0x25, 0x50, 0x44, 0x46]),
            {
              status: 200,
              headers: { "Content-Type": "application/pdf" },
            },
          );
        },
      ),
    );

    const mod = await import("../../lib/tools/download-return-label");
    await mod.spec.handler(auth, {
      order_id: "57282/admin",
      environment: "production",
    });

    // Verify the path reached MSW had the encoded slash.
    expect(capturedPath).toBe("/return_order_label/57282%2Fadmin");
  });

  it("uses the raw orderId in the filenameHint, not the encoded form (T-05-12)", async () => {
    // order_id "57282" is benign here — tests that no spurious encoding appears.
    server.use(
      http.get(`${GRAPHQL_HOST_PROD}/return_order_label/57282`, () =>
        new HttpResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
      ),
    );

    const mod = await import("../../lib/tools/download-return-label");
    const result = await mod.spec.handler(auth, {
      order_id: "57282",
      environment: "production",
    });

    const resourceBlock = result.content[0];
    if (resourceBlock.type !== "resource") throw new Error("expected resource block");
    const resource = resourceBlock.resource as { uri: string };
    expect(resource.uri).toBe("quiqup-label://return-label-57282.pdf");

    const metaBlock = result.content[1];
    if (metaBlock.type !== "text") throw new Error("expected text block");
    const parsed = JSON.parse(metaBlock.text);
    // Raw order_id in filenameHint — no percent-encoding artifacts.
    expect(parsed.filenameHint).toBe("return-label-57282.pdf");
  });

  it("rejects unauthenticated callers", async () => {
    const mod = await import("../../lib/tools/download-return-label");
    await expect(
      mod.spec.handler(authAnon, { order_id: "57282", environment: "production" }),
    ).rejects.toThrow(/requires an authenticated user/);
  });

  it("forwards environment: staging to the staging host", async () => {
    let requestCount = 0;
    server.use(
      http.get(
        `${GRAPHQL_HOST_STAGING}/return_order_label/57282`,
        () => {
          requestCount++;
          return new HttpResponse(
            new Uint8Array([0x25, 0x50, 0x44, 0x46]),
            {
              status: 200,
              headers: { "Content-Type": "application/pdf" },
            },
          );
        },
      ),
    );

    const mod = await import("../../lib/tools/download-return-label");
    await mod.spec.handler(auth, {
      order_id: "57282",
      environment: "staging",
    });

    expect(requestCount).toBe(1);
  });

  it("rejects empty order_id at the schema layer", async () => {
    const mod = await import("../../lib/tools/download-return-label");
    const result = mod.spec.inputSchema.safeParse({
      order_id: "",
      environment: "production",
    });
    expect(result.success).toBe(false);
  });

  it("has NO guardrails block (read-only tool)", async () => {
    const mod = await import("../../lib/tools/download-return-label");
    expect(mod.spec.guardrails).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Wave 3: download_slip (MISS-06)
// ---------------------------------------------------------------------------

const PLATFORM_HOST_PROD = "https://platform-api.quiqup.com";
const PLATFORM_HOST_STAGING = "https://platform-api.staging.quiqup.com";

const originalPlatformEnv = {
  QUIQUP_PLATFORM_API_BASE_URL: process.env.QUIQUP_PLATFORM_API_BASE_URL,
  QUIQUP_PLATFORM_API_STAGING_BASE_URL:
    process.env.QUIQUP_PLATFORM_API_STAGING_BASE_URL,
};

beforeEach(() => {
  delete process.env.QUIQUP_PLATFORM_API_BASE_URL;
  delete process.env.QUIQUP_PLATFORM_API_STAGING_BASE_URL;
});

afterEach(() => {
  for (const [k, v] of Object.entries(originalPlatformEnv)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
});

describe("download_slip", () => {
  it("happy path returns the dual content block envelope for picking-list", async () => {
    const pdfBytes = new Uint8Array([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34,
    ]);
    server.use(
      http.get(`${PLATFORM_HOST_PROD}/slips/picking-list`, () =>
        new HttpResponse(pdfBytes, {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
      ),
    );

    const mod = await import("../../lib/tools/download-slip");
    const result = await mod.spec.handler(auth, {
      slipType: "picking-list",
      order_ids: [12345, 12346],
      environment: "production",
    });

    expect(result.content).toHaveLength(2);

    const resourceBlock = result.content[0];
    if (resourceBlock.type !== "resource") {
      throw new Error(
        `expected a "resource" block at index 0, got "${resourceBlock.type}"`,
      );
    }
    const resourcePayload = resourceBlock.resource as {
      uri: string;
      mimeType?: string;
      blob?: string;
    };
    expect(resourcePayload.mimeType).toContain("application/pdf");
    expect(resourcePayload.uri).toBe(
      "quiqup-label://picking-list-12345-and-1-more.pdf",
    );
    expect(typeof resourcePayload.blob).toBe("string");
    expect((resourcePayload.blob as string).length).toBeGreaterThan(0);
    expect(
      Buffer.from(resourcePayload.blob as string, "base64").equals(
        Buffer.from(pdfBytes),
      ),
    ).toBe(true);

    const metaBlock = result.content[1];
    if (metaBlock.type !== "text") {
      throw new Error("expected text block at index 1");
    }
    const parsed = JSON.parse(metaBlock.text);
    expect(parsed.contentType).toContain("application/pdf");
    expect(parsed.filenameHint).toBe("picking-list-12345-and-1-more.pdf");
    expect(parsed.base64).toBe(resourcePayload.blob);
  });

  it("single-order filenameHint is <slipType>-<orderId>.pdf (no and-N-more suffix)", async () => {
    server.use(
      http.get(`${PLATFORM_HOST_PROD}/slips/picking-list`, () =>
        new HttpResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
      ),
    );

    const mod = await import("../../lib/tools/download-slip");
    const result = await mod.spec.handler(auth, {
      slipType: "picking-list",
      order_ids: [99],
      environment: "production",
    });

    const metaBlock = result.content[1];
    if (metaBlock.type !== "text") throw new Error("expected text block");
    const parsed = JSON.parse(metaBlock.text);
    expect(parsed.filenameHint).toBe("picking-list-99.pdf");

    const resourceBlock = result.content[0];
    if (resourceBlock.type !== "resource") throw new Error("expected resource block");
    const resource = resourceBlock.resource as { uri: string };
    expect(resource.uri).toBe("quiqup-label://picking-list-99.pdf");
  });

  it("forwards api-version: 20180108 and Accept: application/pdf headers", async () => {
    let capturedApiVersion: string | null = null;
    let capturedAccept: string | null = null;
    server.use(
      http.get(`${PLATFORM_HOST_PROD}/slips/picking-list`, ({ request }) => {
        capturedApiVersion = request.headers.get("api-version");
        capturedAccept = request.headers.get("accept");
        return new HttpResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        });
      }),
    );

    const mod = await import("../../lib/tools/download-slip");
    await mod.spec.handler(auth, {
      slipType: "picking-list",
      order_ids: [12345],
      environment: "production",
    });

    expect(capturedApiVersion).toBe("20180108");
    // Accept header must be application/pdf — NOT application/json (which would 406).
    expect(capturedAccept).toBe("application/pdf");
    expect(capturedAccept).not.toBe("application/json");
  });

  it("rejects slipType values outside the enum at the schema layer", async () => {
    const mod = await import("../../lib/tools/download-slip");
    // Non-enum string value
    expect(
      mod.spec.inputSchema.safeParse({
        slipType: "invoice",
        order_ids: [1],
        environment: "production",
      }).success,
    ).toBe(false);
    // Empty string
    expect(
      mod.spec.inputSchema.safeParse({
        slipType: "",
        order_ids: [1],
        environment: "production",
      }).success,
    ).toBe(false);
    // Numeric value
    expect(
      mod.spec.inputSchema.safeParse({
        slipType: 1,
        order_ids: [1],
        environment: "production",
      }).success,
    ).toBe(false);
  });

  it("rejects empty order_ids at the schema layer", async () => {
    const mod = await import("../../lib/tools/download-slip");
    const result = mod.spec.inputSchema.safeParse({
      slipType: "picking-list",
      order_ids: [],
      environment: "production",
    });
    expect(result.success).toBe(false);
  });

  it("rejects order_ids > 500 entries at the schema layer", async () => {
    const mod = await import("../../lib/tools/download-slip");
    const tooMany = Array.from({ length: 501 }, (_, i) => i + 1);
    const result = mod.spec.inputSchema.safeParse({
      slipType: "picking-list",
      order_ids: tooMany,
      environment: "production",
    });
    expect(result.success).toBe(false);
  });

  it("encodes order_ids as a comma-separated query string on the wire", async () => {
    let capturedUrl: URL | null = null;
    server.use(
      http.get(`${PLATFORM_HOST_PROD}/slips/picking-list`, ({ request }) => {
        capturedUrl = new URL(request.url);
        return new HttpResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        });
      }),
    );

    const mod = await import("../../lib/tools/download-slip");
    await mod.spec.handler(auth, {
      slipType: "picking-list",
      order_ids: [1, 2, 3],
      environment: "production",
    });

    expect(capturedUrl).not.toBeNull();
    expect((capturedUrl as unknown as URL).searchParams.get("order_ids")).toBe(
      "1,2,3",
    );
  });

  it("supports packing-list slipType and routes to the correct path", async () => {
    let requestCount = 0;
    server.use(
      http.get(`${PLATFORM_HOST_PROD}/slips/packing-list`, () => {
        requestCount++;
        return new HttpResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        });
      }),
    );

    const mod = await import("../../lib/tools/download-slip");
    const result = await mod.spec.handler(auth, {
      slipType: "packing-list",
      order_ids: [12345],
      environment: "production",
    });

    expect(requestCount).toBe(1);
    const metaBlock = result.content[1];
    if (metaBlock.type !== "text") throw new Error("expected text block");
    const parsed = JSON.parse(metaBlock.text);
    expect(parsed.filenameHint).toBe("packing-list-12345.pdf");
  });

  it("forwards environment: staging to the staging host", async () => {
    let requestCount = 0;
    server.use(
      http.get(
        `${PLATFORM_HOST_STAGING}/slips/picking-list`,
        () => {
          requestCount++;
          return new HttpResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
            status: 200,
            headers: { "Content-Type": "application/pdf" },
          });
        },
      ),
    );

    const mod = await import("../../lib/tools/download-slip");
    await mod.spec.handler(auth, {
      slipType: "picking-list",
      order_ids: [12345],
      environment: "staging",
    });

    expect(requestCount).toBe(1);
  });

  it("rejects unauthenticated callers", async () => {
    const mod = await import("../../lib/tools/download-slip");
    await expect(
      mod.spec.handler(authAnon, {
        slipType: "picking-list",
        order_ids: [12345],
        environment: "production",
      }),
    ).rejects.toThrow(/requires an authenticated user/);
  });

  it("has NO guardrails block (read-only tool)", async () => {
    const mod = await import("../../lib/tools/download-slip");
    expect(mod.spec.guardrails).toBeUndefined();
  });
});
