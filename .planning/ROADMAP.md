# Roadmap: Quiqup MCP — Full Frontend API Coverage

**Defined:** 2026-05-19
**Granularity:** standard
**Mode:** yolo
**Project mode:** standard
**Coverage:** 83/83 v1 to-build requirements mapped (32 [x] requirements already shipped, no phase)
**Source of truth:** `docs/quiqup-api-full-frontend-extract.md`

## Strategy

Phases follow the **service-host families** defined in REQUIREMENTS.md. Each family shares a `lib/clients/*.ts` service client, an env-var family, and an auth surface — grouping by family minimizes infra churn within a phase. Phase ordering is goal-backward from the project's Core Value: "every Quiqdash v3 backend endpoint reachable from an LLM via a single MCP server."

Phase 1 establishes the auth/lookup substrate that everything else depends on. Phases 2–11 deliver each remaining service-host family. Phase 12 closes the eval-coverage invariant ("every service-host family has at least one Langfuse eval") that the project's constraints require.

## Phases

- [x] **Phase 1: Account, Auth & Reference Data** — Read-mostly Platform endpoints + Google Places client; establishes the auth/lookup substrate that later phases depend on.
- [x] **Phase 2: Integrations (Shopify / WooCommerce / Salla)** — External-OAuth-shape Platform endpoints; two DESTRUCTIVE deletes gated by `confirm: true`. Completed 2026-05-19 (6/6 waves).
- [x] **Phase 3: Orders — Read Path** — Orders Core GraphQL + Audit + Ex-core CSV export + Quiqup REST history; introduces three new service clients. Completed 2026-05-20 (5/5 waves).
- [x] **Phase 4: Orders — Write Path & Lifecycle** — All `batch/set_*` status transitions, mission creation/transfer, and write-side Platform endpoints; every tool DESTRUCTIVE-gated. Completed 2026-05-21 (5/5 waves; 20 tools shipped + 4 family evals + 8 STATIC scorers locking D-01..D-06 + T-04-13/14/26..31 at CI).
- [x] **Phase 5: Labels, Slips & PDFs** — Quiqup-GraphQL-host REST client + base64 PDF response pattern shared by later phases (FIN PDFs). Completed 2026-05-22 (4/4 waves; 3 tools shipped: MISS-03/05/06 + 5 STATIC scorers + eval:labels-slips-pdfs CI job).
- [ ] **Phase 6: Inbound completion + Fulfilment gaps** — Three INBD gaps + six PROD gaps; closes the fulfilment receiving + product catalog endpoints.
- [ ] **Phase 7: Inventory expansion** — CBM history, totals, sync triggers/state, snapshot, CSV exports; completes fulfilment inventory surface.
- [ ] **Phase 8: Shipments & Shipping Profiles** — Carrier capability lookups + dispatcher rule-set CRUD; one DESTRUCTIVE delete.
- [ ] **Phase 9: Returns** — Platform REST return-request flow + Supabase Returns Hub metrics/tables; introduces `@supabase/supabase-js` client + service-role env wiring.
- [ ] **Phase 10: Finance — Invoicer + Stripe** — Zoho invoices/credit-notes (Invoicer client) + Stripe Platform endpoints; resolves the PUT /accounts collision between AUTH-07 and FIN-05.
- [ ] **Phase 11: Notifications, Metabase, Server Routes** — Notifications listing, Metabase report token, and the two internal server routes (exposure decision deferred to phase planning).
- [ ] **Phase 12: Eval Coverage Pass** — Add at least one Langfuse eval per new service-host family introduced in phases 1–11; update CI gate; validates the project's stated invariant.

## Phase Details

