---
phase: 05-labels-slips-pdfs
plan: "03"
subsystem: labels-slips-pdfs
tags:
  - platform-api
  - pdf
  - binary-response
  - extra-headers
  - enum-locked-path
dependency_graph:
  requires:
    - 05-01 (QuiqupGraphqlHostClient + download_pending_labels)
    - 05-02 (download_return_label)
  provides:
    - download_slip tool (MISS-06)
    - PlatformApiClient.request() extraHeaders parameter (foundation for Phase 8 SHIP-02)
  affects:
    - app/[transport]/route.ts (new tool registration)
    - evals/snapshots/tool-surface.json (95 tools total)
tech_stack:
  added: []
  patterns:
    - extraHeaders parameter on PlatformApiClient.request() — spread-last for caller
      override of default Accept/Content-Type headers
    - slipType z.enum(["picking-list","packing-list"]) path-parameter lock
    - filenameHint convention — single vs multi-order deterministic naming
key_files:
  created:
    - lib/tools/download-slip.ts
    - .planning/phases/05-labels-slips-pdfs/CALL-LOG-download-slip.md
  modified:
    - lib/clients/platform-api.ts (already modified in Task 1 / commit 9cdec17)
    - tests/clients/platform-api.test.ts (already modified in Task 1 / commit 9cdec17)
    - tests/tools/labels-slips-pdfs.test.ts
    - app/[transport]/route.ts
    - evals/snapshots/tool-surface.json
decisions:
  - "2026-05-22 (05-03): download_slip uses PlatformApiClient (not QuiqupGraphqlHostClient
    from Waves 1-2) because Platform host (platform-api.quiqup.com) is the correct egress
    target for /slips/... — Wave 3 is the first Phase-5 tool that diverges from the
    Quiqup-GraphQL-host family introduced in Waves 1 and 2."
  - "2026-05-22 (05-03): The extraHeaders parameter spreads LAST in PlatformApiClient.request()
    so callers can override both Accept: application/json (needed for PDF) and Content-Type.
    Known footgun: Authorization could also be overridden; documented as T-05-16 with a
    comment in the method header. download_slip does NOT pass Authorization in extraHeaders."
  - "2026-05-22 (05-03): CALL-LOG-download-slip.md is a deferred waiver per the blanket
    Phase-5 deferral decision established at 85006b2 for plan 05-01. The same rationale
    applies: the code path (getQuiqupReadyJwt → Bearer → PlatformApiClient → upstream) is
    identical to already-verified Phase 1-4 Platform tools."
metrics:
  duration: ~15m
  completed: 2026-05-22
  tasks_completed: 3
  files_changed: 7
---

# Phase 5 Plan 03: download_slip (MISS-06) + PlatformApiClient extraHeaders Summary

**One-liner:** `download_slip` ships against the Platform host via `PlatformApiClient.request()` extended with a backwards-compatible `extraHeaders` parameter that spreads last, sending `api-version: 20180108` + `Accept: application/pdf`, with `slipType` z.enum-locked to `picking-list|packing-list` and `order_ids` capped at 500.

## What Was Built

### Task 1 (pre-committed at 9cdec17): PlatformApiClient.request() extraHeaders extension

- `lib/clients/platform-api.ts`: Extended `request()` `init` parameter with optional `extraHeaders?: Record<string, string>` spread LAST in the headers literal. The existing ~30 Phase 1-4 call sites are unchanged — when `extraHeaders` is absent the method is identical to its pre-Phase-5 form. Header comment documents: the spread-last precedence rule, the Phase-5 `download_slip` use case (api-version: 20180108 + Accept: application/pdf), and the Phase-8 SHIP-02 reservation (x-api-version: 20240101).
- `tests/clients/platform-api.test.ts`: 5 `it()` cases — forwards verbatim, overrides default Accept, omission leaves defaults intact, backwards-compat Phase-1 caller shape (no empty key from spread), multi-header simultaneous forwarding.

