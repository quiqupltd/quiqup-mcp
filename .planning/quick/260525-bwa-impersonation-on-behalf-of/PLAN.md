# Quick Task: Admin Impersonation via `on_behalf_of_email`

**Date:** 2026-05-25  
**Slug:** 260525-bwa-impersonation-on-behalf-of  
**Triggered by:** Admin session (slava+smd@quiqup.com) unable to look up order 2619 for Amara Crown (hamdy@amaracrown.com) — all order tools returned null/404.

---

## What Happened

The Quiqup MCP auth is **identity-bound at the JWT layer**:

```
inbound at+jwt → auth.userId (Clerk subject)
               → getQuiqupReadyJwt(auth.userId)
               → Quiqup session JWT scoped to THAT user's merchant account
               → order lookups only see that account's orders
```

When `slava+smd@quiqup.com` (Quiqup Demo account) is the authenticated user:
- `auth.userId = "user_2sc1NFOmAOPJ5Vk51HRf9YAQVa9"`
- Every tool calls `getQuiqupReadyJwt("user_2sc1NFO…")` → JWT for the DEMO account
- Order 2619 belongs to Amara Crown — **invisible under the demo account scope**
- `find_order_by_id_or_barcode` returns a 200 with `error` (no-match path, not a crash)
- `get_lastmile_order` / `recent_orders` return null/empty

`get_account_by_id` was labeled "admin / impersonation contexts" but **still uses the caller's own JWT** — it only queries another account's profile data, not their orders.

The `lib/quiqup.ts` comment noted "any future actor-token / impersonation flows" — the foundation was deliberately left open.

---

## Fix: `on_behalf_of_email` Framework Parameter

### Design

Add an optional `on_behalf_of_email` parameter injected at the **`registerTool` wrapper level** — a single code change that grants impersonation to every existing tool without touching any individual tool file.

Flow when `on_behalf_of_email` is present:
1. **Validate caller is admin/CSR** — call platform-api `/me`, check `admin: true || csr: true`. Throws `ImpersonationForbiddenError` if not.
2. **Resolve email → Clerk userId** — `clerk.users.getUserList({ emailAddress: [email] })`. Throws if not found.
3. **Override `auth.userId`** in the handler call to the target's Clerk userId.
4. All tools call `getQuiqupReadyJwt(auth.userId)` unchanged → now mints a JWT for the target account.
5. **Audit record** includes both original caller and impersonation metadata.

### Security
- Admin check is BEFORE email lookup — prevents exfiltrating Clerk userIds via non-admin sessions.
- Original callerUserId preserved in audit log (`userId` field).
- `ImpersonationForbiddenError` produces a clear `isError: true` result with guidance.
- `on_behalf_of_email` is stripped from `args` before passing to the handler.

---

## Task List

### Task 1: Impersonation helpers in `lib/quiqup.ts`
- `ImpersonationForbiddenError` class
- `lookupClerkUserByEmail(email): Promise<string>` — calls `clerk.users.getUserList()`
- `assertCallerIsAdminOrCsr(callerUserId, environment?): Promise<void>` — calls `/me`, checks `admin || csr`

### Task 2: Extend `AuthContext` + `registerTool` in `lib/tools/register.ts`
- Add `effectiveUserId: string | null` + `impersonatedEmail: string | null` to `AuthContext`
- In `registerTool`: inject `on_behalf_of_email` into the inputSchema.shape (so MCP SDK exposes it)
- In `invokeWithGuardrails`: extract + process `on_behalf_of_email`, build impersonated auth, strip the field from args before handler call

### Task 3: Audit record extension in `lib/middleware/audit.ts`
- Add optional `effectiveUserId?: string | null` + `impersonatedEmail?: string | null` to `AuditRecord`
- Pass through in `emitAuditRecord`

### Task 4: Tests in `tests/impersonation.test.ts`
- Happy path: admin caller + valid email → handler receives target userId, audit shows impersonation
- Non-admin: `ImpersonationForbiddenError` → `isError: true` result
- Email not found: clear error result
- No auth.userId: immediate error
- No `on_behalf_of_email`: passes through unchanged (regression guard)

---

## Out of Scope (follow-up)
- `recent_orders` (legacy `registerRecentOrders` pattern) — needs separate update to benefit
- `claims_dump` — should NOT support impersonation (diagnostic tool)
- Per-call caching of admin check (acceptable latency for now; M7 perf budget)
- Staging call (AGENTS.md rule) — `on_behalf_of_email` only changes JWT minting; no new Quiqup endpoint introduced
