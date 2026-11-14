# Agent guide for workday-mcp-schema

Short on purpose: this file is loaded into every agent session. Details live in the files it points to; read them when the task touches that area.

## Build and check

- Package manager: pnpm (`pnpm-lock.yaml`; `packageManager` in package.json pins the version for corepack). Never add `package-lock.json`.
- `pnpm run check` = typecheck (src and scripts), lint, format, audit, check:rbac, check:mcp, check:safety, check:integrations, check:migrations, check:durable (PGlite). `CHECK_DATABASE_URL=...` runs check:durable on real Postgres. Run it before every commit.
- Schema changes: add a new numbered migration in `src/store/migrations.ts` (never edit an applied one), then `pnpm db:export`. Details: docs/DATABASE.md.
- Docs: no em dashes. Update CHANGELOG.md and HANDOVER.md with every change.

## Two runtimes

- stdio MCP server: `src/index.ts` builds through `src/mcp-server.ts`. Credentials come from the environment (MCP authorization spec, stdio section; see docs/MCP-AUTHORIZATION.md).
- HTTP integration runtime: `src/server/main.ts`, composed in `src/server/runtime.ts`. Slack UI flow in docs/INTEGRATIONS.md; operations in docs/RUNBOOK.md.

## Invariants (do not weaken)

- Identity is never taken from request bodies or model output. HTTP runtime: Slack signature plus active `identity_links`.
- Writes: proposal stores the exact Workday payload; a human approves through a verified identity; commit goes through `ApprovalExecutionService` with the ledger. Never add an agent tool that commits or approves.
- Workday live calls must be listed in `WORKDAY_VALIDATED_OPERATIONS`; no new endpoint without a cited contract (docs/SANDBOX-TESTING.md).
- Keep deny-overrides-grant RBAC (docs/RBAC.md), team/org/pay-group proofs, and BP submission intact.
- All model calls go through `src/ai/` (AI SDK). No raw provider fetch elsewhere. Agent context rules: docs/CONTEXT-ENGINEERING.md.
- `extend/skills/*.md` mirrors Workday tenant skills. Read `extend/README.md` only when the task is that mirror. Those tool names are not tools in `src/tools/registry.ts`. Do not add an MCP tool that calls one of them directly.

## Where to look

| Task                         | Start at                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| Tool contract or schema      | `src/schemas/tools/*.ts`, then `src/tools/registry.ts`                                  |
| RBAC or a permission id      | `src/rbac/permissions.ts`, docs/RBAC.md                                                 |
| Slack command, form, button  | `src/integrations/slack/*.ts` (`commands`, `forms`, `interactions`, `notify`, `submit`) |
| Approval lifecycle or ledger | `src/integrations/approvals/execution.ts`, `src/store/approvals.ts`                     |
| OAuth, tokens, linking       | `src/auth/*.ts`, `src/integrations/link.ts`, `src/store/repos.ts`                       |
| Agent prompt or toolset      | `src/ai/integration-agent.ts`, `src/ai/enterprise-agent.ts`                             |
| Checks                       | `scripts/check-*.ts`, shared fakes in `scripts/lib/harness.ts`                          |
