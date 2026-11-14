# Runbook: integration runtime

Scope: the HTTP runtime in `src/server/main.ts` (Slack intake, `/workday` command, forms, approvals, OAuth account linking). The stdio MCP server (`pnpm start`) is separate.

## Architecture

- Node 18+ (tested on 24), one stateless process per instance, any number of instances behind a load balancer.
- PostgreSQL holds all state: Slack replay keys, form nonces, identity links, role entitlements, approval policies, approval requests, commit ledger, encrypted OAuth tokens and PKCE states, admin audit. Schema: `src/store/migrations.ts`.
- Secrets come only from environment variables (inject from your secrets manager): `TOKEN_ENCRYPTION_KEY`, `WORKDAY_OAUTH_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `DATABASE_URL`.

## First deploy (sandbox tenant)

```bash
pnpm install --frozen-lockfile && pnpm run build
pnpm admin keygen            # prints TOKEN_ENCRYPTION_KEY and _ID; store in your secrets manager
export DATABASE_URL=... TOKEN_ENCRYPTION_KEY=... TOKEN_ENCRYPTION_KEY_ID=... WORKDAY_TENANT=... # see .env.example
pnpm db:status            # read-only: applied / pending / drift per version
DATABASE_MIGRATION_URL=... pnpm db:migrate   # schema owner; see docs/DATABASE.md
pnpm admin policy-set --approvers <approver_user_id>[,<id2>] --actor <you>
pnpm admin roles-set --user-id <id> --roles worker_self --actor <you>
pnpm admin link-invite --slack-team T... --slack-user U... --user-id <id> --actor <you>
pnpm run serve                       # PORT, default 8787
```

Probes: `GET /healthz` (process), `GET /readyz` (database reachable and schema current). The process refuses to start if the schema is behind; set `DB_MIGRATE_ON_START=true` only if you accept migrations at boot.

## Operations

| Task                                 | Command                                                                                                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema status                        | `pnpm admin schema-status`                                                                                                                                                         |
| Revoke a user (deletes their tokens) | `pnpm admin link-revoke --slack-team T.. --slack-user U.. --actor <you>`                                                                                                           |
| Change roles / deny a tool           | `pnpm admin roles-set --user-id <id> --roles worker_self --denies tool:commit_request_time_off --actor <you>`                                                                      |
| List uncertain commits               | `pnpm admin approvals-list --status reconcile`                                                                                                                                     |
| Reconcile one                        | `pnpm admin reconcile --id apr_... --actor <you>` (reads Workday; marks committed if found)                                                                                        |
| Confirm not submitted                | add `--confirm-not-submitted` after checking Workday yourself; the user starts a new request                                                                                       |
| Kill switch                          | `WORKDAY_DISABLED_TOOLS=commit_request_time_off` and restart, or remove `requestTimeOff.create` from `WORKDAY_VALIDATED_OPERATIONS`                                                |
| Rotate encryption key                | set new `TOKEN_ENCRYPTION_KEY(_ID)`, move old to `TOKEN_ENCRYPTION_KEY_PREVIOUS(_ID)`; tokens re-seal on next refresh; drop the previous key after all users refreshed or relinked |

All admin writes land in `admin_audit`.

## Failure handling

- Workday timeout, 5xx, 408, 429, or a 2xx without an id on submit: request becomes `unknown`. It is never resubmitted automatically. Reconcile.
- Process crash during submit: request stays `committing`; after 10 minutes it shows in `approvals-list --status reconcile`.
- Refresh token rejected (HTTP 400/401, e.g. `invalid_grant`): token deleted, user must run `/workday link` again.
- Token endpoint down, 5xx, or timeout (15 s): the token is kept; the user sees "temporarily unavailable" and retries. An approved request stays `approved`.
- Missing link at submit time: the request stays `approved`; the user runs `/workday link`, then `/workday submit apr_...` again (no new approval needed).
- Definitive Workday 4xx (validation, permission): request `failed`, user starts again.

## Slack delivery

- `SLACK_APPROVAL_DELIVERY=explicit` plus `SLACK_BOT_TOKEN` (scopes `commands`, `chat:write`, `im:write`) turns on approver DMs, requester receipts, and decision messages. `SLACK_APPROVAL_CHANNEL_ID` is only the fallback when no assigned approver has an active link.
- Delivery never blocks a request. Log line `evt: approval_delivery` carries `recipients` and a `reason` (`delivery_not_enabled`, `delivery_not_configured`, `no_recipients`, `timeout`). `post_failed` / `respond_failed` carry Slack's error code (for example `channel_not_found`, `not_in_channel`, `missing_scope`).
- Form notifications run after the Slack ack (log `approval_delivery`). If the database is slow, the modal shows "Submitting" and the requester gets a DM with the request id (`form_late_created`) or the error (`form_late_error`). `background_timeout`, `background_failed` and `background_refused` mean a post-ack task did not finish; the request itself is unaffected. On SIGTERM the server drains these tasks for up to 8 s before closing the pool.
- A request whose DMs failed is still valid: the requester has the id in the modal receipt or via `admin approvals-list`, approvers can be told the id, and `/workday status apr_...` works for both.
- Slow Workday on submit: the user sees "Submitting" at once and the result replaces it when Workday answers (response_url, valid 30 minutes). If the process dies in between, the request is `committing` and shows up under `approvals-list --status reconcile` after 10 minutes; the user can run `/workday status`.
- `respond_failed` with `bad_response_url` means an interaction payload carried a non-Slack URL; the action itself was still processed for the verified caller. Treat repeated occurrences as a tampering signal.

## Approval windows

- `APPROVAL_DECISION_TTL_MS` (default 72 h): time an approver has to approve or reject after the request is created. Then it becomes `expired`.
- `APPROVAL_COMMIT_WINDOW_MS` (default 24 h): time the requester has to run `/workday submit` after approval. Then it becomes `expired` and the user starts again.
- Both accept 1 minute to 14 days. Expiry is evaluated by the database clock.

## Account linking identity

`/workday link` binds the Slack user to the user id an admin entered with `link-invite`, but nothing yet checks that the Workday account that signs in is that same user. Consequences:

- Roles, grants/denies and approver policy apply to the invited user id, while Workday data access follows whoever signed in (every Workday call uses that token and the `me` entry, so nobody reads more than their own Workday security allows).
- The sign-in URL works for whoever opens it within 10 minutes. If a user forwards it, the other person's Workday account gets linked to the first user's Slack identity.

Production startup requires `LINK_ACCEPT_UNVERIFIED_SIGNER=true` as an explicit acknowledgement. Remove the need for it by validating a Workday "who am I" endpoint in sandbox and comparing it to the invited user id in `LinkService.callback` (`src/integrations/link.ts`).

## Logs

JSON lines on stderr. Keys matching token, secret, password, authorization, code, cookie, email, text, comment are redacted. Message text from Slack is not logged or stored (intake keeps metadata only).

## Backups and retention

Back up Postgres with your standard tooling. `oauth_tokens` is encrypted; the key is not in the database. Expired `slack_replay`, `form_sessions` and `oauth_states` rows are pruned every minute in-process. Define retention for `approval_requests` and `admin_audit` per your policy (no automatic deletion).
