# workday-mcp-schema

Permission-safe **Workday MCP server** scaffold (Node.js / TypeScript). Task-shaped tools only, per-user OAuth 2.0 (auth code + PKCE), preview-then-confirm writes, idempotent commits, and audited calls with PII redaction.

Intended owner: GitHub user **peopletechflow** (private repo).

## Architecture + RBAC

This repo is layer 3 of the Workday agent stack. Prefer **native Agent-Ready MCP tools** first, then **Custom Agent Actions (Orchestrate)** for tenant-specific process logic. Use this baseline for cross-tenant patterns, preview/commit/idempotency/audit guardrails, or multi-system composition. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Layer 1 catalog:** `src/agent-ready/` seeds/syncs a local catalog of native Agent-Ready tools (name, WID, Basic|Advanced|Prompt, product area). Meta tools `list_agent_ready_tools` / `get_agent_ready_tool` and resource `agent-ready://catalog` document that catalog for local/dev — they do **not** re-implement Workday MCP. The seed is partial (public docs only); refresh with `npm run sync:agent-ready -- --csv <Explorer.csv>` (see `src/agent-ready/sync.md`). Runtime still calls Workday MCP with dynamic schemas. It also includes 47 **tenant-discovered** tools (`src/agent-ready/catalog.tenant.ts`): 13 from [`worker-data-skill`](extend/skills/worker-data-skill.md) and 34 from [`self-service-skill`](extend/skills/self-service-skill.md), with role scopes in `src/rbac/agent-ready.ts`. Native self-service writes run only through the preview → confirm guard in `src/safety/native-write-guard.ts`.

Every tool call passes an RBAC check (`worker_self`, `manager`, `hr_partner`, `payroll_viewer`, `admin`) before any Workday call. The roles map to Workday security groups and to the ASOR skill's Available To list. In dev, set roles with `WORKDAY_USER_ROLES`. Run `npm run check:rbac` to verify that every tool is mapped. See [docs/RBAC.md](docs/RBAC.md).

## Use cases

| User sentence | Tool(s) | Build reason |
| --- | --- | --- |
| "Show me my remaining PTO and sick balance." | `get_my_time_off_balance` | Native MCP Explorer / agents may not expose this as a flat self-service read with our schema; custom read keeps fields minimal. |
| "Request next Friday off after I confirm the details." | `preview_request_time_off` → `commit_request_time_off` | Writes must stay gated (preview token + confirmation + idempotency) and submit through the Workday business process. |

## Auth flow (per user — never a shared account)

1. Register a Workday API client for **OAuth 2.0 authorization code** (PKCE where supported).
2. The MCP server builds an authorize URL with `code_challenge` (S256) and `state`.
3. The MCP client completes browser sign-in as the **human user**.
4. The server exchanges the code for tokens and stores the refresh token **encrypted per user**.
5. Every Workday call uses that caller's access token. Missing / revoked token → sign-in prompt. **No service-account fallback** for user-attributable actions.

Env placeholders live in `.env.example`. Develop against a **sandbox / implementation** tenant only. Production requires `WORKDAY_ALLOW_PROD=true`.

## Tools

**Contract:** all tool inputs/outputs and API objects are Zod schemas in [`src/schemas/`](src/schemas/) (tool contracts in `src/schemas/tools/`). Every tool is listed in [`src/tools/registry.ts`](src/tools/registry.ts); startup fails if registered tools drift from it, a passthrough name appears, or a payroll write is added. See [`docs/SCHEMA.md`](docs/SCHEMA.md).

| Tool | Who | Class | Surface | PII touched | Status |
| --- | --- | --- | --- | --- | --- |
| `get_my_worker_profile` | worker | read | REST | preferred name, hire/term dates, manager name | fixture |
| `get_my_time_off_balance` | worker | read | REST | none beyond type names | live stub + fixture |
| `list_my_time_off_requests` | worker | read | RaaS | comment | fixture |
| `preview_request_time_off` | worker | write preview | REST | comment | live stub + fixture |
| `commit_request_time_off` | worker | write commit (BP) | REST | comment | live stub + fixture |
| `preview_cancel_time_off` | worker | write preview | WWS | reason | fixture |
| `commit_cancel_time_off` | worker | write commit (BP) | WWS | reason | fixture |
| `list_my_team` | manager | read | RaaS | direct reports' preferred names | fixture |
| `list_team_time_off_requests` | manager | read | RaaS | worker names | fixture |
| `preview_approve_time_off` | approver | write preview | WWS | worker name, comment | fixture |
| `commit_approve_time_off` | approver | write commit (BP) | WWS | worker name, comment | fixture |
| `preview_deny_time_off` | approver | write preview | WWS | worker name, reason (required) | fixture |
| `commit_deny_time_off` | approver | write commit (BP) | WWS | worker name, reason | fixture |
| `get_my_benefits_enrollments` | worker | read | RaaS | coverage level (sensitive) | fixture |
| `list_my_pay_statements` | worker | read (**payroll read-only**) | RaaS | gross/net pay | fixture |
| `get_supervisory_org` | worker/manager | read | REST | manager name | fixture |
| `list_agent_ready_tools` | worker+ / admin | read (catalog meta) | catalog | none | local catalog |
| `get_agent_ready_tool` | worker+ / admin | read (catalog meta) | catalog | none | local catalog |

