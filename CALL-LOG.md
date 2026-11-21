# Live staging call log - F28 PR C, step 1 (platform-token agent door)

Repo rule (AGENTS.md): every tool change that reaches a Quiqup service needs a live
staging call, logged here with the verbatim request and response.

Status of this file: the implementer had no staging credentials and was not allowed
to call any live service, so every entry below is PENDING. The controller runs each
call against `*.staging.quiqup.com` and pastes the verbatim result.

How to run (staging, through the real door):

```
# 1. A staging merchant platform token (Carol mints it: POST /admin/oauth/actor-token {salesforce_id}).
# 2. Through the local server (bun run dev) or a preview deployment:
curl -sS -X POST http://localhost:3000/agent/mcp \
  -H "Authorization: Bearer $STAGING_MERCHANT_PLATFORM_TOKEN" \
  -H "X-Quiqup-Agent: carol" \
  -H "X-Quiqup-Environment: staging" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"<tool>","arguments":{...}}}'
```

Things the live calls must settle (each was an assumption in code; see the PR C report):

1. Multi-state filter encoding on `GET /quiqdash/orders` (code sends one comma-joined `filters[state]`).
2. The list response envelope (expected ex-core v2: `{current_page, per_page, results, total, total_pages}`; confirm rows carry numeric `id` and `uuid`).
3. Agent `unpool_order` takes the numeric id and unpools with the row's looked-up uuid (confirmed by coordinator; verify live).
4. Whether `/me` on a Carol-minted merchant token returns `salesforce_id` and `admin:false, csr:false`.
5. 201 / 202 `pending_projection` / 422 behaviour of `set_cancelled`.

---

## find_order_by_id_or_barcode

- **Change:** unchanged tool, now also served on /agent/mcp with a platform token (jwtFor path)
- **Request to run:** GET /quiqdash/orders/find_by_id_or_barcode?value=<id>&intention=set_cancelled
- **Date / Time (UTC):** PENDING
- **Executed by:** PENDING
- **Request (verbatim):** PENDING: run by the controller with a staging platform token
- **Response (verbatim):** PENDING: run by the controller with a staging platform token
- **Outcome:** PENDING: run by the controller with a staging platform token

---

## list_partner_cancellation_reasons

- **Change:** unchanged tool, now also served on /agent/mcp (jwtFor path)
- **Request to run:** GET /orders/partner-cancellation-reasons
- **Date / Time (UTC):** PENDING
- **Executed by:** PENDING
- **Request (verbatim):** PENDING: run by the controller with a staging platform token
- **Response (verbatim):** PENDING: run by the controller with a staging platform token
- **Outcome:** PENDING: run by the controller with a staging platform token

---

## cancel_lastmile_orders_batch

- **Change:** new optional `reason` (platform set_cancelled), required on /agent/mcp; platform ownership probe
- **Request to run:** PUT /quiqdash/orders/batch/set_cancelled body {orderIds, reason}; ownership GET /quiqdash/orders?...filters[state]=<all states>; also re-run WITHOUT reason on /mcp with a Clerk token to confirm no change
- **Date / Time (UTC):** PENDING
- **Executed by:** PENDING
- **Request (verbatim):** PENDING: run by the controller with a staging platform token
- **Response (verbatim):** PENDING: run by the controller with a staging platform token
- **Outcome:** PENDING: run by the controller with a staging platform token

---

## send_orders_for_collection

- **Change:** NEW tool on /mcp and /agent/mcp
- **Request to run:** PUT /quiqdash/orders/batch/set_ready_for_collection body {orderIds}
- **Date / Time (UTC):** PENDING
- **Executed by:** PENDING
- **Request (verbatim):** PENDING: run by the controller with a staging platform token
- **Response (verbatim):** PENDING: run by the controller with a staging platform token
- **Outcome:** PENDING: run by the controller with a staging platform token

---

## unpool_order

- **Change:** agent-door variant: numeric order_id, uuid looked up from the caller's own order row
- **Request to run:** GET /quiqdash/orders?filters[order_id]=<numeric id> (supplies uuid), then PUT /quiqdash/missions/unpool/orders/<uuid>
- **Date / Time (UTC):** PENDING
- **Executed by:** PENDING
- **Request (verbatim):** PENDING: run by the controller with a staging platform token
- **Response (verbatim):** PENDING: run by the controller with a staging platform token
- **Outcome:** PENDING: run by the controller with a staging platform token

---

## repair_integration_orders (agent variant)

- **Change:** NEW agent-door variant: ids only, no dates, no user_id, location_id 0
- **Request to run:** POST /integrations/repair-orders body {source, ids, location_id: 0}
- **Date / Time (UTC):** PENDING
- **Executed by:** PENDING
- **Request (verbatim):** PENDING: run by the controller with a staging platform token
- **Response (verbatim):** PENDING: run by the controller with a staging platform token
- **Outcome:** PENDING: run by the controller with a staging platform token

---

## agent door verifier (/agent/mcp)

- **Change:** NEW auth path: platform token validated on /me
- **Request to run:** GET /me with the merchant platform token; X-Quiqup-Agent + X-Quiqup-Environment headers
- **Date / Time (UTC):** PENDING
- **Executed by:** PENDING
- **Request (verbatim):** PENDING: run by the controller with a staging platform token
- **Response (verbatim):** PENDING: run by the controller with a staging platform token
- **Outcome:** PENDING: run by the controller with a staging platform token

---

## list_inventory

- **Change:** unchanged tool, now also served on /agent/mcp with a platform token (jwtFor path); confirm the route is account-scoped by the token alone
- **Request to run:** GET /api/fulfilment/inventory?page=1&per_page=5
- **Date / Time (UTC):** PENDING
- **Executed by:** PENDING
- **Request (verbatim):** PENDING: run by the controller with a staging platform token
- **Response (verbatim):** PENDING: run by the controller with a staging platform token
- **Outcome:** PENDING: run by the controller with a staging platform token

---

## get_inventory_by_sku

- **Change:** unchanged tool, now also served on /agent/mcp with a platform token (jwtFor path); confirm the route is account-scoped by the token alone
- **Request to run:** GET /api/fulfilment/inventory/<sku>
- **Date / Time (UTC):** PENDING
- **Executed by:** PENDING
- **Request (verbatim):** PENDING: run by the controller with a staging platform token
- **Response (verbatim):** PENDING: run by the controller with a staging platform token
- **Outcome:** PENDING: run by the controller with a staging platform token