### Phase 1: Account, Auth & Reference Data
**Goal**: Establish the auth-and-lookup substrate so later phases can rely on canonical reference data (countries, states, cities, places, reason codes, service kinds, feature flags) and account/permissions context.
**Depends on**: Nothing (foundation phase; AUTH-01/02 already shipped supply the actor-token diagnostic)
**Requirements**: AUTH-03, AUTH-04, AUTH-05, AUTH-06, AUTH-07, AUTH-08, AUTH-09, AUTH-10, AUTH-11, AUTH-12, AUTH-13, ADDR-01, ADDR-02, ADDR-03, ADDR-04, ADDR-05, ADDR-06, ADDR-07, ADDR-08, INTG-19, ORDL-08, ORDL-09, ORDL-10, ORDL-11, ORDL-12
**Success Criteria** (what must be TRUE):
  1. An agent can read its own account, permissions, capabilities, and quiqdash init payload via `get_account` / `get_permissions` / `get_account_capabilities` / `get_account_by_id` / `get_quiqdash_init`.
  2. An agent can resolve any country → states → cities → Google place via `list_countries` / `list_country_states` / `list_country_cities` / `list_state_cities` / `lookup_google_place` (the last one through a new Google Places API-key-authenticated client).
  3. An agent can enumerate every reason code (cancellation, on-hold, return-to-origin, courier-failure, partner-cancellation) and order-state taxonomy via the ORDL-08..12 + INTG-19 lookups, so write-path phases can validate inputs against canonical enums.
  4. An agent can manage the partner's addresses, return settings, and team members via `list_account_addresses` / `create_partner_address` / `update_partner_address` / `get_return_settings` / `update_return_settings` / `create_account_team_member` / `update_account`.
  5. `decide_feature_flags_bulk` works against the Platform `/featureflags/decide-bulk` endpoint and returns the flag map for downstream phase tools to gate behaviour.
**Plans:** 4 plans
Plans:
- [x] 01-01-PLAN.md — Auth & Account reads (AUTH-03/04/05/06/08/09 + INTG-19) — Wave 1 — completed 2026-05-19
- [x] 01-02-PLAN.md — Addresses, geo lookups, Google Places + reason codes (ADDR-01..08 + ORDL-08..12) — Wave 2 — completed 2026-05-19
- [x] 01-03-PLAN.md — Auth & Account writes + feature flags (AUTH-07/10/11/12/13) — Wave 3 — completed 2026-05-19
- [x] 01-04-PLAN.md — Langfuse eval coverage (Platform reads + Google Places families) — Wave 4 — completed 2026-05-19
**UI hint**: no

### Phase 2: Integrations (Shopify / WooCommerce / Salla)
**Goal**: Expose every Quiqdash integrations endpoint so an agent can list connections, configure Shopify/WooCommerce/Salla, complete OAuth callbacks, repair stuck orders, and delete sources safely.
**Depends on**: Phase 1 (account + permissions context)
**Requirements**: INTG-01, INTG-02, INTG-03, INTG-04, INTG-05, INTG-06, INTG-07, INTG-08, INTG-09, INTG-10, INTG-11, INTG-12, INTG-13, INTG-14, INTG-15, INTG-16, INTG-17, INTG-18, INTG-20, INTG-21, INTG-22, INTG-23, INTG-24, INTG-25, INTG-26
**Success Criteria** (what must be TRUE):
  1. An agent can list every integration connection and any specific integration order via `list_integration_connections` / `list_integration_order_reasons` / `get_integration_order` / `repair_integration_orders` / `confirm_ff_export`.
  2. An agent can fully configure a Shopify shop end-to-end: read config + delivery methods + locations, update config + connection, and complete the OAuth callback via `get_shopify_config` / `list_shopify_delivery_methods` / `list_shopify_locations` / `update_shopify_config` / `update_shopify_connection` / `setup_shopify_callback`.
  3. An agent can fully configure WooCommerce via `list_woocommerce_connections` / `get_woocommerce_config` / `list_woocommerce_states` / `list_woocommerce_shipping_lines` / `setup_woocommerce_connection` / `upsert_woocommerce_config`.
  4. An agent can install Salla (returns OAuth URL), read its connection + config + platform-data, toggle fulfillment, and update config via `install_salla` / `get_salla_connection` / `get_salla_platform_data` / `get_salla_config` / `update_salla_config` / `toggle_salla_fulfillment`.
  5. Both DESTRUCTIVE deletes (`delete_integration_source`, `delete_salla_connection`) refuse to fire without an explicit `confirm: true` parameter and surface clear error semantics on missing confirmation.
