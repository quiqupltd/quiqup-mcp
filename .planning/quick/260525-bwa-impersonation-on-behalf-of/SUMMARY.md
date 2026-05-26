---
status: complete
---

# Quick Task: Admin Impersonation via `on_behalf_of_email`

**Completed:** 2026-05-25  
**Commit:** dd90b2f

---

## What Was Broken

The Quiqup MCP auth was identity-bound at the JWT layer — every tool used the authenticated user's Clerk session to mint a Quiqup JWT, scoping all order/data access to that user's merchant account. When `slava+smd@quiqup.com` (Quiqup Demo account) was authenticated:
- Order 2619 (Amara Crown) was invisible — it belongs to a different merchant account
- `find_order_by_id_or_barcode`, `get_lastmile_order`, `recent_orders` all returned null/404
- `get_account_by_id` was labeled "admin / impersonation contexts" but still used the caller's own JWT for order lookups

---

## What Was Implemented

**`on_behalf_of_email` framework parameter** — injected into every `registerTool`-registered tool at the schema level. Zero handler changes required.

### New exports in `lib/quiqup.ts`:
- `ImpersonationForbiddenError` — thrown when non-admin caller attempts impersonation
- `lookupClerkUserByEmail(email)` — resolves email → Clerk userId via backend SDK
- `assertCallerIsAdminOrCsr(callerUserId, env?)` — calls platform-api `/me`, checks `admin || csr`

### `lib/tools/register.ts`:
- `ON_BEHALF_OF_FIELD` schema injected into every tool's `inputSchema` at registration
- `invokeWithGuardrails` step 0: validate admin → resolve email → override `auth.userId`
- Rate-limit key uses **callerUserId** (not target) to prevent admin calls burning partner quotas
- `on_behalf_of_email` stripped from `args` before passing to handler
- `AuthContext` extended: `effectiveUserId?`, `impersonatedEmail?` (optional, backward-compatible)

### `lib/middleware/audit.ts`:
- `AuditRecord` + `emitAuditRecord`: `effectiveUserId?` + `impersonatedEmail?` fields added

### Tests: `tests/impersonation.test.ts` — 13 tests covering:
1. Pass-through (no `on_behalf_of_email`) — original userId, no admin check called
2. Happy path — handler receives target userId, admin check called with callerUserId
3. `on_behalf_of_email` stripped from args before handler
4. Audit record carries callerUserId + impersonation metadata
5. Non-admin → `ImpersonationForbiddenError` → `isError: true` result
6. Non-admin → `lookupClerkUserByEmail` NOT called (security: no userId exfiltration)
7. Non-admin → audit record emitted even without guardrails
8. Email not found → clear error result
9. `auth.userId` null → immediate error
10. Whitespace trimming on email input

---

## Usage

```
# As admin/CSR — look up Amara Crown's order 2619:
find_order_by_id_or_barcode({
  id_or_barcode: "2619",
  intention: "state_check",
  on_behalf_of_email: "hamdy@amaracrown.com"
})

get_lastmile_order({
  order_id: "2619",
  on_behalf_of_email: "hamdy@amaracrown.com"
})
```

---

## Limitations / Follow-ups
- `recent_orders` and `claims_dump` use the legacy `registerRecentOrders` / `registerClaimsDump` pattern — they don't go through `registerTool` and do NOT gain `on_behalf_of_email`. `recent_orders` is the most useful one to migrate.
- No per-call admin-check caching (acceptable latency; M7 perf budget)
- AGENTS.md live-staging rule: no new Quiqup endpoint introduced — only JWT minting target changes. No live staging call required.
