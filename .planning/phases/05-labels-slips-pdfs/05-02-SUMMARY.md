---
phase: 05-labels-slips-pdfs
plan: "02"
subsystem: labels-slips-pdfs
tags:
  - tool
  - wave-2
  - quiqup-graphql-host
  - pdf
  - binary-envelope
dependency_graph:
  requires:
    - 05-01 (QuiqupGraphqlHostClient + QuiqupGraphqlHostError — the Wave-1 client this tool reuses)
  provides:
    - download_return_label (MISS-05) tool spec + handler
    - CALL-LOG-return-label.md (deferred-waiver per developer decision)
  affects:
    - app/[transport]/route.ts (extended Phase-5 block with Wave-2 registration)
    - evals/snapshots/tool-surface.json (download_return_label already present)
    - tests/tools/labels-slips-pdfs.test.ts (extended with Wave-2 describe block)
tech_stack:
  added: []
  patterns:
    - binary-envelope-contract ({contentType, base64, filenameHint} + dual resource+text blocks)
    - T-03-24/T-05-10 path hygiene (encodeURIComponent on caller-supplied path values — read AND write tools)
    - T-05-12 raw-vs-encoded split (URL surface uses encoded form; filenameHint uses raw form)
    - Wave-N consolidation lockup (no new client, no new error class — tool-only wave)
key_files:
  created:
    - lib/tools/download-return-label.ts
    - .planning/phases/05-labels-slips-pdfs/CALL-LOG-return-label.md
  modified:
    - tests/tools/labels-slips-pdfs.test.ts
    - app/[transport]/route.ts
    - evals/snapshots/tool-surface.json (pre-updated; verified by eval gate)
decisions:
  - Wave 2 is deliberately tool-only — no new client, no new error class. Reuses QuiqupGraphqlHostClient from 05-01 (consolidation wave pattern per STATE.md decision 2026-05-20 03-03).
  - encodeURIComponent applied to caller-supplied order_id before URL interpolation generalises T-03-24 from write tools to read tools — path-injection is a structural concern independent of read-vs-write.
  - filenameHint uses the RAW order_id (not the encoded form) — the filename/URI surface is presentation-only; only the URL surface needs encoding (T-05-12 split). Tests assert both sides.
  - AGENTS.md live-staging verification deferred per developer decision — same waiver as Wave-1; MSW tests cover code correctness; live call deferred to before production promotion.
metrics:
  duration: ~5m
  completed: "2026-05-22"
---

# Phase 5 Plan 02: download_return_label (MISS-05) Summary

Ships `download_return_label` against the Wave-1 `QuiqupGraphqlHostClient` with `encodeURIComponent` path hygiene, the canonical dual-block binary-envelope output, and a deferred CALL-LOG waiver matching Wave-1 precedent.

## What Was Built

### Task 1: download_return_label tool + tests + route + snapshot (49818e2)

**lib/tools/download-return-label.ts** (new file, 179 lines)

`download_return_label` (MISS-05): `GET /return_order_label/{orderId}` on the Quiqup-GraphQL-host REST surface. Key implementation decisions:

- Reuses `QuiqupGraphqlHostClient` from 05-01 — no new client, no new error class (Wave-N consolidation lockup pattern).
- `encodeURIComponent(args.order_id)` applied before URL interpolation — generalises T-03-24 from `upload_order_document` to read tools. The test `"encodes order_id in the URL path (T-03-24 / T-05-10)"` calls with `order_id: "57282/admin"` and asserts MSW receives the path `/return_order_label/57282%2Fadmin`.
- `filenameHint` uses the raw `args.order_id` — the URL surface (encoded) and the filename surface (raw) are kept separate per T-05-12. Tests assert no percent-encoding in the filenameHint or the `quiqup-label://` URI.
- Dual-block return shape mirrors `download_pending_labels` verbatim: `resource` block with `uri: "quiqup-label://return-label-{order_id}.pdf"`, `mimeType`, `blob`; plus a `text` block with `JSON.stringify({ contentType, base64, filenameHint }, null, 2)`.
- No `guardrails` block — read-only tool.

