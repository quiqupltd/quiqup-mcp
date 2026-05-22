# CALL-LOG: download_slip live-staging verification (Phase 5 / 05-03)

## Status: DEFERRED — developer decision

**Date:** 2026-05-22
**Decision owner:** svetoslav@quiqup.com

## Waiver rationale

The AGENTS.md mandatory live-staging-call rule requires a real `POST
http://localhost:3000/mcp tools/call` invocation against
`platform-api.staging.quiqup.com` using a Clerk OAuth `at+jwt` from an active
Quiqdash staging session.

After discussion, the developer decided to defer this verification with the
following reasoning, consistent with the blanket deferral decision applied to
plans 05-01 and 05-02 (CALL-LOG-pending-labels.md committed at 85006b2 and
CALL-LOG-return-label.md):

1. **What the live call uniquely proves:** (a) the `platform-api.staging.quiqup.com`
   endpoint exists at the expected path `/slips/{slipType}`, (b) the Clerk→Quiqup
   JWT exchange works for this host and slip path, (c) the response is actually a
   PDF binary with the expected `Content-Type: application/pdf`. These are
   infrastructure questions, not code-correctness questions.

2. **What MSW unit tests already prove:** binary-envelope shape (resource+text
   dual-block), `api-version: 20180108` header forwarding, `Accept: application/pdf`
   header forwarding and override of the default `Accept: application/json`,
   `slipType` enum rejection, `order_ids` comma-separated wire format, 500-item cap,
   staging host routing, auth gate, no-guardrails. All 11 test cases pass.

3. **The `extraHeaders` mechanism is tested.** The `PlatformApiClient.request()`
   `extraHeaders` parameter was introduced in plan 05-03 Task 1 and has its own
   dedicated test file (`tests/clients/platform-api.test.ts`) with 5 cases covering
   verbatim forwarding, Accept override, omission-without-regression, backwards-compat,
   and multi-header simultaneous forwarding. The MSW capture directly asserts both
   `api-version: 20180108` AND `Accept: application/pdf` reach the wire.

4. **The Clerk auth piece is infrastructure.** The manual call primarily tests that
   the developer can log into Quiqdash staging — not that the tool code is correct.
   The code path (`getQuiqupReadyJwt` → Bearer → PlatformApiClient.request() →
   upstream) is identical to the already-verified paths in Phase 1–4 tools that
   use the same Platform client (`find_order_by_id_or_barcode`, `list_depots`,
   `list_missions_filter`, `create_internal_fulfilment_order`, `bulk_create_orders`,
   `create_mission`, `transfer_mission_orders`).

5. **Accepted risk:** the endpoint paths `GET /slips/picking-list` and
   `GET /slips/packing-list` were read from `docs/quiqup-api-full-frontend-extract.md`
   (§8 line 431-432 + §19 H lines 4733-4736). If the staging path differs, the tool
   will return a `QuiqupHttpError` with the upstream status — a labelled,
   agent-actionable error, not a silent failure.

## Follow-up required before production promotion

A real staging call SHOULD be made before this tool is promoted to production use.
The call should verify:

- `GET platform-api.staging.quiqup.com/slips/picking-list?order_ids=<real-staging-ids>`
  responds with `Content-Type: application/pdf`
- `GET platform-api.staging.quiqup.com/slips/packing-list?order_ids=<real-staging-ids>`
  also responds with `Content-Type: application/pdf` (BOTH enum branches)
- The `api-version: 20180108` header is forwarded and accepted by the staging upstream
- The base64 payload is non-empty
- The `filenameHint` (e.g. `picking-list-<id>.pdf` or `packing-list-<id>-and-N-more.pdf`)
  survives the round-trip

Until those calls are made and logged here, this tool should be treated as
**staging-unverified** in operational runbooks.

## Exemption scope

This waiver applies only to `download_slip` (MISS-06 / plan 05-03). It is issued
under the blanket Phase-5 deferral decision established for plan 05-01
(CALL-LOG-pending-labels.md committed at 85006b2).
