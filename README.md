# workday-mcp-schema

A TypeScript MCP server baseline for Workday, from PeopleTech Flow B.V. in Utrecht. It exposes task-shaped tools, per-user OAuth, and preview-then-confirm writes. Fixture mode is the default. It has not been run against a production tenant. Live Workday behavior depends on the customer's tenant, and the tests in this repository do not verify that tenant.

## What it is

Use native Workday Agent-Ready tools first, then a Custom Agent Action in Workday Extend when the process is specific to one tenant, and a tool in this repository when you need a pattern you can reuse: a Zod contract, per-user OAuth, role checks, a preview, a human confirm, and an audit record. This repository is that third layer. `extend/` documents skills that live in a dev tenant. It is not the server.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What it does not do

There is no raw Workday passthrough tool and no payroll write. There is no shared integration account. Account linking does not prove which worker signed in. The people in the fixtures are invented. This project is not a Workday product, and it does not re-implement Workday's Agent-Ready MCP server.

## How it works

```mermaid
flowchart LR
  A[MCP client] --> B[Per-user token] --> C[RBAC check]
  C --> D{Read or write?}
  D -->|read| E[Workday call] --> H[Audit]
  D -->|write| F[Preview] --> G[Confirm and idempotent commit] --> E
```

Two runtimes:

- **stdio MCP** (`src/index.ts`). Credentials, the user id, and roles come from the environment. The per-user Workday sign-in is a separate OAuth flow. See [docs/MCP-AUTHORIZATION.md](docs/MCP-AUTHORIZATION.md).
- **HTTP runtime** (`pnpm serve`). Slack webhooks, account linking, and approvals. It is not an MCP endpoint. Callers are a verified Slack signature plus an active identity link.

Model calls go through `src/ai/`. They stay off when `AI_GATEWAY_API_KEY` is unset.

Reads check permission, call Workday with the caller's token, and append an audit line. Writes store the exact payload, wait for a human, then commit through code with an idempotency key. The integration agent can propose a change. It cannot approve or commit.

## How to run

**Prerequisites:** Node.js 22 and pnpm 10. A live tenant needs a Workday sandbox or implementation tenant and an OAuth API client.

**Configure:** copy `.env.example` to `.env`. Develop against a sandbox or implementation tenant only.

```bash
pnpm install
pnpm check         # typecheck, rbac, mcp, integrations, migrations, and a PGlite durable run
pnpm build
pnpm dev           # stdio MCP server (or: pnpm start after build)
```

An example MCP client config is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#example-mcp-client-config-stdio).

**HTTP runtime** (Slack intake, approvals, OAuth account linking, Postgres): `pnpm build && pnpm db:migrate && pnpm serve`. Integrations are off by default. See [docs/RUNBOOK.md](docs/RUNBOOK.md), [docs/DATABASE.md](docs/DATABASE.md), and [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md). A `Dockerfile` is included.

GitHub Actions runs `pnpm check` on pull requests.

**Workday native skills:** [extend/](extend/README.md) mirrors skills that live in the tenant. Refresh the local catalog with `pnpm sync:agent-ready --csv <Explorer.csv>` (see `src/agent-ready/sync.md`).

More: [HANDOVER](HANDOVER.md), [CHANGELOG](CHANGELOG.md), [AGENTS](AGENTS.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).

## Security model

- **Per-user OAuth.** Authorization code with PKCE. The refresh token is encrypted for that user. The stdio file store binds the ciphertext to the user id (`token:<userId>`). A `tokens.json` written before that binding does not decrypt. Sign in again. The Postgres store binds ciphertext to tenant and user.
- **Roles on stdio.** `WORKDAY_USER_ROLES` for the life of the process, default `worker_self`. This server does not look up Workday security groups. Live calls still use the caller's token, and Workday enforces that token.
- **HTTP callers.** Slack request signature plus an active `identity_links` row. Identity is not taken from the message body or from model output.
- **RBAC.** Deny overrides grant. The check runs before any Workday call. Workday security on the token is the final authority for live data.
- **Writes.** The proposal stores the payload. A human approves with a verified identity. Commit goes through `ApprovalExecutionService` and the ledger. There is no agent tool that approves.
- **Live operations.** Blocked until listed in `WORKDAY_VALIDATED_OPERATIONS` after you validate them in your sandbox. See [docs/SANDBOX-TESTING.md](docs/SANDBOX-TESTING.md).
- **Production hosts.** Refused unless `WORKDAY_ALLOW_PROD=true`.
- **OAuth scopes.** The default `openid` in `.env.example` is unverified against a Workday tenant. Set the scopes your API client actually grants after you confirm them. This repository does not validate that list.
- **Untrusted content.** Tool results and Workday fault text are data for any model that reads them. The agents in `src/ai/` wrap tool results and tell the model that text inside the wrapper is not instructions. Fault messages are scrubbed for bearer tokens and email addresses before they are returned.
- **Audit redaction.** Field names are matched after normalization, including `preferredName`, `descriptor`, pay amounts, and national-id, bank, and passport patterns. Email addresses and bearer tokens inside other strings are scrubbed. A name sitting in a free-text field whose name is not itself sensitive can remain. `comment` and `reason` are removed entirely.
- **Kill switch.** `WORKDAY_DISABLED_TOOLS` turns off listed tools.

Report vulnerabilities privately: [SECURITY.md](SECURITY.md).

## Limits

- No sandbox validation of Workday request and response bodies is recorded in this repository. Until you add operations to `WORKDAY_VALIDATED_OPERATIONS`, live commits are refused.
- Account linking does not verify that the Workday account which signs in is the invited user. Production requires `LINK_ACCEPT_UNVERIFIED_SIGNER=true` as an explicit acknowledgement. Calls use the `me` entry on the stored token.
- Only self-service time off is wired through the Slack approval path.
- The dev tenant named in `extend/README.md` is where those skills were discovered. It is not a certification of this server.
- Stdio roles are the environment variable above. They are not derived from the token.

## Layout

| Task | Start at |
| --- | --- |
| Tool contract or schema | `src/schemas/tools/*.ts`, then `src/tools/registry.ts` |
| RBAC or a permission id | `src/rbac/permissions.ts`, [docs/RBAC.md](docs/RBAC.md) |
| Slack command, form, button | `src/integrations/slack/*.ts` |
| Approval lifecycle or ledger | `src/integrations/approvals/execution.ts`, `src/store/approvals.ts` |
| OAuth, tokens, linking | `src/auth/*.ts`, `src/integrations/link.ts`, `src/store/repos.ts` |
| Agent prompt or toolset | `src/ai/integration-agent.ts`, `src/ai/enterprise-agent.ts` |
| Checks | `scripts/check-*.ts` |

## License

MIT. See [LICENSE](LICENSE).

This software is provided as is, without warranty of any kind. The maintainers and PeopleTech Flow B.V. accept no responsibility or liability for any use, data, HR decisions or outcomes. You are responsible for your own tenant, security and compliance, including your Workday agreements and applicable law.

Independent project, not affiliated with or endorsed by Workday, Inc. Workday is a trademark of Workday, Inc. Built for sandbox and implementation tenants, with fixture mode as the default. Not yet run against a production tenant. Fixture data is invented.
