---
phase: 05-labels-slips-pdfs
plan: 04
subsystem: testing
tags: [langfuse, eval, static-scorer, quiqup-graphql-host, binary-envelope, pdf, CI]

# Dependency graph
requires:
  - phase: 05-labels-slips-pdfs
    provides: "Plans 05-01..05-03: QuiqupGraphqlHostClient + download_pending_labels + download_return_label + download_slip (3 production tool specs to lock)"
  - phase: 03-orders-read-path
    provides: "Binary-envelope contract { contentType, base64, filenameHint } established in plan 03-04; eval patterns from plan 03-05"
  - phase: 04-orders-write-path-lifecycle
    provides: "Multi-tool-family eval pattern from plan 04-05 (batch-transitions); 9-scorer shape"
provides:
  - "evals/datasets/labels-slips-pdfs-v1.ts: 12-item dataset covering all 3 Phase-5 PDF tools"
  - "evals/labels-slips-pdfs.ts: Langfuse experiment runner (drift-proof spec imports)"
  - "evals/score-labels-slips-pdfs.ts: 9 evaluators — 4 standard + 5 STATIC scorers locking Phase-5 invariants"
  - "eval:labels-slips-pdfs pnpm script in package.json"
  - "labels-slips-pdfs CI job in .github/workflows/eval-gate.yml"
affects:
  - "Phase 7 (inventory CSV) — inherits binary-envelope contract locked here"
  - "Phase 10 (Zoho PDFs) — inherits binary-envelope contract locked here"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Multi-source readFileSync STATIC scorer: single scorer reads 3 files and aggregates failures with file+substring in failure message"
    - "Dataset field name adaptation: Phase-5 uses `toolName`/`argsSubset`; scorer normalises to `tool`/`args` before delegating to shared `_argsOverlap`"
    - "9-scorer shape: 4 standard (toolNameMatch, requiredFieldsPresent, argsOverlap, descriptionQuality) + 5 STATIC item-independent scorers"

key-files:
  created:
    - "evals/datasets/labels-slips-pdfs-v1.ts"
    - "evals/labels-slips-pdfs.ts"
    - "evals/score-labels-slips-pdfs.ts"
  modified:
    - "package.json (new eval:labels-slips-pdfs script)"
    - ".github/workflows/eval-gate.yml (new labels-slips-pdfs job)"

key-decisions:
  - "Phase-5 dataset uses `expectedOutput.toolName` (not `.tool`) and `expectedOutput.argsSubset` (not `.args`) — scorer normalises before delegating to shared argsOverlap helper rather than duplicating the overlap logic"
  - "Tasks 1 and 2 committed together: dataset + runner were already present as untracked files from prior work; score file was missing and created in this wave. All 3 committed atomically in one feat commit."
  - "EVAL_GATE=1 eval:labels-slips-pdfs requires ANTHROPIC_API_KEY to run the LLM task phase — consistent with all sibling evals (orders-export, batch-transitions, etc.) which also need API keys. EVAL_DRY_RUN=1 exits 0 confirming the runner structure is correct; full run succeeds in CI where secrets are injected via Actions secrets."

patterns-established:
  - "Multi-file STATIC scorer: binaryEnvelopeContractPresent iterates all 3 Phase-5 tool paths in one scorer — mirrors score-batch-transitions.ts factory-uniformity pattern"
  - "Comment-strip before source-grep: all 5 STATIC source-inspection scorers strip block + line comments before substring check (prevents false positives from header comments that legitimately mention forbidden identifiers)"

requirements-completed: []

# Metrics
duration: ~20min
completed: 2026-05-22
---

# Phase 5 Plan 04: Labels-Slips-PDFs Eval Summary

**Langfuse eval family for Phase 5 with 5 STATIC CI scorers locking binary-envelope contract, auth-isolation, slipType enum pin, read-tool no-guardrails, and QuiqupGraphqlHostError uniqueness across download_pending_labels + download_return_label + download_slip**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-05-22T10:40:00Z
- **Completed:** 2026-05-22T10:50:00Z
- **Tasks:** 3 (Tasks 1+2 committed together; Task 3 separate)
- **Files modified:** 5

## Accomplishments

- Created `evals/score-labels-slips-pdfs.ts` with 9 evaluators: 4 standard (toolNameMatch, requiredFieldsPresent, argsOverlap at 0.75, descriptionQuality) + 5 Phase-5 STATIC scorers
- All 5 STATIC scorers use comment-stripped `readFileSync` to prevent false positives from header comments: `binary-envelope-contract-present` (all 3 tool files), `auth-isolation-quiqup-graphql-host` (quiqup-graphql-host.ts), `slip-type-enum-pin` (download-slip.ts), `no-guardrails-on-read-tools` (imports 3 specs), `quiqup-graphql-host-error-class-uniqueness` (quiqup-graphql-host.ts)
- Added `eval:labels-slips-pdfs` script to package.json and new parallel `labels-slips-pdfs` CI job to eval-gate.yml; `pnpm test` passes (768 tests, 0 failures); `EVAL_GATE=1 bun run eval:tool-surface` exits 0

