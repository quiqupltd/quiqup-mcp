/**
 * Impersonation tests — verifies `on_behalf_of_email` framework parameter
 * in the `registerTool` / `invokeWithGuardrails` path.
 *
 * Strategy: mock `@/lib/quiqup` at the module level so we control
 * `assertCallerIsAdminOrCsr` and `lookupClerkUserByEmail` without real
 * Clerk SDK calls or platform-api network calls. MSW is NOT needed here
 * because all Clerk/platform-api egress is behind the mocked functions.
 *
 * We drive tests through `_invokeWithGuardrailsForTests` (the same
 * orchestrator `registerTool` uses) to exercise the full impersonation
 * gate without spinning up an McpServer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import {
  _invokeWithGuardrailsForTests,
  type AuthContext,
  type ToolSpec,
} from "@/lib/tools/register";
import { _resetForTests as resetIdempotency } from "@/lib/middleware/idempotency";
import { _resetForTests as resetRateLimit } from "@/lib/middleware/rate-limit";
import { AUDIT_PREFIX } from "@/lib/middleware/audit";
import { ImpersonationForbiddenError } from "@/lib/quiqup";

// ---- Mock @/lib/quiqup -------------------------------------------------------
// Replace only the three impersonation-related exports; keep everything else.
vi.mock("@/lib/quiqup", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getQuiqupReadyJwt: vi.fn(async (_userId: string) => "test-jwt"),
    assertCallerIsAdminOrCsr: vi.fn(async () => {
      /* admin by default */
    }),
    lookupClerkUserByEmail: vi.fn(async (_email: string) => "user_target_xyz"),
  };
});

// Import after the mock is registered so vitest wires the spies.
const { assertCallerIsAdminOrCsr, lookupClerkUserByEmail } = await import(
  "@/lib/quiqup"
);

// ---- Helpers -----------------------------------------------------------------

const adminAuth: AuthContext = {
  userId: "user_admin_abc",
  orgId: null,
  sessionId: "sess_admin",
  scopes: ["read", "write"],
  bearerToken: "bearer-token-unused",
};

const inputSchema = z.object({
  resource_id: z.string(),
});
const outputSchema = z.object({}).passthrough();

type TestSpec = ToolSpec<typeof inputSchema, typeof outputSchema>;

/** Build a minimal spec whose handler captures the auth it received. */
function makeCapturingSpec(
  captured: { auth?: AuthContext },
  guardrails?: TestSpec["guardrails"],
): TestSpec {
  return {
    name: "test_tool",
    description: "stub",
    inputSchema,
    outputSchema,
    handler: async (auth, _args) => {
      captured.auth = auth;
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
    guardrails,
  };
}

function captureStdout() {
  const lines: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      lines.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    });
  return {
    auditLines: () =>
      lines
        .filter((l) => l.startsWith(`${AUDIT_PREFIX} `))
        .map((l) => JSON.parse(l.slice(`${AUDIT_PREFIX} `.length))),
    restore: () => spy.mockRestore(),
  };
}

// ---- Tests -------------------------------------------------------------------