**Plans:** 6 plans
Plans:
- [x] 02-01-PLAN.md — Shared integrations surface (INTG-01/03/04/05/06) — Wave 1
- [x] 02-02-PLAN.md — Shopify family (INTG-07/08/09/10/11/12) — Wave 2
- [x] 02-03-PLAN.md — WooCommerce family (INTG-13/14/15/16/17/18) — Wave 3
- [x] 02-04-PLAN.md — Salla family non-destructive (INTG-20/21/23/24/25/26) — Wave 4
- [x] 02-05-PLAN.md — DESTRUCTIVE deletes + canonical confirm:true gate helper (INTG-02/22) — Wave 5
- [x] 02-06-PLAN.md — Langfuse eval coverage for 5 Phase-2 sub-families + CI gate updates — Wave 6 — completed 2026-05-19
**UI hint**: no

### Phase 3: Orders — Read Path
**Goal**: Cover every read-only orders surface (GraphQL lookups, Audit events, Quiqup REST history, Ex-core CSV export, document upload) so agents can inspect any order's full lifecycle without yet mutating it.
**Depends on**: Phase 1 (reason-code enums for filtering)
**Requirements**: ORDL-02, ORDL-03, ORDL-04, ORDL-05, ORDL-06, ORDL-07, ORDS-02, ORDS-05, ORDS-08
**Success Criteria** (what must be TRUE):
  1. An agent can resolve order IDs in bulk via `lookup_orders_ids` and `bulk_orders_lookup` (Orders Core GraphQL client added) and find a single order by ID or barcode via `find_order_by_id_or_barcode`.
  2. An agent can enumerate depots and missions for filter UIs via `list_depots` and `list_missions_filter`.
  3. An agent can read an order's full history via `get_order_history` (Quiqup REST client added) and its audit-event timeline via `list_order_audit_events` (Audit client added with `AUDIT_BASE_URL` env wiring).
  4. An agent can download a CSV export of orders via `download_orders_export` (Ex-core client added) — CSV returned as base64 per the binary-response contract.
  5. An agent can upload a document to an order via `upload_order_document` (multipart against Orders Core REST) and receive the resulting document reference.
**Plans:** 5 plans
Plans:
- [x] 03-01-PLAN.md — Orders Core GraphQL client + lookup_orders_ids + bulk_orders_lookup (ORDL-02/03) — Wave 1 — completed 2026-05-19
- [x] 03-02-PLAN.md — Quiqup REST history client + Audit client (auth-exception, AUDIT_BASE_URL wiring) + get_order_history + list_order_audit_events (ORDS-02/05) — Wave 2 — completed 2026-05-19
- [x] 03-03-PLAN.md — Platform reads: find_order_by_id_or_barcode + list_depots + list_missions_filter (ORDL-04/05/06) — Wave 3 — completed 2026-05-20
- [x] 03-04-PLAN.md — Ex-core CSV export client + Orders Core REST multipart client + download_orders_export + upload_order_document (ORDL-07/ORDS-08) — Wave 4 — completed 2026-05-20
- [ ] 03-05-PLAN.md — Langfuse eval coverage for 4 new Phase-3 client families + CI gate updates — Wave 5
**UI hint**: no

### Phase 4: Orders — Write Path & Lifecycle
**Goal**: Cover every order-mutation endpoint: status transitions, charges, weight edits, exports, fulfilment-status patches, internal/bulk creates, and mission orchestration — every tool DESTRUCTIVE-gated.
**Depends on**: Phase 1 (reason enums), Phase 3 (read-path for verification)
**Requirements**: ORDS-03, ORDS-04, ORDS-06, ORDS-07, ORDC-04, ORDC-05, ORDT-03, ORDT-04, ORDT-05, ORDT-06, ORDT-07, ORDT-08, ORDT-09, ORDT-10, ORDT-11, ORDT-12, ORDT-13, ORDT-14, MISS-01, MISS-02
**Success Criteria** (what must be TRUE):
  1. An agent can drive an order through every status transition via `set_collected` / `set_received_at_depot` / `set_at_depot` / `set_in_transit` / `set_scheduled` / `set_delivery_complete` / `set_on_hold` / `set_return_to_origin` / `set_returned_to_origin` / `set_delivery_failed` / `set_collection_failed` / `unpool_order`, each requiring `confirm: true` and supporting a `dry_run` flag.
  2. An agent can create internal fulfilment orders and bulk-create orders from CSV via `create_internal_fulfilment_order` and `bulk_create_orders` (multipart).
  3. An agent can mutate a single order's metadata via `export_order` / `update_fulfilment_order_status` / `create_order_charge` / `update_order_weight`.
  4. An agent can create a mission and transfer orders between missions via `create_mission` and `transfer_mission_orders`.
  5. Every DESTRUCTIVE tool in this phase rejects calls missing `confirm: true` with a uniform error shape and exposes the affected order count in its response so agents can verify scope before confirming.
