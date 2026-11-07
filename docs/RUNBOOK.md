# Runbook: integration runtime

Scope: the HTTP runtime in `src/server/main.ts` (Slack intake, `/workday` command, forms, approvals, OAuth account linking). The stdio MCP server (`npm start`) is separate.

## Architecture

- Node 18+ (tested on 24), one stateless process per instance, any number of instances behind a load balancer.
- PostgreSQL holds all state: Slack replay keys, form nonces, identity links, role entitlements, approval policies, approval requests, commit ledger, encrypted OAuth tokens and PKCE states, admin audit. Schema: `src/store/migrations.ts`.
- Secrets come only from environment variables (inject from your secrets manager): `TOKEN_ENCRYPTION_KEY`, `WORKDAY_OAUTH_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `DATABASE_URL`.

## First deploy (sandbox tenant)

```bash
npm ci && npm run build
npm run admin -- keygen            # prints TOKEN_ENCRYPTION_KEY and _ID; store in your secrets manager
export DATABASE_URL=... TOKEN_ENCRYPTION_KEY=... TOKEN_ENCRYPTION_KEY_ID=... WORKDAY_TENANT=... # see .env.example
npm run db:migrate
npm run admin -- policy-set --approvers <approver_user_id>[,<id2>] --actor <you>
npm run admin -- roles-set --user-id <id> --roles worker_self --actor <you>
npm run admin -- link-invite --slack-team T... --slack-user U... --user-id <id> --actor <you>
npm run serve                       # PORT, default 8787
```

Probes: `GET /healthz` (process), `GET /readyz` (database reachable and schema current). The process refuses to start if the schema is behind; set `DB_MIGRATE_ON_START=true` only if you accept migrations at boot.

## Operations

| Task | Command |
| --- | --- |
| Schema status | `npm run admin -- schema-status` |
| Revoke a user (deletes their tokens) | `npm run admin -- link-revoke --slack-team T.. --slack-user U.. --actor <you>` |
| Change roles / deny a tool | `npm run admin -- roles-set --user-id <id> --roles worker_self --denies tool:commit_request_time_off --actor <you>` |
| List uncertain commits | `npm run admin -- approvals-list --status reconcile` |
| Reconcile one | `npm run admin -- reconcile --id apr_... --actor <you>` (reads Workday; marks committed if found) |
| Confirm not submitted | add `--confirm-not-submitted` after checking Workday yourself; the user starts a new request |
| Kill switch | `WORKDAY_DISABLED_TOOLS=commit_request_time_off` and restart, or remove `requestTimeOff.create` from `WORKDAY_VALIDATED_OPERATIONS` |
| Rotate encryption key | set new `TOKEN_ENCRYPTION_KEY(_ID)`, move old to `TOKEN_ENCRYPTION_KEY_PREVIOUS(_ID)`; tokens re-seal on next refresh; drop the previous key after all users refreshed or relinked |

All admin writes land in `admin_audit`.

## Failure handling

- Workday timeout, 5xx, 408, 429, or a 2xx without an id on submit: request becomes `unknown`. It is never resubmitted automatically. Reconcile.
- Process crash during submit: request stays `committing`; after 10 minutes it shows in `approvals-list --status reconcile`.
- Refresh token rejected: token deleted, user must run `/workday link` again.
- Definitive Workday 4xx (validation, permission): request `failed`, user starts again.

## Logs

JSON lines on stderr. Keys matching token, secret, password, authorization, code, cookie, email, text, comment are redacted. Message text from Slack is not logged or stored (intake keeps metadata only).

## Backups and retention

Back up Postgres with your standard tooling. `oauth_tokens` is encrypted; the key is not in the database. Prune `slack_replay` runs every minute in-process. Define retention for `approval_requests` and `admin_audit` per your policy (no automatic deletion).
