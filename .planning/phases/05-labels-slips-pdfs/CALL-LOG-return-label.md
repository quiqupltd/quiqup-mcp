# CALL-LOG: download_return_label live-staging verification (Phase 5 / 05-02)

## Status: DEFERRED — developer decision

**Date:** 2026-05-22
**Decision owner:** svetoslav@quiqup.com

## Waiver rationale

The AGENTS.md mandatory live-staging-call rule requires a real `POST
http://localhost:3000/mcp tools/call` invocation against
`graph.staging.quiqup.com` using a Clerk OAuth `at+jwt` from an active
Quiqdash staging session.

After discussion, the developer decided to defer this verification with the
following reasoning (identical rationale as the Wave-1 waiver in
`CALL-LOG-pending-labels.md` — both tools sit behind the same
`QuiqupGraphqlHostClient` infrastructure and the same Clerk→Quiqup JWT
exchange):

1. **What the live call uniquely proves:** (a) the `graph.staging.quiqup.com`
   endpoint exists at the expected path `/return_order_label/{orderId}`, (b)
   the Clerk→Quiqup JWT exchange works for this host, (c) the response is
   actually a PDF binary for a staging order in return state. These are
   infrastructure questions, not code-correctness questions.

2. **What MSW unit tests already prove:** binary-envelope shape (dual
   resource+text blocks), path-encoding hygiene (`encodeURIComponent` applied
   to `order_id` before URL interpolation — T-05-10), raw order_id in
   filenameHint (T-05-12 split), auth gate (401 before JWT mint), schema
   validation (empty order_id rejected), staging host routing, no guardrails
   on a read-only tool. All 7 test cases in the
   `describe("download_return_label")` block pass.

3. **The Clerk auth piece is infrastructure.** The manual call primarily
   tests that the developer can log into Quiqdash staging — not that the
   tool code is correct. The code path (`getQuiqupReadyJwt` → Bearer →
   upstream) is identical to the already-verified paths in Phase 2–4 tools
   (same V3b Clerk→Quiqup exchange, same `QuiqupHttpError` envelope), and is
   shared with the Wave-1 `download_pending_labels` tool on this exact host.

4. **Accepted risk:** the endpoint path `GET /return_order_label/{orderId}`
   was read from `docs/quiqup-api-full-frontend-extract.md` (§8 line 428–429
   + §19 H lines 4730–4731). If the staging path differs or if the staging
   order chosen has no return label (404), the tool will return a
   `QuiqupGraphqlHostError` with the upstream status — a labelled,
   agent-actionable error, not a silent failure. The 404 path is explicitly
   documented in the tool's error-modes description.

## Live-staging call template (for future use)

When the live call is eventually performed, it should use:

```
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer <Clerk-OAuth-at+jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "download_return_label",
      "arguments": { "order_id": "<staging-orderId-in-return-state>", "environment": "staging" }
    }
  }'
```

Expected successful response shape:
- HTTP 200
- `result.content[0].type === "resource"`
- `result.content[0].resource.mimeType === "application/pdf"`
- `result.content[0].resource.uri === "quiqup-label://return-label-<orderId>.pdf"`
- `result.content[1].type === "text"` with `filenameHint: "return-label-<orderId>.pdf"`
- `result.content[0].resource.blob` is a non-empty base64 string

## Follow-up required before production promotion

A real staging call SHOULD be made before this tool is promoted to
production use. The call should verify:

- `GET graph.staging.quiqup.com/return_order_label/{orderId}` responds
  with `Content-Type: application/pdf` for an order in return state
- The base64 payload is non-empty
- The `filenameHint: "return-label-{orderId}.pdf"` survives the round-trip
- No path-encoding artefacts appear in the returned URI or filenameHint

Until that call is made and logged here, this tool should be treated as
**staging-unverified** in operational runbooks.

## Exemption scope

This waiver applies only to `download_return_label` (MISS-05 / plan 05-02).
Plan 05-03 (`download_slip`) is also subject to AGENTS.md and will be handled
with the same deferred approach unless the developer performs the call during
execution of that plan.
