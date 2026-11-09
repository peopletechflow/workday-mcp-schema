# Architecture: Workday agent tooling stack

`workday-mcp-schema` is a reusable baseline for custom Workday MCP servers aimed at scale-ups. Adjust it to your processes, org structure, and complexity. It is the **third** layer of the stack. Use it only after the first two layers have been ruled out.

See also: [RBAC.md](./RBAC.md) · [SCHEMA.md](./SCHEMA.md) · [INTEGRATIONS.md](./INTEGRATIONS.md) · [README](../README.md)

## The three layers

### 1. Native Agent-Ready MCP tools (Workday): prefer these first

### Layer 1 catalog in this repo (`src/agent-ready/`)
This baseline keeps a **generated/maintained catalog** of native Agent-Ready tools for local discovery — names, descriptions, kinds (Basic|Advanced|Prompt), product area, WID placeholders, and `operationType` when known. It is **not** a re-implementation of Workday's MCP server:

- Seed: `src/agent-ready/catalog.generated.ts` (public-docs seed; incomplete vs Workday's 400+ tools).
- Tenant-discovered: `src/agent-ready/catalog.tenant.ts` lists 13 read-only worker-data tools that the Workday Developer Agent found on dev tenant `bzyvydgxsb_extdev` (2026-10-20) for Extend skill `worker-data-skill` ([mirror](../extend/skills/worker-data-skill.md)). `wid: null`, because the UI did not expose WIDs. `catalog.ts` merges this file with the seed and dedupes by name, so a sync regeneration does not drop these tools.
- Tenant-discovered (self-service): 34 more tools from Extend skill `self-service-skill` ([mirror](../extend/skills/self-service-skill.md)), 19 reads and 15 writes, `source: "tenant-discovered 2026-10-20 bzyvydgxsb_extdev self-service-skill"`. The writes are staged business-process steps (open event → stage → submit). In the external layer they run only through `src/safety/native-write-guard.ts`: preview (PreviewStore token), then explicit confirm with an idempotency key, then open/stage/submit. Known gap: the skill references `update_personal_information_marital_status`, which is not in its tool list.
- Tenant-discovered (manager actions): 41 more tools from `manager-actions-skill` ([mirror](../extend/skills/manager-actions-skill.md)), 35 reads and 6 writes: approve/deny step, change job, performance review, anytime feedback, payroll input. A manager acting on another worker needs a **verified team scope** (`src/rbac/team-scope.ts`, which reuses the `list_indirect_reports` recipe, cap 5). Approve/deny requires the caller to be the step's awaiting approver. `request_payroll_input` requires the payroll domain.
- Tenant-discovered (HR partner): 21 more tools from `hr-partner-skill` ([mirror](../extend/skills/hr-partner-skill.md)), 10 reads and 11 writes (leave of absence; passport/visa and national/government ID staging + submit). They are gated by **org-scope proofs** (`src/rbac/org-scope.ts`). ID changes require an externally supplied change-event WID, because no open-event tool is exposed (gap). Diversity is aggregate-only with k ≥ 5 (`src/safety/diversity.ts`).
- Tenant-discovered (payroll viewer): 22 more tools from `payroll-viewer-skill` ([mirror](../extend/skills/payroll-viewer-skill.md)), all reads (the skill uses 26; 4 were already catalogued). Payslips: own for every role, `payroll_viewer` also for workers in its pay group(s), admin all (native payslip tools are still self-service server-side, see RBAC.md). Other own pay (next payment date, year-end tax, worker pay group context) is self-only for every role. Pay group tools need a **pay-group listing proof** (`src/rbac/pay-group-scope.ts`) for `payroll_viewer`; admin is exempt. Pay results are summaries (count + statuses) unless a payroll viewer or admin explicitly asks for worker-level lines (`src/safety/pay-results.ts`). No payroll write is granted through this skill.
- Tenant-discovered (admin): 21 more tools from `admin-skill` ([mirror](../extend/skills/admin-skill.md)), all reads; the skill uses 92 (80 reads, 12 self-service writes), 71 already catalogued and tagged. Admin has full tenant-wide read (payslips included; the 7 other own-pay tools stay self-only), writes only on its own record via the native write guard. National ID, bank and passport fields are hidden unless one field is explicitly requested for one named worker, and then carry a logged-access notice (`src/safety/sensitive-fields.ts`). Multi-worker demographics are aggregate-only, k ≥ 5 (`src/safety/diversity.ts`). Compensation, termination, hire, org, security and job-change writes are never granted through the skill. Catalog total: 158 tools (125 reads, 33 writes).
- Native-tool RBAC: `src/rbac/agent-ready.ts` gives each role a scope (`self` / `self_and_reports` / `supervisory_org` / `pay_group` / `all`). See [RBAC.md](./RBAC.md#native-agent-ready-tools-tenant-discovered).
- Recipes: `src/agent-ready/recipes.ts` has read-only `resolve_manager_chain` (cap 10 hops) and `list_indirect_reports` (cap depth 5), built on native tools through an injected adapter. They are not registered as MCP tools yet.
- Lookup: `src/agent-ready/registry.ts`.
- Refresh: `scripts/sync-agent-ready-catalog.ts` + MCP Explorer CSV / ASOR JSON (`src/agent-ready/sync.md`).
- Meta MCP tools: `list_agent_ready_tools`, `get_agent_ready_tool` (RBAC: `worker_self` / `manager` / `hr_partner` / `admin`).
- MCP resource: `agent-ready://catalog`.
- **Do not** register fake `call_*` passthroughs. Runtime still calls Workday MCP with dynamic schemas after ASOR registration.

- **Discovery:** MCP Explorer / ASOR Agent Resource Search with `toolType=AGENT_READY`, `protocol=MCP` (*Discover Available Agent-Ready Tools*).
- **Types:** **Basic** (read), **Advanced** (write), **Prompt** (read-only helpers that resolve the WIDs Advanced writes need; see *Prompt Tools*).
- **Auth:** OAuth 2.1 + PKCE. At runtime the call uses an **Agent System User (ASU)** token. The agent is registered in ASOR with tool WIDs.
- **Unversioned surface:** do not hard-code tool names or fields. Discover schemas at runtime.
- **Change policy (Sept 2026):** semantic renames are *non-breaking*. Breaking changes are limited to removal without replacement, validations you can't resolve, or revoked access. Build clients that tolerate renames.

### 2. Custom Agent Actions (Workday Orchestrate): tenant-specific process logic
Extend app `peopletechHrBaseline_rjqhll` hosts our skills. They are built with the Workday Developer Agent against the tenant and then mirrored in [`extend/`](../extend/README.md).

Use this layer when the business process is proprietary to the tenant and belongs in Workday Extend/Orchestrate (*Configure Custom Agent Action Orchestrations*). Checklist:
- Enable the orchestration as an agent action. Name ≤ 30 characters.
- Give it a **when-to-use** description and an **effect annotation**: Read-Only / Idempotent / Destructive.
- Describe every request and response property. Leave no empty header/query rows.
- Deploy through App Hub, register the **Action ID** in the agent skill, and call it via the Orchestrate MCP client.

### 3. External baseline (this repo) — enterprise custom MCP
Use this layer when you need:
- Cross-tenant patterns that can be reused across customers.
- Stronger write guardrails: preview → commit, idempotency keys, an append-only audit log.
- Composition across several systems (Workday + others).
- Process or org complexity that native tools + Orchestrate don't cover safely.
- **Enterprise controls:** per-user OAuth + role RBAC + **user permission assignments** (lowest-level grants/denies) + an **AI SDK** agent loop (`src/ai/`) with preview/commit/audit.

These invariants stay fixed: **per-user OAuth**, **no shared service account**, **no raw passthrough tool**, **payroll write forbidden**, RBAC (roles + user assignments) checked before every Workday call, and **all model calls go through `src/ai/`** (Vercel AI SDK + AI Gateway; no raw provider fetch elsewhere).

## Decision tree

```
Does a native Agent-Ready tool (Basic/Advanced + Prompt) cover it?
├─ yes → Use it (layer 1). Discover at runtime; don't pin names.
└─ no → Is it tenant-specific process logic that fits Extend/Orchestrate?
        ├─ yes → Build a Custom Agent Action (layer 2).
        └─ no / needs cross-tenant reuse, preview+commit+idempotency+audit,
           multi-system composition, or complex org/process rules
              → Add a task-shaped tool here (layer 3).
```

## How the layers compose
- An agent skill can mix all three: native Basic reads, an Orchestrate action for a proprietary approval step, and a guarded preview/commit write from this server.
- Native **Prompt** tools (WID lookups) can feed inputs to layer-3 previews. Layer 3 must not duplicate a native tool that already covers the case. Track the reason in `buildReason` in `src/tools/registry.ts`.
- Identity is the same at every layer: the end user's delegated authority. Native tools use the ASU token; this server uses the user's own OAuth token.
- Authorization stacks up: ASOR skill **Available To** → this server's RBAC (`src/rbac/`) → Workday security groups on the user's token. Workday's check is the one that decides.

## RBAC overview
Baseline roles: `worker_self`, `manager`, `hr_partner`, `payroll_viewer`, `admin` (admin = full read under its own sign-in; writes only on self, preview + confirm). Each maps to a Workday security group and the skill's Available To list. `src/rbac/permissions.ts` maps every registered tool to its allowed roles. `registerRead` / `registerWritePair` in `src/tools/framework.ts` call `assertToolAllowedForUser` (roles + grants/denies) before sign-in or any Workday request. Startup and `pnpm run check:rbac` fail if any tool has no mapping. Details: [RBAC.md](./RBAC.md).

## Reference (moved from the README)

### AI SDK

**AI SDK:** all model calls go through `src/ai/` (Vercel AI SDK `ai` + `@ai-sdk/mcp`, AI Gateway via `AI_GATEWAY_API_KEY`). Use `createEnterpriseAgent` for a ToolLoopAgent that wraps Layer-3 tools with the same RBAC. Leave the gateway key unset (or set `WORKDAY_AI_DISABLED=1`) in CI/fixtures so no LLM spend occurs.

### Use cases

| User sentence | Tool(s) | Build reason |
| --- | --- | --- |
| "Show me my remaining PTO and sick balance." | `get_my_time_off_balance` | Native MCP Explorer / agents may not expose this as a flat self-service read with our schema; custom read keeps fields minimal. |
| "Request next Friday off after I confirm the details." | `preview_request_time_off` → `commit_request_time_off` | Writes must stay gated (preview token + confirmation + idempotency) and submit through the Workday business process. |

### Auth flow (per user - never a shared account)

1. Register a Workday API client for **OAuth 2.0 authorization code** (PKCE where supported).
2. The MCP server builds an authorize URL with `code_challenge` (S256) and `state`.
3. The MCP client completes browser sign-in as the **human user**.
4. The server exchanges the code for tokens and stores the refresh token **encrypted per user**.
5. Every Workday call uses that caller's access token. Missing / revoked token → sign-in prompt. **No service-account fallback** for user-attributable actions.

Env placeholders live in `.env.example`. Develop against a **sandbox / implementation** tenant only. Production requires `WORKDAY_ALLOW_PROD=true`.

### Tools

**Contract:** all tool inputs/outputs and API objects are Zod schemas in [`src/schemas/`](../src/schemas/) (tool contracts in `src/schemas/tools/`). Every tool is listed in [`src/tools/registry.ts`](../src/tools/registry.ts); startup fails if registered tools drift from it, a passthrough name appears, or a payroll write is added. See [`docs/SCHEMA.md`](SCHEMA.md).

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

#### Write safety

1. **Preview → confirm**: `commit_*` requires a valid `previewToken` and `userConfirmed: true`.
2. **Idempotency**: commits take `idempotencyKey`; retries return the stored result.
3. **Pre-check**: before submit, look for an existing matching request in Workday.
4. **Kill switch**: set `WORKDAY_DISABLED_TOOLS=commit_request_time_off,commit_approve_time_off` (comma-separated).
5. **Max records**: list reads cap `limit` at 100.

### Never do

- Use a shared integration account for user actions.
- Expose a raw SOAP/REST passthrough tool (e.g. `call_workday`).
- Write without preview and confirmation, or retry a write without an idempotency key.
- Touch production tenants during development, or log tokens / unredacted PII.
- Bypass the Workday Business Process Framework for hire / comp / time-off submits.
- Write payroll from an assistant (PECI/PICOF stay read-only at most).

### Project layout

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
  rbac/                    # roles, permissions, user assignments, enforce
  ai/                      # enterprise AI SDK client + ToolLoopAgent (all model calls)
```

Workday HTTP is behind `WorkdayClient`. Default `WORKDAY_USE_FIXTURES=true` uses `FixtureWorkdayClient` (recorded-fixture-friendly). Set `WORKDAY_USE_FIXTURES=false` to use `HttpWorkdayClient` against a sandbox.

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

1. `get_my_time_off_balance` - confirm available days.
2. `preview_request_time_off` with dates / type / quantity → show `summary` to the user.
3. On explicit confirmation: `commit_request_time_off` with `previewToken`, a new `idempotencyKey`, and `userConfirmed: true`.

### Compliance notes

- Audit log (default `.data/audit.jsonl`): who, tool, redacted inputs, Workday event ID, result, latency.
- Document which fields leave Workday and where they go before production (GDPR / SOC 2 / SOX).
- Before each Workday semi-annual release, re-run contract tests against the preview tenant.
