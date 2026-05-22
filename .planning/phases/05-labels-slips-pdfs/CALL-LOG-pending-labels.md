# CALL-LOG: download_pending_labels live-staging verification (Phase 5 / 05-01)

## Status: DEFERRED — developer decision

**Date:** 2026-05-22
**Decision owner:** svetoslav@quiqup.com

## Waiver rationale

The AGENTS.md mandatory live-staging-call rule requires a real `POST
http://localhost:3000/mcp tools/call` invocation against
`graph.staging.quiqup.com` using a Clerk OAuth `at+jwt` from an active
Quiqdash staging session.

After discussion, the developer decided to defer this verification with the
following reasoning:

1. **What the live call uniquely proves:** (a) the `graph.staging.quiqup.com`
   endpoint exists at the expected path, (b) the Clerk→Quiqup JWT exchange
   works for this new host, (c) the response is actually a PDF binary. These
   are infrastructure questions, not code-correctness questions.

2. **What MSW unit tests already prove:** binary-envelope shape, error
   mapping (`QuiqupGraphqlHostError`), schema validation, rate limiting,
   route registration, tool-surface snapshot. All 3 test files pass.

3. **The Clerk auth piece is infrastructure.** The manual call primarily
   tests that the developer can log into Quiqdash staging — not that the
   tool code is correct. The code path (`getQuiqupReadyJwt` → Bearer →
   upstream) is identical to the already-verified paths in Phase 2–4 tools
   (same V3b Clerk→Quiqup exchange, same `QuiqupHttpError` envelope).

4. **Accepted risk:** the endpoint path `GET /pending_orders_labels` was
   read from `docs/quiqup-api-full-frontend-extract.md`. If the staging
   path differs, the tool will return a `QuiqupGraphqlHostError` with the
   upstream status — a labelled, agent-actionable error, not a silent
   failure.

## Follow-up required before production promotion

A real staging call SHOULD be made before this tool is promoted to
production use. The call should verify:

- `GET graph.staging.quiqup.com/pending_orders_labels` responds with
  `Content-Type: application/pdf`
- The base64 payload is non-empty
- The `filenameHint: pending-orders.pdf` survives the round-trip

Until that call is made and logged here, this tool should be treated as
**staging-unverified** in operational runbooks.

## Exemption scope

This waiver applies only to `download_pending_labels` (MISS-03 / plan 05-01).
Plans 05-02 (`download_return_label`) and 05-03 (`download_slip`) are also
subject to AGENTS.md and will be handled with the same deferred approach
unless the developer performs the call during execution of those plans.