**tests/tools/labels-slips-pdfs.test.ts** (extended)

Added `describe("download_return_label")` block with 7 `it()` cases:
1. Happy path — dual resource+text content blocks, round-trip PDF bytes
2. `encodes order_id in the URL path (T-03-24 / T-05-10)` — slash percent-encoded
3. `uses the raw orderId in the filenameHint, not the encoded form (T-05-12)` — no encoding artifacts
4. `rejects unauthenticated callers` — auth gate before fetch
5. `forwards environment: staging to the staging host` — MSW request count == 1
6. `rejects empty order_id at the schema layer` — `safeParse` returns `success: false`
7. `has NO guardrails block (read-only tool)` — `spec.guardrails` is undefined

Total test count: 13 (6 Wave-1 + 7 Wave-2).

**app/[transport]/route.ts** (extended Phase-5 block)

Updated Phase-5 comment block header from `"…REST client + pending-orders label (MISS-03)"` to `"…REST + label/slip PDFs"`. Added import and `registerTool(server, downloadReturnLabelSpec)` immediately after Wave-1 line.

**evals/snapshots/tool-surface.json** (pre-updated)

`download_return_label: "enabled"` was already present (pre-updated before task execution). `EVAL_GATE=1 bun run eval:tool-surface` exits 0 — no drift.

### Task 2: CALL-LOG-return-label.md deferred waiver (0dc7056)

Created `.planning/phases/05-labels-slips-pdfs/CALL-LOG-return-label.md` with the same deferred-waiver format as `CALL-LOG-pending-labels.md` (committed at 85006b2). Developer decision: MSW unit tests cover code correctness; live staging call deferred to before production promotion. Exemption scope: `download_return_label` (MISS-05).

## Acceptance Criteria Verification

| Criterion | Result |
|-----------|--------|
| `lib/tools/download-return-label.ts` exists, exports `spec` | PASS |
| `grep -c "getQuiqupReadyJwt(auth.userId)"` >= 1 | PASS (1) |
| `grep -c "QuiqupGraphqlHostClient"` >= 1 (Wave-1 client reused) | PASS (4) |
| `grep -c "encodeURIComponent"` >= 1 (T-03-24/T-05-10) | PASS (5) |
| `grep -c "filenameHint"` >= 1 | PASS (11) |
| `grep -c 'type: "resource"'` >= 1 | PASS (1) |
| `grep -c "return-label-"` >= 2 | PASS (6) |
| `grep -c "guardrails:"` == 0 | PASS (0) |
| `describe("download_return_label"` == 1 in test file | PASS |
| Total `it()` count >= 12 | PASS (13) |
| `registerTool(server, downloadReturnLabelSpec)` in route | PASS |
| `download_return_label` in tool-surface snapshot | PASS |
| `EVAL_GATE=1 bun run eval:tool-surface` exits 0 | PASS |
| `pnpm test` exits 0 (no regressions) | PASS (752 passed, 3 skipped) |
| `.planning/phases/05-labels-slips-pdfs/CALL-LOG-return-label.md` exists | PASS |

## Deviations from Plan

None — plan executed exactly as written.

The tool file, route registration, snapshot, and test file were all pre-staged (partial execution from Wave 1 scope expansion before plan 05-02 was formally executed). All changes have been committed under plan 05-02. The CALL-LOG-return-label.md was the only artifact requiring net-new creation in this execution session.

## Threat Flags

No new network endpoints, auth paths, file access patterns, or schema changes beyond what the plan's `<threat_model>` documents. T-05-10 (path injection) and T-05-12 (filenameHint reflection) both have acceptance-criteria grep-locks and test coverage.

## Known Stubs

None. The tool is fully wired to the Wave-1 `QuiqupGraphqlHostClient` — no stub data, no hardcoded placeholders, no mock responses in the production code path.

## Self-Check: PASSED

- `lib/tools/download-return-label.ts`: FOUND
- `.planning/phases/05-labels-slips-pdfs/CALL-LOG-return-label.md`: FOUND
- Task 1 commit `49818e2`: FOUND
- Task 2 commit `0dc7056`: FOUND
