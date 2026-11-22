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
