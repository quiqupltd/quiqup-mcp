# Live call log - F28 PR C, step 1 (platform-token agent door)

Repo rule (AGENTS.md): every tool change that reaches a Quiqup service needs a live call, logged here.

**Where these ran.** There is no staging platform client for Carol (her only platform client is production), so the calls ran on 22 Nov 2026 against **production** platform-api, through a local build of this branch (`next start` on :3311, `/agent/mcp`), as the gated **test account `001P4000012OKKmIAO`** with a merchant token minted by Carol's platform client (`POST /admin/oauth/actor-token`). The token was minted inside a script that never printed it. Responses below are summarised: ids beyond 4 digits are masked and no customer field is reproduced. Writes were run only against the test account's one order (27266032, already cancelled) or as dry runs, so nothing changed.

Executed by: Claude (controller), for Slava.

## Door

| Call | Expected | Result |
|---|---|---|
| No bearer | 401 | 401 |
| Non-JWT bearer (40 x's) | 401 | 401 (after round 2; before it, platform `/me` answered 500 and the door said 503) |
| Valid token, no `X-Quiqup-Agent` | 400 | 400 |
| Valid token + agent + `X-Quiqup-Environment: production`, `initialize` | 200 | 200 |
| `tools/list` | the allowlist only | 8 tools: find_order_by_id_or_barcode, list_partner_cancellation_reasons, list_inventory, get_inventory_by_sku, cancel_lastmile_orders_batch, send_orders_for_collection, unpool_order, repair_integration_orders |

Live platform facts behind round 2: `GET /me` with a non-JWT bearer returns 500 `{"code":"unknown"}` (the platform forwards it to a legacy service); with a JWT-shaped bad token it returns 401 `{"code":"unauthenticated","message":"api auth failed"}`.

## Tools

| Tool | Call | Result |
|---|---|---|
| list_partner_cancellation_reasons | `{}` | ok: client-visible reasons, e.g. "Customer requested cancellation", "Duplicate order" |
| list_inventory | `{page:1, per_page:2}` | ok: the test account's own stock rows |
| get_inventory_by_sku | unknown SKU | tool error, upstream 404 `{"code":"not_found","message":"Product not found"}` |
| find_order_by_id_or_barcode | own order 2726****, intention `cancelled` | ok: `error: "The order is not in the correct state for the requested action"`, `found_by: order_id` (platform pre-flight works with the token) |
| find_order_by_id_or_barcode | **another merchant's** order 2768**** (Cosmopet), intention `cancelled` | tool error, upstream 404 "Couldn't find your order" |
| send_orders_for_collection | own order, `confirm:true, dry_run:true` | ok: ownership passed, dry run, nothing sent |
| unpool_order | own order by numeric id, dry run | ok: ownership passed, uuid looked up from the caller's own row |
| unpool_order | id 9999**** not in the account | refused locally, "not in your order list", no upstream PUT |
| cancel_lastmile_orders_batch | own cancelled order, reason "Not a real reason" | refused locally with the allowed reason names |
| cancel_lastmile_orders_batch | own cancelled order, reason "Customer requested cancellation" | reached `PUT /quiqdash/orders/batch/set_cancelled`; platform 400 `invalid_argument`, transition to cancelled not allowed (already cancelled): wiring proven, no change |
| repair_integration_orders | `{source:"shopify", ids:["#9999999"]}` (a store order number that does not exist) | ok: `{"message":"Order repair started","workflow_id":"repair-orders-shopify-001P4000***OKKmIAO-none-...","status":"running","started":true}`; the platform runs the repair for the caller's own account (scope `none`: no shop named), and a name that does not exist imports nothing |

## Assumptions settled

1. `filters[state]` as one comma-joined value: accepted (list and probe return rows).
2. List envelope: `{current_page, per_page, results, total, total_pages}`, rows carry numeric `id` and `uuid`: confirmed.
3. Agent unpool by numeric id with the looked-up uuid: confirmed (dry run).
4. `/me` on a Carol-minted merchant token: accepted, not admin or csr (the door let it through).
5. Cross-merchant: the platform's `find_by_id_or_barcode` is scoped by the token. With the test account's token, two Cosmopet orders returned 404 for intentions `cancelled` and `ready_for_collection`; with Cosmopet's own token, 200. The pending-order fallback therefore cannot reach another merchant's order.

## Still open (needs a pending draft order on the test account)

- A pending draft passes the ownership probe or the fallback, and a real cancel returns 201 or 202 `pending_projection`.
- `send_orders_for_collection` for real: not run on production, because it would put an order into a courier run.

---

# Live call log - sc-30350 (`list_order_audit_events` forwards the Clerk bearer)

Repo rule (AGENTS.md): the tool now sends `Authorization: Bearer <jwt>` to `audit.staging.quiqup.com` / `audit.quiqup.com`, so it needs a live staging call through `POST /mcp` `tools/call` with a Clerk OAuth at+jwt for a userId with an active Quiqdash staging session.

**Status: PENDING.** The agent preparing this PR has no Clerk session or staging client credentials, and does not mint, request or handle them. A human with a Quiqdash staging login runs the calls below and pastes the results here before merge.

## Pre-check already run (no credentials)

| Call | Result |
|---|---|
| Anonymous `GET https://audit.staging.quiqup.com/events?resourceID.eq=00000000-0000-4000-8000-000000000000`, 27 Nov 2026 | 200 `{"page":1,"total_count":0,...,"content":[]}` in 0.9 s: staging audit is still in `log` mode (audit#14 not live yet), so an anonymous read still passes there. |

## Calls to run (internal staging tenants only)

Local build of this branch (`bun run dev`), Claude/MCP Inspector connected to `http://localhost:3000/mcp` through Clerk OAuth as an internal staging user. Order UUIDs from `get_lastmile_order` / `bulk_orders_lookup` on staging.

| # | Caller | Call | Expected |
|---|---|---|---|
| 1 | Quiqup staff user | `list_order_audit_events {order_uuid: <staging order>, environment: "staging"}` | 200, non-empty `events` |
| 2 | Merchant user (internal test account) | own order | 200, that order's events |
| 3 | Same merchant user | another account's order | 200, empty `events` (once audit enforces) |
| 4 | Audit logs for calls 1-3 | `auth would reject` absent for these requests | no anonymous-caller log lines from this tool |

Record verbatim request and response per call (mask ids beyond 4 digits, no customer fields), date, acting user and the audit `AUTH_ENFORCE` mode at the time.
