# quiqup-mcp

> Renamed from `quiqup-mcp-claims-dump` on 2026-05-02. `claims_dump` was the first tool — the repo is now the home for the broader **Quiqup MCP** curated tool surface (see the [learning track](https://github.com/Zombiemelon/slava-personal-vault/tree/main/wiki/personal/learning/quiqup-mcp) in the personal vault). The deployed Vercel project keeps its original name (`quiqup-mcp-claims-dump.vercel.app/mcp`) until the M7 production-deploy migration.

A production-shaped MCP server for [Quiqup](https://quiqup.com)'s Fulfilment + Last-Mile APIs. Authenticates any MCP client (Claude.ai, Claude Code, Codex, ChatGPT) via the production `clerk.quiqup.com` tenant and exposes a curated tool surface (currently: `claims_dump`, `recent_orders`; expanding under TDD per the learning track).

**Origin:** built as the anchor project for the [auth-for-ai-apps](https://github.com/Zombiemelon/slava-personal-vault/tree/main/wiki/personal/learning/auth-for-ai-apps) track (M3–M5: Clerk OAuth, MCP authorization spec, V3b same-IdP shape conversion). Now the anchor for the [quiqup-mcp](https://github.com/Zombiemelon/slava-personal-vault/tree/main/wiki/personal/learning/quiqup-mcp) track (M0 baseline → M8 continuous evals). See [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md) for the auth-pipeline walkthrough.

## Quickstart

```bash
bun install
cp .env.example .env.local   # fill in values from Clerk dashboard
bun run dev
curl -i http://localhost:3000/mcp   # expect 401 + WWW-Authenticate
```

## Test

```bash
bun run test                  # Layer 1 unit tests (9 tests)
bun run test:integration      # Layer 2 (requires CLERK_SECRET_KEY + RUN_INTEGRATION=1)
```

Layer 3 (end-to-end) is manual: add the deployed URL as a connector in Claude.ai or Claude Code, complete the OAuth flow, call `claims_dump`.

## Agent access

Server agents (Carol, the onboarding agent) use a separate door, **`/agent/mcp`**, instead of the Clerk OAuth `/mcp`. It accepts one thing as the bearer: a merchant's Quiqup **platform token**. Carol mints that token herself (`POST /admin/oauth/actor-token {salesforce_id}`); this server mints nothing, stores no secret, and forwards the token upstream as-is after checking it on platform-api `GET /me`.

Three headers:

| Header | Value |
|--------|-------|
| `Authorization` | `Bearer <merchant platform token>` |
| `X-Quiqup-Agent` | required label, `^[a-z][a-z0-9-]{0,31}$` (e.g. `carol`); appears in every audit record |
| `X-Quiqup-Environment` | `production` (default) or `staging`; picks the platform-api host for verification and every tool call |

Refusals: bad or missing agent label or unknown environment `400`; invalid token `401`; an admin or CSR token `403` (agents act as exactly one merchant; admin work goes through `/mcp` with a person). A Clerk OAuth token never works here, and a platform token never works on `/mcp`.

What an agent can call (an allowlist; every other tool is not registered on this door):

- reads: `find_order_by_id_or_barcode`, `list_partner_cancellation_reasons`, `list_inventory`, `get_inventory_by_sku` (fulfilment inventory on platform-api, scoped to the token's own account)
- reads for Carol stay native for now: order read-back lists and the repair status poll (`GET /integrations/repair-orders/status`) are NOT exposed here
- writes: `cancel_lastmile_orders_batch` (`reason` required, a name from `list_partner_cancellation_reasons`), `send_orders_for_collection`, `unpool_order` (takes the numeric order id; the uuid is looked up from your own order list), `repair_integration_orders` (specific order ids only, never a date range)

Guardrails are per merchant: rate limits and idempotency keys use `platform:<salesforceId>`; ownership checks use the merchant's own order list on platform-api; `on_behalf_of_email` and the `environment` argument are not offered; order ids are numeric client order ids only (digits, 1 to 12), and the caller key is `platform:<environment>:<salesforceId>`; every call, success or failure, writes an `audit:` line with `agent`, `salesforceId` and `environment` (never the token); calls the SDK rejects before the tool runs (validation, unknown tool) get a door-level record too. `find_order_by_id_or_barcode` returns an order only if it is in the merchant's own list (otherwise the not-found shape) and strips customer fields (`origin`, `destination`, `tracking_url`, `user`, `items`, contact fields). The tool list for this door is pinned in `evals/snapshots/tool-surface-agent.json`. Live staging evidence for each tool is tracked in [`CALL-LOG.md`](CALL-LOG.md).

## Stack

- Next.js 16 App Router + TypeScript + Bun
- `@modelcontextprotocol/sdk`, `mcp-handler`, `@clerk/mcp-tools`, `@clerk/nextjs`
- Vitest

## Reference

- [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md) — runtime walkthrough, file-by-file
- [datacube](https://github.com/quiqupltd/datacube) — original Mastra-based MCP this replicates
- [clerk/mcp-nextjs-example](https://github.com/clerk/mcp-nextjs-example) — Clerk's canonical example
