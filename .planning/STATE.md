# State: Quiqup MCP — Full Frontend API Coverage

**Initialized:** 2026-05-19

## Project Reference

- **Core value:** Every backend endpoint that powers Quiqdash v3 must be reachable from an LLM via a single MCP server, with the same auth, the same error semantics, and the same observability as the existing staging-verified tools.
- **Current focus:** Phase 5 — Labels, Slips & PDFs (Quiqup-GraphQL-host REST client + base64 PDF response pattern; pending-label, return-label, slip downloads — reuses the Phase-3 binary-envelope contract { contentType, base64, filenameHint })

## Current Position

- **current_phase:** 6 (next — Inbound completion + Fulfilment gaps)
- **current_plan:** 06-01 (next — pending planning)
- **status:** Phase 5 EXECUTED (4/4 plans shipped 2026-05-22). Phases 1-5 all done.
- **progress:** Phase 5 closed 2026-05-22 — 3 new tools shipped: download_pending_labels (MISS-03), download_return_label (MISS-05), download_slip (MISS-06). New Quiqup-GraphQL-host REST client (QuiqupGraphqlHostClient + QuiqupGraphqlHostError); PlatformApiClient extended with backwards-compat extraHeaders; binary-envelope contract { contentType, base64, filenameHint } locked at CI by 5 new STATIC scorers in eval:labels-slips-pdfs. 768 passed | 3 skipped | 0 regressions. Live-staging CALL-LOGs deferred (developer decision 2026-05-22 — to be completed before production promotion). 95 tools total.

```
[████████████        ] 50% (Phases 1-5 of 10 complete)
```

## Performance Metrics

- Phases completed: 5 (Phase 1 + Phase 2 + Phase 3 + Phase 4 + Phase 5)
- Plans completed: 24 (01-01..01-04, 02-01..02-06, 03-01..03-05, 04-01..04-05, 05-01..05-04)
- Requirements shipped (v1): see REQUIREMENTS.md (Phase 5 added 3 tools: MISS-03/05/06 — all locked at CI via plan 05-04 STATIC scorers).
- Service-host families with Langfuse eval: 14 (4 Phase-1 + 5 Phase-2 + 4 Phase-3 + 0 Phase-4 + 1 Phase-5: Quiqup-GraphQL-host).
- New service hosts introduced in Phase 5: 1 (Quiqup-GraphQL-host REST surface — graph.quiqup.com / graph.staging.quiqup.com).

### Plan Execution Log

| Phase | Plan | Duration | Tasks | Files | Completed |
| ----- | ---- | -------- | ----- | ----- | --------- |
| 01    | 01   | 3m 47s   | 2     | 11    | 2026-05-19 |
| 01    | 02   | ~       | ~     | ~     | 2026-05-19 |
| 01    | 03   | ~12m    | 3     | 8     | 2026-05-19 |
| 01    | 04   | ~10m    | 3     | 8     | 2026-05-19 |
| 02    | 01   | ~25m    | 3     | 8     | 2026-05-19 |
| 02    | 02   | ~10m    | 3     | 9     | 2026-05-19 |
| 02    | 03   | ~25m    | 3     | 9     | 2026-05-19 |
| 02    | 04   | ~20m    | 3     | 9     | 2026-05-19 |
| 02    | 05   | ~15m    | 3     | 6     | 2026-05-19 |
| 02    | 06   | ~25m    | 3     | 17    | 2026-05-19 |
| 03    | 01   | ~10m    | 3     | 6     | 2026-05-19 |
| 03    | 02   | ~15m    | 3     | 6     | 2026-05-19 |
| 03    | 03   | ~3m     | 2     | 5     | 2026-05-20 |
| 03    | 04   | ~10m    | 3     | 10    | 2026-05-20 |
| 03    | 05   | ~25m    | 3     | 14    | 2026-05-20 |
| 04    | 01   | ~17m    | 3     | 11    | 2026-05-20 |
| 04    | 02   | ~16m    | 3     | 11    | 2026-05-21 |
| 04    | 03   | ~17m    | 3     | 5     | 2026-05-21 |
| 04    | 04   | ~16m    | 4     | 12    | 2026-05-21 |
| 04    | 05   | ~15m    | 4     | 14    | 2026-05-21 |
| 05    | 01   | ~10m    | 3     | 7     | 2026-05-22 |
| 05    | 02   | ~5m     | 2     | 5     | 2026-05-22 |
| 05    | 03   | ~15m    | 3     | 7     | 2026-05-22 |
| 05    | 04   | ~20m    | 3     | 5     | 2026-05-22 |