**Plans:** 5 plans
Plans:
- [x] 04-01-PLAN.md — Factory + 6 forward-path batch transitions (ORDT-03..08) — Wave 1 — completed 2026-05-20
- [x] 04-02-PLAN.md — 6 exception-path transitions: 4 reason-bearing + set_returned_to_origin + unpool_order (ORDT-09..14) — Wave 2 — completed 2026-05-21
- [x] 04-03-PLAN.md — 4 single-order mutations (ORDS-03/04/06/07) — Wave 3 — completed 2026-05-21
- [x] 04-04-PLAN.md — Creation + missions: ORDC-04, ORDC-05 multipart, MISS-01, MISS-02 — Wave 4 — completed 2026-05-21
- [x] 04-05-PLAN.md — Langfuse eval coverage for 4 Phase-4 tool families + CI gate updates — Wave 5 — completed 2026-05-21
**UI hint**: no

### Phase 5: Labels, Slips & PDFs
**Goal**: Stand up the Quiqup-GraphQL-host REST client and the base64 PDF response pattern; ship pending-label, return-label, and slip downloads.
**Depends on**: Phase 4 (orders must be in the right state to have labels/slips)
**Requirements**: MISS-03, MISS-05, MISS-06
**Success Criteria** (what must be TRUE):
  1. An agent can download a pending-orders label PDF (base64) via `download_pending_labels` against the Quiqup GraphQL host's REST surface.
  2. An agent can download a return-order label PDF (base64) via `download_return_label`.
  3. An agent can download a picking-list / packing-list slip PDF (base64) via `download_slip` with the `slipType` parameter validated against the allowed enum.
  4. All three tools return a uniform `{ contentType, base64, filenameHint }` payload shape so downstream phases (FIN PDFs) can reuse the contract.
**Plans:** 4 plans
Plans:
- [ ] 05-01-PLAN.md — Quiqup-GraphQL-host REST client (NEW host family) + download_pending_labels (MISS-03) + live-staging CALL-LOG — Wave 1
- [ ] 05-02-PLAN.md — download_return_label (MISS-05) reusing Wave-1 client + live-staging CALL-LOG — Wave 2
- [ ] 05-03-PLAN.md — PlatformApiClient extraHeaders extension + download_slip (MISS-06) with slipType z.enum + live-staging CALL-LOG — Wave 3
- [ ] 05-04-PLAN.md — Langfuse eval coverage for the new Quiqup-GraphQL-host family + 5 STATIC scorers (binary-envelope, auth-isolation, slip-type-enum, no-guardrails, error-class-uniqueness) + CI gate update — Wave 4
**UI hint**: no

### Phase 6: Inbound completion + Fulfilment gaps
**Goal**: Close the remaining inbound (warehouse receiving) and product-catalog endpoints so an agent can run the full inbound lifecycle and manage products beyond create/update/get.
**Depends on**: Phase 1 (account facility context)
**Requirements**: INBD-07, INBD-08, INBD-09, PROD-04, PROD-05, PROD-06, PROD-07, PROD-08, PROD-09
**Success Criteria** (what must be TRUE):
  1. An agent can read account-facility metadata, cancel an inbound (DESTRUCTIVE, `confirm: true`-gated), and edit an inbound via `get_account_facility` / `cancel_inbound` / `edit_inbound`.
  2. An agent can list products (paginated and unpaginated) via `list_products` and `list_products_paginated`.
  3. An agent can drive product sync via `sync_products_status` / `trigger_product_sync` / `trigger_single_product_sync`.
  4. An agent can delete products via `delete_products` (DESTRUCTIVE, `confirm: true`-gated; response surfaces affected SKUs).
**Plans**: TBD
**UI hint**: no