describe("on_behalf_of_email impersonation", () => {
  let capture: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    resetIdempotency();
    resetRateLimit();
    capture = captureStdout();
    vi.clearAllMocks();
    // Default: admin allowed, target email resolves to user_target_xyz
    vi.mocked(assertCallerIsAdminOrCsr).mockResolvedValue(undefined);
    vi.mocked(lookupClerkUserByEmail).mockResolvedValue("user_target_xyz");
  });

  afterEach(() => capture.restore());

  describe("pass-through when on_behalf_of_email absent", () => {
    it("handler receives the original auth.userId", async () => {
      const captured: { auth?: AuthContext } = {};
      const spec = makeCapturingSpec(captured);

      await _invokeWithGuardrailsForTests(spec, adminAuth, {
        resource_id: "r-1",
      });

      expect(captured.auth?.userId).toBe("user_admin_abc");
      expect(captured.auth?.effectiveUserId).toBeUndefined();
      expect(captured.auth?.impersonatedEmail).toBeUndefined();
    });

    it("does NOT call assertCallerIsAdminOrCsr or lookupClerkUserByEmail", async () => {
      const spec = makeCapturingSpec({});
      await _invokeWithGuardrailsForTests(spec, adminAuth, {
        resource_id: "r-1",
      });
      expect(assertCallerIsAdminOrCsr).not.toHaveBeenCalled();
      expect(lookupClerkUserByEmail).not.toHaveBeenCalled();
    });
  });

  describe("happy path: admin caller impersonates target", () => {
    it("handler receives target userId as auth.userId", async () => {
      const captured: { auth?: AuthContext } = {};
      const spec = makeCapturingSpec(captured);

      await _invokeWithGuardrailsForTests(spec, adminAuth, {
        resource_id: "r-1",
        on_behalf_of_email: "hamdy@amaracrown.com",
      });

      expect(captured.auth?.userId).toBe("user_target_xyz");
      expect(captured.auth?.effectiveUserId).toBe("user_target_xyz");
      expect(captured.auth?.impersonatedEmail).toBe("hamdy@amaracrown.com");
    });

    it("calls assertCallerIsAdminOrCsr with the CALLER's userId", async () => {
      const spec = makeCapturingSpec({});

      await _invokeWithGuardrailsForTests(spec, adminAuth, {
        resource_id: "r-1",
        on_behalf_of_email: "hamdy@amaracrown.com",
      });

      expect(assertCallerIsAdminOrCsr).toHaveBeenCalledWith("user_admin_abc");
    });

    it("calls lookupClerkUserByEmail with the target email", async () => {
      const spec = makeCapturingSpec({});

      await _invokeWithGuardrailsForTests(spec, adminAuth, {
        resource_id: "r-1",
        on_behalf_of_email: "hamdy@amaracrown.com",
      });

      expect(lookupClerkUserByEmail).toHaveBeenCalledWith(
        "hamdy@amaracrown.com",
      );
    });

    it("strips on_behalf_of_email from the args received by the handler", async () => {
      let receivedArgs: Record<string, unknown> = {};
      const spec: TestSpec = {
        name: "test_tool",
        description: "stub",
        inputSchema,
        outputSchema,
        handler: async (_auth, args) => {
          receivedArgs = args as Record<string, unknown>;
          return { content: [{ type: "text" as const, text: "ok" }] };
        },
      };

      await _invokeWithGuardrailsForTests(spec, adminAuth, {
        resource_id: "r-1",
        on_behalf_of_email: "hamdy@amaracrown.com",
      });

      expect(receivedArgs).not.toHaveProperty("on_behalf_of_email");
      expect(receivedArgs.resource_id).toBe("r-1");
    });

    it("emits audit record with impersonation fields when guardrails.audit is true", async () => {
      const spec = makeCapturingSpec(
        {},
        { audit: true, rateLimit: { capacity: 10, refillPerSec: 10 } },
      );

      await _invokeWithGuardrailsForTests(spec, adminAuth, {
        resource_id: "r-1",
        on_behalf_of_email: "hamdy@amaracrown.com",
      });

      const lines = capture.auditLines();
      expect(lines).toHaveLength(1);
      const record = lines[0];
      // Audit shows the original CALLER, not the target
      expect(record.userId).toBe("user_admin_abc");
      // Impersonation metadata included
      expect(record.effectiveUserId).toBe("user_target_xyz");
      expect(record.impersonatedEmail).toBe("hamdy@amaracrown.com");
    });
  });

  describe("non-admin caller — ImpersonationForbiddenError", () => {
    it("returns isError:true result when caller is not admin/CSR", async () => {
      vi.mocked(assertCallerIsAdminOrCsr).mockRejectedValue(
        new ImpersonationForbiddenError("user_admin_abc"),
      );

      const captured: { auth?: AuthContext } = {};
      const spec = makeCapturingSpec(captured);

      const result = await _invokeWithGuardrailsForTests(spec, adminAuth, {
        resource_id: "r-1",
        on_behalf_of_email: "hamdy@amaracrown.com",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({ type: "text" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toMatch(/Impersonation denied/);
      expect(text).toMatch(/admin or CSR/);
      // Handler was never called
      expect(captured.auth).toBeUndefined();
    });

    it("does NOT call lookupClerkUserByEmail when admin check fails", async () => {
      vi.mocked(assertCallerIsAdminOrCsr).mockRejectedValue(
        new ImpersonationForbiddenError("user_admin_abc"),
      );

      const spec = makeCapturingSpec({});
      await _invokeWithGuardrailsForTests(spec, adminAuth, {
        resource_id: "r-1",
        on_behalf_of_email: "target@example.com",
      });

      expect(lookupClerkUserByEmail).not.toHaveBeenCalled();
    });

    it("emits audit record with impersonation-failed error", async () => {
      vi.mocked(assertCallerIsAdminOrCsr).mockRejectedValue(
        new ImpersonationForbiddenError("user_admin_abc"),
      );

      const spec = makeCapturingSpec({}, { audit: true });

      await _invokeWithGuardrailsForTests(spec, adminAuth, {
        resource_id: "r-1",
        on_behalf_of_email: "hamdy@amaracrown.com",
      });

      const lines = capture.auditLines();
      // Impersonation failure always audits regardless of guardrails.audit value
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const record = lines[0];
      expect(record.ok).toBe(false);
      expect(record.error).toMatch(/impersonation-failed/);
      expect(record.impersonatedEmail).toBe("hamdy@amaracrown.com");
    });
  });

  describe("email not found", () => {
    it("returns isError:true with clear message when target email unknown", async () => {
      vi.mocked(lookupClerkUserByEmail).mockRejectedValue(
        new Error(
          "No Clerk user found with email ghost@nowhere.com. Verify the address is a registered Quiqup account and retry.",
        ),
      );

      const captured: { auth?: AuthContext } = {};
      const spec = makeCapturingSpec(captured);

      const result = await _invokeWithGuardrailsForTests(spec, adminAuth, {
        resource_id: "r-1",
        on_behalf_of_email: "ghost@nowhere.com",
      });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toMatch(/Impersonation setup failed/);
      expect(text).toMatch(/No Clerk user found/);
      // Handler never called
      expect(captured.auth).toBeUndefined();
    });
  });

  describe("no authenticated userId", () => {
    it("returns isError:true when auth.userId is null", async () => {
      const anonAuth: AuthContext = { ...adminAuth, userId: null };
      const captured: { auth?: AuthContext } = {};
      const spec = makeCapturingSpec(captured);

      const result = await _invokeWithGuardrailsForTests(spec, anonAuth, {
        resource_id: "r-1",
        on_behalf_of_email: "hamdy@amaracrown.com",
      });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toMatch(/requires an authenticated session/);
      expect(captured.auth).toBeUndefined();
    });
  });

  describe("whitespace trimming", () => {
    it("trims leading/trailing spaces from on_behalf_of_email before lookup", async () => {
      const spec = makeCapturingSpec({});

      await _invokeWithGuardrailsForTests(spec, adminAuth, {
        resource_id: "r-1",
        on_behalf_of_email: "  hamdy@amaracrown.com  ",
      });

      expect(lookupClerkUserByEmail).toHaveBeenCalledWith(
        "hamdy@amaracrown.com",
      );
    });
  });
});
