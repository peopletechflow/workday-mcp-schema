# Handover

## State
- stdio MCP server (developer surface) and production HTTP integration runtime (`pnpm run serve`).
- Runtime: Postgres state, account linking, entitlements, encrypted tokens, approvals with commit ledger, Slack intake/command/forms/buttons, Notion reads for agents. Offline verified only.
- Tenant discovery is recorded: the Agent-Ready tool catalog (152 of 158 tools, the tenant-discovered rows in `src/agent-ready/catalog.tenant.ts`) and the Extend skills were found on developer tenant `bzyvydgxsb_extdev` (wd119) on 2026-10-20 via the Workday Developer Agent. The runtime server has not been validated live and is not certified for production.
- Slack UI flow (docs/INTEGRATIONS.md "Slack UI flow"): form -> approver DMs with Approve / Reject -> decision replaces the message and DMs the requester a Submit to Workday button -> commit through the ledger. Slow commits report back through `response_url`. No token refresh inside a Slack ack. Gated by `SLACK_APPROVAL_DELIVERY=explicit`.
- MCP authorization spec revision 2026-07-28 reviewed against both runtimes: docs/MCP-AUTHORIZATION.md (stdio keeps environment credentials; HTTP runtime is not an MCP endpoint; client-side rules met; checklist for a future HTTP MCP transport).
- Slack form acks do not wait for notifications (post-ack background runner, drained on shutdown); a slow database answers with a "Submitting" view and the outcome is DMed. Form nonce claim and approval insert share one transaction. Commit replays are served from the ledger after ownership and permission checks, with no token refresh.
- Database: versioned migrations with checksums and status (docs/DATABASE.md), owner/app role split via `db/psql/bootstrap-local.psql`, guarded dev seed. psql-only artifacts in `db/`. Local dev DB on the Mac: Postgres.app 18.6, `workday_mcp_dev` on 127.0.0.1:5432, migrations 1-2 applied, demo seed loaded; source `~/Library/Application Support/workday-mcp/local.env`.
- Local dev config: `.env.local` (gitignored) is loaded by `pnpm dev:serve` / `pnpm serve` / `pnpm admin` outside production; process env wins.
- Package manager is pnpm (`packageManager` pin, `pnpm-lock.yaml`, Dockerfile via corepack). `package-lock.json` is gone; do not bring it back.
- Agent prompts and toolsets follow docs/CONTEXT-ENGINEERING.md (sectioned prompts, contract-driven tool descriptions and schemas, capped tool results, bounded steps). The enterprise agent wraps tool results and omits commit tools unless `allowWriteCommits` is true. `AGENTS.md` is the short up-front map for coding agents. `extend/skills/` are tenant mirrors with a triggering description and a boundary box.
- Stdio token files use AAD `token:<userId>`. Older `.data/tokens.json` files need a fresh sign-in. Stdio roles come from `WORKDAY_USER_ROLES`. There is no security-group lookup. GitHub Actions runs `pnpm check` on pull requests.

## Verified offline
`pnpm run check` (typecheck, check:rbac, check:mcp 16, check:integrations 40, check:migrations 7 (12 on PostgreSQL 17), check:durable 35 on PGlite and on PostgreSQL 17 via `CHECK_DATABASE_URL`). GitHub Actions runs the same `pnpm check` on pull requests. Built server booted against Postgres: migrate, admin commands, `/healthz` 200, `/readyz` 200, unsigned Slack 401.

## Not done (needs access, not code)
1. Live sign-off of absence request and response contracts against a sandbox tenant (docs/SANDBOX-TESTING.md). No live run of `HttpWorkdayClient` is recorded. `WORKDAY_VALIDATED_OPERATIONS` stays empty, so live absence operations are refused. Body and filter field names still need confirmation against the tenant REST directory.
2. Workday API client registration, test users, time-off type ids.
3. Slack app in a sandbox workspace (slash command, interactivity URL, shortcut `wd_time_off_shortcut`, bot scopes `commands`, `chat:write`, `im:write`); confirm `chat.postMessage` to a user id opens the app DM in that workspace; Notion policy and page sharing.
4. Hosting, managed Postgres, secrets manager, TLS, monitoring of `/readyz` and `approvals-list --status reconcile`.

## Known design limits
- Linking does not verify which Workday worker signed in (no validated "who am I" contract); calls use `me`.
- Only self-service time off is wired through approvals.
