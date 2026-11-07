# Agent guide for workday-mcp-schema

- Package manager: npm (package-lock.json). Checks: `npm run check` (typecheck, check:rbac, check:integrations, check:durable). `CHECK_DATABASE_URL` runs check:durable on real Postgres.
- Two runtimes: stdio MCP server (`src/index.ts`) and HTTP integration runtime (`src/server/main.ts`, composed in `src/server/runtime.ts`).
- All model calls go through `src/ai/` (AI SDK). No raw provider fetch elsewhere.
- Identity is never taken from request bodies or model output: Slack signature + `identity_links` (active only) for the HTTP runtime.
- Writes: proposal stores the exact Workday payload, human approval via verified identity, commit through `ApprovalExecutionService` with ledger. Never add an agent tool that commits or approves.
- Workday live calls must be listed in `WORKDAY_VALIDATED_OPERATIONS`; do not add endpoints without a cited contract.
- Keep deny-overrides-grant RBAC, team/org/pay-group proofs, and BP submission intact.
- Docs: no em dashes. Update CHANGELOG.md and HANDOVER.md with changes.