## Accumulated Context

### Decisions

- 2026-05-19: Phase grouping follows service-host families (one phase per family or close cluster) — minimizes infra/client churn within a phase.
- 2026-05-19: Phase 12 ("Eval Coverage Pass") is a dedicated invariant-validation phase rather than spreading evals into each feature phase, because eval authoring benefits from cross-family pattern consistency.
- 2026-05-19: AUTH-07 (`update_account`) and FIN-05 (`update_bank_details`) hit the same PUT /accounts endpoint with different payload constraints — modeled as two distinct tools with disambiguating descriptions; collision resolved during Phase 10 planning.
- 2026-05-19: SRVR-01 / SRVR-02 expose-or-keep-internal decision deferred to Phase 11 plan.
- 2026-05-19 (01-01): Output schemas for the seven Phase-1 read tools left as `z.object({}).passthrough()` — payloads are partner-shape-dependent; tightening risks false rejects when upstream adds fields. M4 will retroactively harden as needed.
- 2026-05-19 (01-01): `get_account_capabilities.id` defaults to `"me"` (matches QuiqDash boot-time call shape); `get_account_by_id.id` has no default so admin/impersonation calls are always explicit.
- 2026-05-19 (01-01): Tool-surface snapshot pre-existing drift (`update_order_waypoint` missing from baseline despite being registered since PR #13) auto-fixed under Rule 3 to unblock EVAL_GATE verification.
- 2026-05-19 (01-04): Evals import production `spec.description` directly (no inline copies) — drift between live tool description and eval-time description is structurally impossible. Replaces the `recent-orders.ts` maintenance-comment pattern.
- 2026-05-19 (01-04): `auth-isolation` scorer in `score-lookup-google-place.ts` strips line + block comments before substring-checking — both `lib/tools/lookup-google-place.ts` and `lib/clients/google-places.ts` legitimately mention `getQuiqupReadyJwt` in header comments to document the auth-exception (the very thing the scorer locks in).
- 2026-05-19 (01-04): New `.github/workflows/eval-gate.yml` is distinct from `evals.yml` (lastmile suite, staging side effects). eval-gate.yml runs tool-surface + the two new family evals; lastmile remains gated in evals.yml to avoid duplicated CI secret usage.
- 2026-05-19 (02-02): `setup_shopify_callback` POSTs with all 3 params (shop_name, code, is_fulfillment) on the QUERY STRING — no JSON body. Description grep-locks the "single-use" OAuth-code warning per T-02-13; test asserts the empty body + absent Content-Type header.
- 2026-05-19 (02-02): `update_shopify_connection.token` marked SENSITIVE in the tool description (T-02-12); audit middleware already redacts the `token` key via ALWAYS_REDACT_KEYS at the at-rest layer; description-quality grep-lock prevents the wording from regressing.
- 2026-05-19 (02-02): `update_shopify_connection` rate limit set to 5/min (matching create_account_team_member privilege-escalation guardrail) — connection-credential mutations should be rare; rapid-fire calls almost certainly indicate misuse.
- 2026-05-19 (02-02): `update_shopify_config.wms_delay_minutes` bounded to [0, 10080] (1 week) per T-02-14 — prevents an LLM from setting an effectively-infinite delay that would freeze WMS pickup.
- 2026-05-19 (02-04): `get_salla_connection` strips upstream `token` field via destructure-and-discard (T-02-29). Locked in by .strict() output schema + canary regression test ("SECRET-TOKEN-DO-NOT-LEAK") + description-pin. Canonical Salla-vs-Shopify difference — Shopify exposes token on update_shopify_connection (merchant input); Salla NEVER exposes token (Quiqup-internal secret).
- 2026-05-19 (02-04): `get_salla_config` returns STRUCTURED `{ config: null, message }` on upstream 404 rather than throwing QuiqupHttpError (T-02-30). 404 here means "no config saved yet" — agent can immediately call `update_salla_config` without parsing an HTTP error. All other non-2xx (401/403/422/5xx) still throw.
- 2026-05-19 (02-04): `update_salla_config.delivery_methods[].service_kind` is z.string() (free-form) with description-pin to `list_service_kinds` (Phase 1 AUTH-08). Per threat-register T-02-33 accept disposition — duplicating the enum would create drift surface for a read-time taxonomy that may grow.
- 2026-05-19 (02-04): INTG-22 (`delete_salla_connection`) deliberately deferred to plan 02-05 — it requires the canonical `confirm:true` destructive gate that the next wave establishes.
- 2026-05-19 (02-05): The canonical destructive-gate helpers (`requireConfirm`, `destructiveConfirmField`, `destructiveDryRunField`, `isDryRun`, `ConfirmationRequiredError`, `buildConfirmationRequiredResult`) ship at `lib/middleware/destructive.ts`. Future destructive tools in Phases 4 (batch status transitions), 6 (cancel_inbound + delete_products), 8 (delete_dispatcher_rule_set), 10 (delete_stripe_payment_method) MUST import these exports rather than re-deriving the contract — uniform LLM behaviour across the destructive surface depends on it.
- 2026-05-19 (02-05): Destructive tools layer auth BEFORE confirm BEFORE dry_run BEFORE upstream call (T-02-37/38/39). `dry_run` cannot bypass `confirm` — to exercise dry-run the caller MUST set `confirm: true` AND `dry_run: true`. Semantic: dry-run is "I have already confirmed; show me what would happen" — not "skip confirm because I'm only previewing".
- 2026-05-19 (02-05): Rate limit on destructive tools set to TIGHT 3/min (matching `cancel_lastmile_orders_batch`) — deletions are irreversible and rare-by-design. Combined with `confirm: true` requirement, a runaway agent cannot sweep connections.
- 2026-05-19 (02-05): MSW request-count assertion on the negative paths (confirm missing / confirm:false / missing auth) proves the gate runs client-side — ZERO upstream traffic on any rejected destructive call.
- 2026-05-19 (02-05): PROJECT.md "Destructive endpoints gated with explicit confirmation parameters" key-decision row can now flip from `[ ]` to `[x]` — flagged for the user to flip in a project-status pass (do NOT flip from inside this plan).
- 2026-05-19 (02-06): Five Langfuse evals shipped — one per Phase-2 sub-family (shared / shopify / woocommerce / salla / destructive). PROJECT.md "Every new service-host family gets at least one Langfuse eval before its tools count as shipped" invariant is satisfied at the sub-family granularity for all of Phase 2.
- 2026-05-19 (02-06): Three new STATIC source-inspection scorer patterns established for Phase 2 onwards (token-omission, four-oh-four-as-null, confirm-gate-present). These are the canonical "lock production invariants at the CI layer" approach — readFile() the source and assert substrings, OR import a helper and assert Zod-instance identity. Future phases with similar must-haves SHOULD reuse this pattern. Mirrors plan 01-04 Task 2 Step B (auth-isolation on lookup-google-place).
- 2026-05-19 (02-06): EVAL_GATE thresholds calibrated per-family — args-overlap 0.7 for shared (8-arg repair tool) and destructive (no-literal-confirm prompt elicitation noise); 0.75 for shopify/woocommerce/salla. All STATIC item-independent scorers (description-quality, sensitive-and-single-use-language, quiqup-vs-woocommerce-state-disambiguation, token-omission, four-oh-four-as-null, confirm-gate-present) pinned at 1.0.
- 2026-05-19 (03-01): Orders Core GraphQL is a NEW service host (`orders-api.quiqup.com/graph` prod, `orders-api.staging.quiqup.com/graph` staging). Canonical client lives at `lib/clients/orders-core-graphql.ts` with `QUIQUP_ORDERS_GRAPH_URL` / `QUIQUP_ORDERS_GRAPH_STAGING_URL` env overrides; every future GraphQL-host tool in this project MUST import from this module rather than re-implementing wire concerns.
- 2026-05-19 (03-01): GraphQL `errors[]` in HTTP 200 responses are returned to the caller verbatim — NOT auto-thrown. Partial-success is a documented GraphQL pattern (spec §7.1) and Relay (used by Quiqdash) treats partial-data + errors as a valid response; auto-throwing would discard data the agent may still want. Tools surface both `data` and `errors` in their text output so the LLM can decide whether the response is actionable. Locked in by the client-level "returns { data, errors } as-is" test and tool-level "surfaces GraphQL errors[]" tests on both ORDL-02 and ORDL-03.
- 2026-05-19 (03-01): The Orders Core GraphQL client deliberately reuses `QuiqupHttpError` and the Clerk → Quiqup session-JWT bearer model — NOT the `google-places.ts` API-key auth exception. Orders Core is a first-party Quiqup service; the auth-exception pattern is reserved for the truly-third-party Google host. Locked in by a `grep -c "X-Goog-Api-Key\|api_key\|apiKey" lib/clients/orders-core-graphql.ts` == 0 acceptance check.
- 2026-05-19 (03-01): `lookup_orders_ids.orderBy.field` is `z.literal("SUBMITTED_AT")` — the Quiqdash frontend hard-codes this; free-string would let an LLM probe undocumented sort fields (threat T-03-04). If Quiqdash extends the enum in future this widens with explicit review.
- 2026-05-19 (03-01): `bulk_orders_lookup.client_order_ids` cap of 200 matches the upstream `bulkOrdersLookupQuery`'s `first: 200` hard-code. Mirroring the cap at the schema layer rejects over-large requests client-side instead of letting them be silently truncated upstream.
- 2026-05-20 (03-03): Phase-3 Wave 3 is a consolidation wave — three Platform-API read tools (`find_order_by_id_or_barcode`, `list_depots`, `list_missions_filter`) reuse the existing `getPlatformApiBaseUrl + getQuiqupReadyJwt + Bearer header + QuiqupHttpError` plumbing. NO new service client introduced. Establishes the "Wave-N consolidation lockup" pattern: when a wave introduces only tools and no new infrastructure, the SUMMARY documents the absence as a deliberate decision.
- 2026-05-20 (03-03): `find_order_by_id_or_barcode.intention` is a free-form `z.string().min(1)` (NOT a `z.enum`) — the upstream BE may add new transitions over time and over-constraining the client would silently break new intentions the moment Quiqup ships them. The description enumerates the observed-set (13 values from `app/hooks/order/use-bulk-change-state.ts`); bad inputs surface via the upstream structured 200-with-error envelope. T-03-19 accept disposition.
- 2026-05-20 (03-03): `list_depots` translates snake_case `main_depot` (MCP-side input field) → camelCase `mainDepot` (upstream wire-format query key) inside the handler. Booleans serialised via `String(args.main_depot)` to produce the literal `"true"`/`"false"` strings Go BE parses. Tested at both layers: schema-rejection of empty values, MSW assertion that the outbound URL carries `mainDepot=true`. Establishes the "wire-format translation testing" pattern for future tools where MCP-side naming diverges from upstream.
- 2026-05-20 (03-03): `find_order_by_id_or_barcode` no-match path is a 200 with `error` populated, NOT an HTTP 4xx — handler returns the upstream envelope verbatim (no exception, no `isError` flag). Rationale: the LLM needs to see the error message to route to the next step (e.g. ask the operator for a different ID); raising an exception would lose that information. T-03-20 accept disposition for the full-envelope read.
- 2026-05-20 (03-04): Canonical binary-response envelope locked in as `{ contentType, base64, filenameHint }` — Phase 5 (PDF labels), Phase 7 (inventory CSV), Phase 10 (Zoho PDFs) MUST reuse this exact shape verbatim rather than re-deriving a per-host envelope. Client layer returns the two-field `{ contentType, base64 }`; tool layer adds `filenameHint`. Ex-core's CSV export is the anchor implementation.
- 2026-05-20 (03-04): Orders Core REST host resolver implements the FE-aligned fallback chain `ORDERS_API_BASE_URL → QUIQUP_ORDERS_GRAPH_URL minus /graph → canonical` (source-doc §1 line 21). Preserves the dev ergonomic where ONE env var (`QUIQUP_ORDERS_GRAPH_URL=https://localhost.test/graph`) redirects BOTH the 03-01 GraphQL client AND this REST client to the same dev host. Per-environment overrides honoured (prod override does not affect staging).
- 2026-05-20 (03-04): `OrdersCoreRestClient.requestMultipart` deliberately omits the `Content-Type` header — fetch() sets `multipart/form-data; boundary=<random>` automatically from the FormData body. Manual override clobbers the boundary and the upstream rejects the body. Locked in by a runtime test that captures the outbound Content-Type and asserts `startsWith("multipart/form-data")` AND `contains("boundary=")`. This is the canonical multipart pattern for any future MCP tool uploading binary payloads.
- 2026-05-20 (03-04): `upload_order_document` (ORDS-08) is the first write tool in Phase 3 — carries the BL-01 canonical guardrails block (rateLimit 10/min, idempotency on idempotency_key with 15min TTL, audit:true) AND structurally omits user_id/actor_id/actor_email from its input schema (BL-04 server-binding — identity bound to auth.userId at handler level). Pre-flight 10MB cap (13_500_000 base64 chars) enforced BEFORE JWT mint AND BEFORE FormData construction so abusive callers cost the MCP nothing upstream.
- 2026-05-20 (03-04): Ex-core gets a SEPARATE ExCoreError class (not QuiqupHttpError reuse) — distinct service host with its own operational backstop, even though the auth bridge is shared. Mirrors QuiqupHttpError's shape (status + body) so callers branch on err.status uniformly. Conversely, Orders Core REST reuses QuiqupHttpError because Orders Core is a Quiqup-prefixed service and the registerTool wrapper's QuiqupHttpError → MCP-error mapping is the desired behaviour. Establishes the policy: NEW service-host families get their own error class; sibling clients of an existing host family reuse the existing class.
- 2026-05-21 (04-05): Plan-level eval-coverage pattern for phases that introduce no new service hosts — group by tool-FAMILY rather than per-host. Phase 4 introduced 0 new hosts but 20 new tools across 4 families (batch-transitions, single-order-mutations, order-creation, missions); each family ships its own Langfuse eval + at least one STATIC scorer locking the family's critical decisions at CI. Mirrors how 03-05 combined Quiqup REST + Audit (same-host, different sub-surfaces) into one family eval.
- 2026-05-21 (04-05): STATIC scorer prefix-matching pattern (e.g. `confirm.description.startsWith("DESTRUCTIVE-GATE:")`) is preferred over strict Zod-instance identity for batch-style locks. Phase-2's destructive-integrations scorer asserts strict instance equality for 2 delete tools; that's pragmatic for a small surface. For Phase-4's 14 destructive tools — many built via factory which legitimately wraps the canonical helper — prefix-matching is the structural assertion that survives factory composition while still tripping on any non-canonical replacement.
- 2026-05-21 (04-05): D-02 reason-field-pin scorer accepts the `list_*_reasons` enumeration-tool name appearing in EITHER `spec.description` OR the reason-field's own description. Locks D-02 ("the reason field description names the Phase-1 enumeration tool") faithfully — set_on_hold / set_delivery_failed / set_collection_failed duplicate the mention in spec.description, but set_return_to_origin only carries it on the reason field description. Both are D-02 compliant.
- 2026-05-21 (04-05): args-overlap scorer extended with BL-04 forbidden-keys check (order-creation only) — first eval scorer that combines model-behaviour signal (the LLM ignored user_id when told to ignore it) with structural negative-case enforcement (the schema doesn't accept user_id anyway). Pattern reusable in future phases for any tool where caller-supplied fields are SEMANTICALLY rejected but the agent might still try to pass them.
- 2026-05-21 (04-05): Numeric-bound / CSV-cap / dry-run-richness scorers use readFile + substring rather than structural Zod inspection. The values (`100_000`, `1000`, `13_500_000`, `dryRun: true`) live as numeric literals or string fragments in source — Zod schemas don't expose `.max(...)` parameters cleanly. Substring check is the simpler, more readable lock that PR-reviewers can verify without running the scorer.
- 2026-05-21 (04-05): Phase 4 closed cleanly without surfacing follow-up infra work. The factory pattern (D-01) absorbed 11 of the 12 batch-transition tools into one chokepoint; unpool_order remains hand-written because its single-id PATH parameter doesn't fit the batch-shaped factory. Future phases adding a similarly-shaped lifecycle group SHOULD reach for the factory pattern rather than 12 hand-written files.
- 2026-05-22 (05-01): `QuiqupGraphqlHostClient` is a NEW service-host family (graph.quiqup.com / graph.staging.quiqup.com) — DISTINCT from `orders-api.quiqup.com/graph` (Phase 3 Orders Core GraphQL). Env-var family is `QUIQUP_GRAPHQL_HOST_BASE_URL` / `QUIQUP_GRAPHQL_HOST_STAGING_BASE_URL` (no fallback aliasing to QUIQUP_ORDERS_GRAPH_URL). Client introduces own `QuiqupGraphqlHostError` (mirrors ExCoreError shape: status + body + name) per the STATE.md new-host-error-class rule.
- 2026-05-22 (05-03): `PlatformApiClient.request()` extended with backwards-compatible `extraHeaders?: Record<string, string>` (spread last, empty default). All ~30 Phase 1-4 callers are unaffected. Establishes the pattern for future tools that need custom headers on the Platform host (e.g. Phase 8 SHIP-02 `x-api-version: 20240101` for carrier capabilities).
- 2026-05-22 (05): AGENTS.md mandatory live-staging-call for all three Phase-5 Quiqup-host tools deferred by developer decision — MSW unit tests cover code correctness; manual Clerk OAuth call primarily tests infrastructure. CALL-LOG files created with deferred-waiver content. Must be completed before production promotion. This decision does NOT set a precedent for waiving the rule in future phases without explicit developer sign-off.

### Todos

(none yet — populated by `/gsd:plan-phase 1`)

### Blockers

(none)

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260520-bwa | Live-test `get_order_history` against staging order 57282; bound outbound fetch with 25s AbortSignal + bump route maxDuration; lock live-staging-verification rule into AGENTS.md | 2026-05-20 | 1618a21 | [260520-bwa-live-test-get-order-history-against-stag](./quick/260520-bwa-live-test-get-order-history-against-stag/) |

## Session Continuity

- **Last session:** 2026-05-22 — completed Phase 5 (4/4 plans shipped). Wave 1: new `QuiqupGraphqlHostClient` + `QuiqupGraphqlHostError` (own error class per STATE.md decision) + `download_pending_labels` (MISS-03); Wave 2: `download_return_label` (MISS-05) reusing client; Wave 3: `PlatformApiClient.extraHeaders` backwards-compat extension + `download_slip` (MISS-06, slipType z.enum-pinned); Wave 4: `eval:labels-slips-pdfs` + 5 STATIC scorers (binary-envelope-contract-present, auth-isolation-quiqup-graphql-host, slip-type-enum-pin, no-guardrails-on-read-tools, quiqup-graphql-host-error-class-uniqueness) + new CI job. 95 tools total. 768 passed | 3 skipped | 0 regressions. Live-staging CALL-LOGs for all 3 Phase-5 Quiqup-host tools deferred by developer decision (to be completed before production promotion). `EVAL_GATE=1 bun run eval:tool-surface` exits 0.
- **Next session:** `/gsd:plan-phase 6` — Phase 6: Inbound completion + Fulfilment gaps (INBD-07/08/09, PROD-04..09 — three INBD gaps + six PROD gaps, two DESTRUCTIVE tools).

---
*State initialized: 2026-05-19*
*Last updated: 2026-05-22 (Phase 5 executed — Labels, Slips & PDFs; 3 tools + 1 new service host + 5 STATIC scorers)*