"fixture" = served by `FixtureWorkdayDomainClient` when `WORKDAY_USE_FIXTURES=true`; with fixtures off, `HttpWorkdayDomainClient` returns a `NOT_IMPLEMENTED` error (no silent fallback). There is no `call_workday` tool and no payroll write tool.

### Write safety

1. **Preview → confirm**: `commit_*` requires a valid `previewToken` and `userConfirmed: true`.
2. **Idempotency**: commits take `idempotencyKey`; retries return the stored result.
3. **Pre-check**: before submit, look for an existing matching request in Workday.
4. **Kill switch**: set `WORKDAY_DISABLED_TOOLS=commit_request_time_off,commit_approve_time_off` (comma-separated).
5. **Max records**: list reads cap `limit` at 100.

## Never do

- Use a shared integration account for user actions.
- Expose a raw SOAP/REST passthrough tool (e.g. `call_workday`).
- Write without preview and confirmation, or retry a write without an idempotency key.
- Touch production tenants during development, or log tokens / unredacted PII.
- Bypass the Workday Business Process Framework for hire / comp / time-off submits.
- Write payroll from an assistant (PECI/PICOF stay read-only at most).

## Project layout

```
src/
  index.ts                 # MCP stdio entry
  config.ts                # env config; sandbox-only by default
  session.ts               # per-user token resolution
  auth/                    # OAuth + PKCE, encrypted token store
  workday/                 # client interface, HTTP stub, fixtures
  tools/                   # task-shaped MCP tools, framework.ts (read/write-pair helpers), registry.ts
  safety/                  # preview store, idempotency, audit + PII redaction
  schemas/                 # THE CONTRACT: API objects per domain + tools/ (tool I/O)
  agent-ready/             # Layer-1 catalog of native Workday Agent-Ready MCP tools (seed + sync)
```

Workday HTTP is behind `WorkdayClient`. Default `WORKDAY_USE_FIXTURES=true` uses `FixtureWorkdayClient` (recorded-fixture-friendly). Set `WORKDAY_USE_FIXTURES=false` to use `HttpWorkdayClient` against a sandbox.

## Local run

```bash
cp .env.example .env
# edit .env — sandbox tenant + OAuth client placeholders

npm install
npm run typecheck
npm run build
npm start                 # stdio MCP server

# or without build:
npm run dev
```

### Example MCP client config (stdio)

```json
{
  "mcpServers": {
    "workday": {
      "command": "node",
      "args": ["/absolute/path/to/workday-mcp-schema/dist/index.js"],
      "env": {
        "WORKDAY_BASE_URL": "https://wd2-impl-services1.workday.com",
        "WORKDAY_TENANT": "your_sandbox_tenant",
        "WORKDAY_OAUTH_CLIENT_ID": "...",
        "WORKDAY_OAUTH_CLIENT_SECRET": "...",
        "WORKDAY_USE_FIXTURES": "true"
      }
    }
  }
}
```

### Example write flow

1. `get_my_time_off_balance` — confirm available days.
2. `preview_request_time_off` with dates / type / quantity → show `summary` to the user.
3. On explicit confirmation: `commit_request_time_off` with `previewToken`, a new `idempotencyKey`, and `userConfirmed: true`.

## Compliance notes

- Audit log (default `.data/audit.jsonl`): who, tool, redacted inputs, Workday event ID, result, latency.
- Document which fields leave Workday and where they go before production (GDPR / SOC 2 / SOX).
- Before each Workday semi-annual release, re-run contract tests against the preview tenant.

## License

MIT