### Phase 7: Inventory expansion
**Goal**: Cover every remaining fulfilment-inventory endpoint — CBM history, totals, sync triggers/state, snapshot, CSV exports — so an agent can answer any inventory question Quiqdash can answer.
**Depends on**: Phase 6 (products must exist for inventory to be meaningful)
**Requirements**: INVT-06, INVT-07, INVT-08, INVT-09, INVT-10, INVT-11, INVT-12
**Success Criteria** (what must be TRUE):
  1. An agent can read CBM history and total items-in-stock via `get_cbm_history` and `get_total_items_in_stock`.
  2. An agent can trigger inventory sync and read its state via `trigger_inventory_sync` and `get_inventory_sync_state`.
  3. An agent can read the current inventory snapshot and export it as CSV (base64) via `get_inventory_snapshot` and `export_inventory_snapshot`.
  4. An agent can download the Ex-core inventory CSV via `download_ex_api_inventory` (reuses the Ex-core client from Phase 3).
**Plans**: TBD
**UI hint**: no

### Phase 8: Shipments & Shipping Profiles
**Goal**: Cover the shipments + carriers surface and the dispatcher rule-set CRUD so agents can read shipment data, query carrier capabilities, update carrier details, fetch rates, and manage shipping profiles.
**Depends on**: Phase 1 (account + permissions)
**Requirements**: SHIP-01, SHIP-02, SHIP-03, SHIP-04, SHPR-01, SHPR-02, SHPR-03, SHPR-04
**Success Criteria** (what must be TRUE):
  1. An agent can read shipment data, list carrier capabilities (sending the required `x-api-version: 20240101` header), update carrier details, and fetch rates via `get_shipment` / `list_carrier_capabilities` / `update_carrier_details` / `get_shipment_rates`.
  2. An agent can list, create, and update dispatcher rule sets via `list_dispatcher_rule_sets` / `create_dispatcher_rule_set` / `update_dispatcher_rule_set`.
  3. An agent can delete a dispatcher rule set via `delete_dispatcher_rule_set` (DESTRUCTIVE, `confirm: true`-gated).
**Plans**: TBD
**UI hint**: no