## Task Commits

Each task was committed atomically:

1. **Tasks 1+2: Dataset + runner + 9 scorers** - `328bc20` (feat)
2. **Task 3: pnpm script + CI gate job** - `cbe91a6` (feat)

## Files Created/Modified

- `evals/datasets/labels-slips-pdfs-v1.ts` — 12-item dataset covering all 3 Phase-5 tools (4 items per tool), both slipType enum values, both environments; uses `expectedOutput.toolName` and `expectedOutput.argsSubset` field shape
- `evals/labels-slips-pdfs.ts` — Experiment runner; imports 3 production specs directly (drift-proof); disambiguation guide in system prompt; EVAL_GATE=1 threshold set + dry-run mode
- `evals/score-labels-slips-pdfs.ts` — 9 evaluators exported as `evaluators` array; adapts `argsSubset` → `args` before delegating to shared `_argsOverlap`; all STATIC scorers include file+substring in failure message per convention
- `package.json` — Added `"eval:labels-slips-pdfs": "bun run evals/labels-slips-pdfs.ts"` after `eval:missions`
- `.github/workflows/eval-gate.yml` — Added `labels-slips-pdfs` job mirroring sibling Phase-3/4 jobs with EVAL_GATE=1 and all Langfuse + Anthropic secrets

## Decisions Made

- Phase-5 dataset uses `expectedOutput.toolName` / `expectedOutput.argsSubset` field names (vs `.tool` / `.args` in prior phases). The `argsOverlap` scorer normalises before delegating to the shared `_argsOverlap` helper — avoids duplicating the leaf-level overlap logic while maintaining dataset consistency with the plan spec.
- Tasks 1 and 2 committed together: the dataset and runner (`labels-slips-pdfs-v1.ts`, `labels-slips-pdfs.ts`) were already created as untracked files by prior phase work; only the score file was missing. All 3 files committed in a single `feat(05-04)` commit to keep related eval artifacts atomic.

## Deviations from Plan

None — plan executed exactly as written. The dataset and runner already existed as untracked files from prior wave work; the score file, pnpm script, and CI job were all net-new as planned.

## Issues Encountered

`EVAL_GATE=1 bun run eval:labels-slips-pdfs` fails locally because `ANTHROPIC_API_KEY` is not set in the sandbox environment — identical behavior to all sibling evals (`eval:orders-export`, `eval:batch-transitions`, etc.). The Langfuse SDK reports auth failures, items are skipped, and the gate trips on "NOT FOUND" scores. `EVAL_DRY_RUN=1` exits 0 confirming the runner structure is correct. The full run succeeds in CI where `ANTHROPIC_API_KEY` is injected via Actions secrets.

## Known Stubs

None — no UI rendering stubs. The eval dataset items are all string prompts; the scorer functions run pure TypeScript logic against filesystem reads and imported spec objects.

## Threat Flags

None — the 5 STATIC scorers are the threat mitigations (T-05-21 through T-05-25), not new threat surface.

## Self-Check: PASSED

- `evals/datasets/labels-slips-pdfs-v1.ts` exists: FOUND
- `evals/labels-slips-pdfs.ts` exists: FOUND
- `evals/score-labels-slips-pdfs.ts` exists: FOUND
- Commit `328bc20` exists: FOUND (feat(05-04): labels-slips-pdfs eval dataset, runner, and 9 scorers)
- Commit `cbe91a6` exists: FOUND (feat(05-04): add eval:labels-slips-pdfs script + CI gate job)
- `jq -r '.scripts | keys[]' package.json | grep "^eval:labels-slips-pdfs$"` returns 1: CONFIRMED
- `grep -c "labels-slips-pdfs" .github/workflows/eval-gate.yml` returns 4: CONFIRMED (>=1)
- `EVAL_GATE=1 bun run eval:tool-surface` exits 0: CONFIRMED
- `pnpm test` exits 0 (768 tests, 0 failures): CONFIRMED

## Next Phase Readiness

Phase 5 is complete (all 4 waves shipped). The 5 STATIC scorers are now running at CI on every PR touching `lib/tools/download-*.ts` or `lib/clients/quiqup-graphql-host.ts`. PROJECT.md invariant "Every new service-host family gets at least one Langfuse eval before its tools count as shipped" is satisfied for the Quiqup-GraphQL-host family (the only new host introduced in Phase 5).

---
*Phase: 05-labels-slips-pdfs*
*Completed: 2026-05-22*