### Task 2 (committed at af471d7): download_slip tool + tests + route + snapshot

- `lib/tools/download-slip.ts`: `GET /slips/${slipType}?order_ids=<csv>` against `platform-api.quiqup.com` (or `.staging.`). Uses `PlatformApiClient` (NOT `QuiqupGraphqlHostClient`); `slipType` is `z.enum(["picking-list","packing-list"])`; `order_ids` is array with `.min(1)` / `.max(500)`, joined as CSV via `order_ids.join(",")`. Sends `extraHeaders: { "api-version": "20180108", Accept: "application/pdf" }`. Returns dual-block resource+text envelope mirroring Waves 1 and 2 verbatim. filenameHint: `<slipType>-<id>.pdf` (single) or `<slipType>-<id>-and-<N-1>-more.pdf` (multi). No guardrails block.
- `tests/tools/labels-slips-pdfs.test.ts`: Appended `describe("download_slip")` block with 11 `it()` cases — happy path dual-block envelope, single-order filenameHint, api-version + Accept headers forwarded, 3 enum-rejection variants, empty order_ids, 501 order_ids cap, CSV query encoding, packing-list routing, staging host, auth gate, no-guardrails.
- `app/[transport]/route.ts`: Added `import { spec as downloadSlipSpec }` and `registerTool(server, downloadSlipSpec)` in Phase-5 block.
- `evals/snapshots/tool-surface.json`: Added `"download_slip": "enabled"` (95 tools total, alphabetically sorted). `EVAL_GATE=1 bun run eval:tool-surface` exits 0.

### Task 3 (committed at ce03b83): CALL-LOG deferred waiver

- `.planning/phases/05-labels-slips-pdfs/CALL-LOG-download-slip.md`: Deferred-waiver per blanket Phase-5 developer decision (established at 85006b2 for plan 05-01). Exemption scope: `download_slip` (MISS-06). Same rationale: code path is identical to verified Phase 1-4 Platform tools; real staging call deferred until production promotion.

## Test Results

- `pnpm vitest run tests/clients/platform-api.test.ts tests/tools/labels-slips-pdfs.test.ts`: 29 passed (5 client + 24 tool tests — 6 Wave-1 + 7 Wave-2 + 11 Wave-3)
- `pnpm test` (full suite): 768 passed | 3 skipped — 0 regressions
- `EVAL_GATE=1 bun run eval:tool-surface`: exits 0, no drift

## Deviations from Plan

None — plan executed exactly as written. Task 1 was already committed before this execution started (commit 9cdec17); Task 2 and Task 3 were executed in order.

The `pnpm tsc --noEmit` TypeScript check surfaces 8 pre-existing errors in `tests/evals/score-tool-call.test.ts` (unrelated to this plan — `Evaluation | Evaluation[]` union narrowing); these were present before this plan began (verified by stash check). No new TypeScript errors were introduced by this plan's changes.

## Threat Surface Scan

No new network endpoints, auth paths, or schema changes beyond what the plan specified:
- `download_slip` adds one GET path against the existing Platform host family — no new service host
- `extraHeaders` parameter on `PlatformApiClient.request()` is internal plumbing, not a new egress path
- T-05-16 (Authorization footgun in extraHeaders) is documented in the method header comment

## Self-Check: PASSED

| Artifact | Status |
|----------|--------|
| `/home/user/quiqup-mcp/lib/tools/download-slip.ts` | FOUND |
| `/home/user/quiqup-mcp/.planning/phases/05-labels-slips-pdfs/CALL-LOG-download-slip.md` | FOUND |
| Commit 9cdec17 (Task 1 — extraHeaders) | FOUND |
| Commit af471d7 (Task 2 — download_slip tool) | FOUND |
| Commit ce03b83 (Task 3 — CALL-LOG deferred waiver) | FOUND |
| `pnpm test` 768 passed | PASSED |
| `EVAL_GATE=1 bun run eval:tool-surface` | PASSED |