### Phase 9: Returns
**Goal**: Cover the dual returns surface — Platform REST return-request workflow + Supabase Returns Hub metrics/tables — so agents can list, inspect, approve, and reject returns and read returns analytics.
**Depends on**: Phase 1 (account context + return-settings already shipped there)
**Requirements**: RETN-01, RETN-02, RETN-03, RETN-04, RETN-05, RETN-06, RETN-07, RETN-08, RETN-09
**Success Criteria** (what must be TRUE):
  1. An agent can list return requests and reasons, fetch a specific return request, and approve/reject it via `list_return_requests` / `list_return_reasons` / `get_return_request` / `approve_return_request` / `reject_return_request`.
  2. The `@supabase/supabase-js` client is added with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` env wiring, and the auth surface correctly identifies as service-role per the project's auth-parity constraint.
  3. An agent can read Returns Hub metrics via the `get_returns_hub_metrics` RPC and read `return_orders` / `skus` / `units` tables via `list_return_orders` / `list_return_skus` / `list_return_units` with structured filter args.
**Plans**: TBD
**UI hint**: no

### Phase 10: Finance — Invoicer + Stripe
**Goal**: Cover the finance surface — Zoho invoices/credit-notes via the Invoicer service + Stripe payment-method management via the Platform — and resolve the PUT /accounts collision between AUTH-07 (full account update) and FIN-05 (bank-details-only update).
**Depends on**: Phase 1 (AUTH-07 must already exist so FIN-05 can be modeled as a constrained payload variant), Phase 5 (PDF base64 contract reuse)
**Requirements**: FIN-01, FIN-02, FIN-03, FIN-04, FIN-05, FIN-06, FIN-07, FIN-08, FIN-09, FIN-10, FIN-11
**Success Criteria** (what must be TRUE):
  1. An agent can list Zoho invoices and credit notes and download either as base64 PDF via `list_zoho_invoices` / `download_zoho_invoice` / `list_zoho_credit_notes` / `download_zoho_credit_note` (new Invoicer client added).
  2. An agent can update bank details via `update_bank_details` — its tool description must explicitly disambiguate from `update_account` (AUTH-07) and constrain the payload to bank-detail fields only.
  3. An agent can fetch Stripe context (setup intent, customer session, user state) and list/get/delete payment methods via `get_stripe_setup_intent` / `get_stripe_customer_session` / `get_stripe_user_state` / `list_stripe_payment_methods` / `get_stripe_payment_method` / `delete_stripe_payment_method`.
  4. `delete_stripe_payment_method` refuses to fire without `confirm: true`.
**Plans**: TBD
**UI hint**: no

### Phase 11: Notifications, Metabase, Server Routes
**Goal**: Close the remaining endpoints — notifications listing, Metabase report tokens, and a decision on whether to expose this Next app's own server routes as MCP tools.
**Depends on**: Phase 1 (account context for notifications + reports)
**Requirements**: NOTF-01, RPT-01, SRVR-01, SRVR-02
**Success Criteria** (what must be TRUE):
  1. An agent can list its quiqdash notifications via `list_notifications`.
  2. An agent can fetch a Metabase report token via `get_metabase_report_token`, with the `/token-unsafe/{id}` variant correctly selected for the Alshayaa role (role-based path selection in the tool's input schema or runtime).
  3. A documented decision is recorded in the phase plan on whether `generate_actor_token` (SRVR-01) and `download_document_proxy` (SRVR-02) are exposed as MCP tools or kept internal-only; if exposed, both require the same Clerk-session auth as every other tool.
**Plans**: TBD
**UI hint**: no

### Phase 12: Eval Coverage Pass
**Goal**: Satisfy the project's stated invariant — "every new service-host family gets at least one Langfuse eval before its tools count as shipped" — by adding evals for each family introduced in phases 1–11 and updating the CI gate accordingly.
**Depends on**: Phases 1–11 (every tool must exist before it can be evaluated)
**Requirements**: None new — this phase validates coverage of constraints declared in PROJECT.md, not new REQ-IDs. The v2 backlog (EVAL-01, EVAL-02) remains deferred.
**Success Criteria** (what must be TRUE):
  1. At least one Langfuse eval exists per new service-host family introduced in phases 1–11: Platform extras, Google Places, Orders Core GraphQL, Quiqup REST, Audit, Ex-core, Orders Core REST, Quiqup GraphQL host, Supabase, Invoicer, Metabase.
  2. The CI eval gate (the existing `pnpm eval:*` + CI step that gates `create_lastmile_order` today) runs the new evals and fails the build on regression — descriptions follow the `eval-driven-description-improvement` lesson (rich field semantics, error modes, canonical example payload).
  3. A per-family eval matrix is recorded in `evals/` (or equivalent) so future phases inherit the "one eval per family" guarantee by default.
  4. PROJECT.md "Key Decisions" row "Every new service-host family gets at least one Langfuse eval" flips to `✓ Good`.
**Plans**: TBD
**UI hint**: no

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Account, Auth & Reference Data | 4/4 | Plans complete (awaiting gsd-verifier) | 2026-05-19 |
| 2. Integrations (Shopify / WooCommerce / Salla) | 6/6 | Complete | 2026-05-19 |
| 3. Orders — Read Path | 5/5 | Complete | 2026-05-20 |
| 4. Orders — Write Path & Lifecycle | 5/5 | Complete | 2026-05-21 |
| 5. Labels, Slips & PDFs | 4/4 | Executed | 2026-05-22 |
| 6. Inbound completion + Fulfilment gaps | 0/0 | Not started | - |
| 7. Inventory expansion | 0/0 | Not started | - |
| 8. Shipments & Shipping Profiles | 0/0 | Not started | - |
| 9. Returns | 0/0 | Not started | - |
| 10. Finance — Invoicer + Stripe | 0/0 | Not started | - |
| 11. Notifications, Metabase, Server Routes | 0/0 | Not started | - |
| 12. Eval Coverage Pass | 0/0 | Not started | - |

## Coverage

- v1 to-build requirements: 83
- Mapped to phases: 83 ✓
- Orphaned: 0 ✓
- Already shipped ([x], no phase): 32
- v2 / out-of-scope: tracked separately in REQUIREMENTS.md (INVT-13 also flagged as candidate for out-of-scope)

---
*Roadmap created: 2026-05-19*
