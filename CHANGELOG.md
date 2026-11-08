# Changelog

## Unreleased

### Changed (Slack UI and ack performance)
- Approval lifecycle runs inside Slack: a form submission DMs each assigned approver (Approve / Reject buttons, requester mention, decision deadline) and sends the requester a receipt; a decision replaces the approver's message and DMs the requester, with a "Submit to Workday" button when approved; Submit commits through `ApprovalExecutionService.commitApproved` with the requester's token and the ledger. `SLACK_APPROVAL_DELIVERY=explicit` gates the DMs; `SLACK_APPROVAL_CHANNEL_ID` is now a fallback only. `src/integrations/slack/notify.ts` (`SlackApprovalNotifier`), `interactions.ts`, new `submit.ts`.
- Slow commits no longer sit inside the Slack ack: the ack says "Submitting" after the 2.5 s budget and the result replaces it through the interaction's `response_url` (command and button). `response_url` is accepted only on `https://hooks.slack.com/`.
- No Workday token endpoint call inside a Slack ack: `ApprovalExecutionService` takes `linked` (stored link exists) for propose; the refresh happens at commit.
- `SlackApi` gained `postMessage` and `respond`; every Slack call has an 8 s timeout. Reverse lookup `slackFor` on `DbIdentityLinks` and `IdentityDirectory` (notifications only).
- Friendlier Slack error texts (`SELF_APPROVAL`, `NOT_APPROVER`, `NOT_REQUESTER`, `HASH_MISMATCH`, `NOT_FOUND`), `/workday help`.
- Docs: `docs/MCP-AUTHORIZATION.md` maps the MCP authorization spec revision 2026-07-28 to both runtimes (stdio: credentials from the environment; HTTP runtime: not an MCP endpoint; client-side rules met; what an HTTP MCP transport would need). INTEGRATIONS.md "Slack UI flow", RUNBOOK "Slack delivery".
- Checks: `check:integrations` 38 (delivery targets, response_url handling, Submit button), `check:durable` adds Slack UI lifecycle, slow-commit follow-up, foreign response_url, and no-refresh-in-ack.

### Changed (hardening pass)
- Per-user denies apply to the original time-off tools (`assertToolAllowedForUser`); MCP tool hints come from the registry (cancel/deny destructive, previews not idempotent).
- Live mode requires `WORKDAY_TOKEN_ENCRYPTION_KEY` (32+ chars, no fallback); token file written atomically, owner-only. Production requires `LINK_ACCEPT_UNVERIFIED_SIGNER=true` (see RUNBOOK "Account linking identity"). Audit log redacts comment-like fields. Production host detection by pattern.
- Token refresh distinguishes a refused grant (token deleted, re-link) from an outage or timeout (token kept, "temporarily unavailable"); 15 s token endpoint timeout; 30 s idle-in-transaction timeout.
- A missing link at commit leaves the request `approved` for a retry after re-linking; sign-in and preview errors are not pinned to the idempotency key.
- Approval windows: `APPROVAL_DECISION_TTL_MS` (72 h) and `APPROVAL_COMMIT_WINDOW_MS` (24 h), evaluated by the database clock. Form errors (day count, link, permissions) shown on the modal before the session is consumed.
- Stdio server split into `src/mcp-server.ts` with a loopback OAuth callback (`src/auth/loopback-callback.ts`) for live mode; `check:mcp` drives the real tools over an in-memory transport. Pending sign-ins expire and are capped. `pruneExpired` covers replay keys, form sessions, and OAuth states.

### Added (production runtime)
- `src/server/main.ts` HTTP runtime (`npm run serve`) with config validation, `/healthz`, `/readyz`, OAuth callback, request/header timeouts, graceful shutdown, Dockerfile.
- Postgres storage (`src/store`): migrations, replay guard, form sessions, identity links, role entitlements, approval policies, approvals, commit ledger, encrypted tokens and PKCE states, admin audit.
- Account linking via `/workday link` (admin invite, PKCE, single-use state). Audited admin CLI (`npm run admin`).
- Commit ledger with uncertain-result handling and operator reconcile; no automatic resubmits.
- Workday client rewritten to REST Directory paths (`/workers/me/requestTimeOff`, `/workers/me/timeOffDetails`), pinned version via `WORKDAY_ABSENCE_API_VERSION`, per-operation sandbox validation gate, timeouts, ambiguity classification.
- `check:durable` (17 checks, PGlite or real Postgres), `npm run check`. Docs: RUNBOOK, SANDBOX-TESTING, AGENTS.md.

### Changed
- `loadConfig(env)` now reads booleans from the passed env (previously read process.env).
- Slack handlers are async with pluggable replay, session, and identity stores. Unlinked `/workday` callers get a link hint.
- In-memory single-process Slack server and its guard removed in favor of the durable runtime.

### Added (second pass)
- Signed `/workday` slash command and `wd_time_off_shortcut` global shortcut open the Block Kit modal via `views.open` (injectable Slack API, 2.5 s ack budget). `submit` and `status` subcommands.
- `ApprovalExecutionService`: approvals bind the exact Workday payload and a preview-token fingerprint; commit runs a fixed executor through the shared time-off core with the requester's token.
- `src/tools/time-off-core.ts`: preview/commit logic shared with the existing MCP tools (refactor, same behavior).
- `PreviewStore.peek`, `ApprovalWorkflow.list`.
- Notion fetcher: pinned version, page check, pagination, nested blocks with limits, child pages not followed.
- Single-instance guard for the Slack server. Approval TTL lowered to 15 minutes to match preview TTL.
- `check:integrations` now 41 checks including router end-to-end flows.

### Added
- Slack Events intake with v0 signature verification, replay protection, size caps, workspace and channel allowlists, bot/self ignore, server-side identity binding, redacted logs. No automatic replies.
- Slack Block Kit time-off modal with opaque single-use nonce, owner and expiry binding, Zod validation.
- Slack approve/reject interactions bound to verified identities; explicit-only approval delivery.
- Approval workflow: hash-bound previews, server policy approvers, no self approval by default, terminal rejection, expiry, RBAC recheck at commit, idempotency, single execution under concurrent commits, optional round-robin approver assignment.
- Notion knowledge reads: server policy allowlist intersected with caller entitlement; delegated or allowlist-limited service token; fail closed.
- `src/ai/integration-agent.ts`: permission-built read toolset, propose-only write tools, untrusted-content wrapping, guardrail system prompt, all on the existing AI SDK path.
- `npm run check:integrations` (31 offline checks), `docs/INTEGRATIONS.md`, example policy files.

## 9245750
- Enterprise user permission assignments (deny, grant, role) and AI SDK agent.
