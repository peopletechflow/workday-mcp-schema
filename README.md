# workday-mcp-schema

Permission-safe **Workday MCP server** scaffold (Node.js / TypeScript). Task-shaped tools only, per-user OAuth 2.0 (auth code + PKCE), preview-then-confirm writes, idempotent commits, and audited calls with PII redaction.

Intended owner: GitHub user **peopletechflow** (private repo).

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

| Tool | Class | PII touched | Surface |
| --- | --- | --- | --- |
| `get_my_time_off_balance` | read | balance quantities, type names (no SSN/address) | Absence REST / RaaS (stubbed) |
| `preview_request_time_off` | write preview | dates, type ID, optional comment | local only (no Workday write) |
| `commit_request_time_off` | write | same as preview + Workday event ID | Absence REST BP submit (stubbed) |

### Write safety

1. **Preview → confirm**: `commit_*` requires a valid `previewToken` and `userConfirmed: true`.
2. **Idempotency**: commits take `idempotencyKey`; retries return the stored result.
3. **Pre-check**: before submit, look for an existing matching request in Workday.
4. **Kill switch**: set `WORKDAY_DISABLED_TOOLS=commit_request_time_off` (comma-separated).

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
  tools/                   # task-shaped MCP tools
  safety/                  # preview store, idempotency, audit + PII redaction
  schemas/                 # Zod: ISO dates, Workday ID types
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
