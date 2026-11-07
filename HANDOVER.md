# Handover

## State
- stdio MCP server (developer surface) and production HTTP integration runtime (`npm run serve`).
- Runtime: Postgres state, account linking, entitlements, encrypted tokens, approvals with commit ledger, Slack intake/command/forms/buttons, Notion reads for agents. Offline verified only.

## Verified offline
`npm run check` (typecheck, check:rbac, check:integrations 36, check:durable 17 on PGlite). `CHECK_DATABASE_URL=... npm run check:durable` also passes on PostgreSQL 17 (embedded, local). Built server booted against Postgres: migrate, admin commands, `/healthz` 200, `/readyz` 200, unsigned Slack 401.

## Not done (needs access, not code)
1. Sandbox validation of Workday contracts (docs/SANDBOX-TESTING.md); until then `WORKDAY_VALIDATED_OPERATIONS` stays empty and live commits are refused.
2. Workday API client registration, test users, time-off type ids.
3. Slack app in a sandbox workspace; Notion policy and page sharing.
4. Hosting, managed Postgres, secrets manager, TLS, monitoring of `/readyz` and `approvals-list --status reconcile`.

## Known design limits
- Linking does not verify which Workday worker signed in (no validated "who am I" contract); calls use `me`.
- Only self-service time off is wired through approvals.
