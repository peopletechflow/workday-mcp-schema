# Slack and Notion integrations: architecture and security

Status: production runtime implemented (`src/server/main.ts`) with Postgres state, account linking, entitlements, and a commit ledger. Covered by offline checks (`pnpm run check`); never run against a live Slack workspace, Notion workspace, or Workday tenant. Live Workday operations stay blocked until validated in a sandbox ([SANDBOX-TESTING.md](./SANDBOX-TESTING.md)). Operations: [RUNBOOK.md](./RUNBOOK.md).

See also: [ARCHITECTURE.md](./ARCHITECTURE.md), [RBAC.md](./RBAC.md), [README](../README.md).

## Pieces

| Area | Code | What it does |
| --- | --- | --- |
| Config | `src/integrations/config.ts` | Reads env references. Slack and Notion off by default. Enabling without allowlists, identity map, or policy file throws. |
| Identity binding | `src/integrations/identity.ts`, `src/store/repos.ts` | Production: `identity_links` table (admin invite, activated by OAuth). Library/tests: server-maintained map of Slack (team, user) to (tenant, user). Payload emails, display names, and model output are never used for identity. |
| Slack signing | `src/integrations/slack/verify.ts` | v0 HMAC over the exact raw body, 300 s timestamp window, constant-time compare, replay cache. |
| Slack intake | `src/integrations/slack/intake.ts` | Events API: size cap, workspace and channel allowlists, team mismatch check, ignores bots, self, and edited/subtype messages, binds identity, stores a truncated record as untrusted data, logs only fingerprints and counts. Never replies. |
| Slack forms | `src/integrations/slack/forms.ts` | Block Kit modal for time off. `private_metadata` is an opaque random nonce; the server keeps owner (team+user), tenant, kind, and expiry. Zod validation returns Slack `response_action: errors`. A valid submit consumes the nonce in the same transaction that creates the approval request (a failure leaves the form usable; a second submit cannot create a second request). If that takes longer than 2.5 s the ack shows a "Submitting" view and the outcome is DMed. Approver notifications run after the ack. It never commits. |
| Approval buttons | `src/integrations/slack/interactions.ts`, `slack/submit.ts` | Signed `block_actions`. Approve / Reject: approver is the verified Slack caller resolved through the identity map; button value holds request id and change hash only. Submit to Workday: requester only (checked by `beginCommit`), deterministic idempotency key per request, shared with `/workday submit`. Feedback through the interaction's `response_url` (hooks.slack.com only): a decision replaces the message, a refused click gets an ephemeral note and keeps the buttons. |
| Approval delivery | `src/integrations/slack/notify.ts` | `SlackApprovalNotifier`. With `SLACK_APPROVAL_DELIVERY=explicit` and a bot token: a form submission DMs each assigned approver (fallback: `SLACK_APPROVAL_CHANNEL_ID` when no approver has an active link) and sends the requester a receipt; a decision DMs the requester (Submit button when approved). Messages carry the summary and ids, never the comment. Intake and the agent never call it. |
| Approval workflow | `src/integrations/approvals/workflow.ts` | Preview bound to tenant, requester, commit tool, resource, and sha256 of canonical change. Server policy lists approvers per tenant and tool. |
| Notion | `src/integrations/notion/access.ts` | Policy allowlist intersected with caller entitlement, then a token (delegated per-user or allowlist-limited service token). |
| Agent | `src/ai/integration-agent.ts` | Toolset built from caller permissions, all model calls via `src/ai/client.ts` (AI SDK + AI Gateway). |
| Slash command and shortcut | `src/integrations/slack/commands.ts`, `slack/api.ts` | Signed `/workday` command (workspace + channel allowlist, mapped caller): no text or `timeoff` opens the modal with `views.open` and the trigger id; `submit apr_...` commits an approved request (requester only); `status apr_...` for requester or assigned approver; `link`; `help`. Global shortcut `wd_time_off_shortcut` opens the same modal. The ack body is ephemeral; nothing is posted to channels. `views.open` and commit run inside a 2.5 s budget so the ack stays inside Slack's 3 s limit; a slower commit finishes in the background and its result replaces the ack through the command's `response_url`. The Slack API client is injectable and exposes `views.open`, `chat.postMessage`, and `response_url` posts, each bounded by an 8 s timeout. |
| Approval execution | `src/integrations/approvals/execution.ts` | Fixed server-side executor (not supplied by any caller). See below. |
| Time-off core | `src/tools/time-off-core.ts` | Preview and commit logic shared by the MCP tools `preview_request_time_off` / `commit_request_time_off` and the approval service. |
| HTTP | `src/integrations/http.ts`, `src/server/*` | Router for `/healthz`, `/readyz`, `/oauth/callback`, `/slack/events`, `/slack/commands`, `/slack/interactions`; node:http server with timeouts and body cap; runtime composition and config validation. |

## Read skill vs write workflow

- Read skill: Layer-3 `read` tools the caller passes `assertToolAllowedForUser` for (deny, then grant, then role), plus `notion_read_page` limited to an enum of the caller's entitled pages. Each execute rechecks permission. Results are wrapped in `<untrusted_data>` with embedded tag lookalikes neutralized.
- Write workflow: `propose_time_off_request` exists only if the caller may use `commit_request_time_off`. Its strict schema has no identity fields; requester and tenant come from the server session. It creates a pending approval request. The agent has no preview-commit, commit, or approve tool, so it cannot self-approve.
- System prompt (`INTEGRATION_SYSTEM_PROMPT`) tells the model that wrapped content is data and that missing tools mean no permission. This is defense in depth. Authorization is enforced in code.

## Approval lifecycle

`pending` then `approved` or `rejected` or `expired`. `approved` then `committing` then `committed` or `failed`. Rejected, expired, committed, failed are terminal.

- Propose: commit tool must be a registered `write-commit`; requester must pass RBAC (deny overrides grant and role); a tenant policy must exist; at least one approver other than the requester unless `allowSelfApproval` is true.
- Decide: same tenant, still pending and unexpired, presented hash equals stored hash, approver listed by policy (and assigned, if rotation is on), not the requester unless allowed.
- Commit: requester only, same tenant, approved, unexpired, hash recomputed, RBAC rechecked now, status set to `committing` synchronously before the executor runs, idempotency key returns the stored result.
- Optional `rotate: true` assigns one approver per request in round-robin order from the policy list. It narrows, never widens, the approver set.
## Slack UI flow

Everything a worker or approver needs happens inside Slack; `/workday submit` and `/workday status` remain as fallbacks.

1. Worker runs `/workday` (or the global shortcut). The modal opens with `views.open`.
2. Worker submits. Before the form session is consumed, `checkTimeOff` validates entitlements, type mapping, date range, the exact Workday payload, and that a Workday link exists. Fixable problems are shown on the modal fields; the same form can be corrected and resubmitted. A valid submission creates a pending approval and the modal closes.
3. Each assigned approver (minus the requester) gets a DM with the summary, the requester mention, the decision deadline, and Approve / Reject buttons. The requester gets a receipt with the request id. Delivery is bounded by the ack budget and never blocks the request: a delivery failure is logged (`evt: approval_delivery`) and the id still works with `/workday status`.
4. An approver clicks. The DM is replaced with the decision (buttons gone). The requester gets a DM: approved means a "Submit to Workday" button and the submit deadline, rejected means a notice. A second approver clicking later sees an ephemeral "Request is approved" note.
5. The requester clicks Submit (or runs `/workday submit apr_...`). The commit runs through `ApprovalExecutionService.commitApproved` with the requester's own Workday token and the ledger. Inside the 2.5 s budget the result replaces the message; otherwise "Submitting" replaces it now and the result follows through the same `response_url` when Workday answers. A refused submit (not linked, denied, expired) is an ephemeral note and the button stays, so re-linking and clicking again works without a new approval.

Performance rules behind the flow:

- No Workday token endpoint call happens inside a Slack ack. Propose checks only that a stored link exists (`linked`); the refresh happens at commit, which is the step allowed to run past the ack.
- Every Slack Web API call has a timeout (`SLACK_HTTP_TIMEOUT_MS`), and every call inside an ack additionally runs under `withinBudget`.
- `response_url` targets are accepted only on `https://hooks.slack.com/`, so a forged interaction payload cannot make the runtime post elsewhere.
- Delivery and decision messages contain the request summary (type, dates, days), ids, and Slack mentions. The free-text comment never leaves the database.

Slack app requirements: slash command `/workday` and interactivity pointed at `/slack/commands` and `/slack/interactions`; global shortcut `wd_time_off_shortcut`; bot scopes `commands`, `chat:write`, `im:write` (DMs to approvers and requesters). Proposals created by the agent or the API (`source: agent | api`) are not delivered to Slack automatically; they are visible through `/workday status` and the admin CLI.

## Production runtime (durable)

- State: Postgres (`src/store`). Replay keys, form nonces, identity links, role entitlements, approval policies, approvals, commit ledger, encrypted OAuth tokens and PKCE states, admin audit. Safe for multiple instances; restarts lose nothing.
- Identity: admin invites a Slack user for a tenant user id (`admin link-invite`); the link becomes active only after that Slack user completes Workday OAuth (`/workday link`, PKCE, single-use state bound to the Slack user). Only active links resolve. `link-revoke` deletes tokens.
- Entitlements: roles, grants, denies per user in `role_assignments`, managed by the audited admin CLI. Deny overrides grant and role. No JSON file or request body sets roles in this runtime.
- Tokens: AES-256-GCM per user, AAD bound to tenant+user, key from `TOKEN_ENCRYPTION_KEY` (no fallback), previous key for rotation. Refresh under a row lock; refresh failure deletes the token and requires relink.
- Approvals: proposal stores the exact Workday payload (`willSubmit`) and target, hash bound. Approver from verified Slack identity and DB policy (optional rotation). Commit by the requester only (`/workday submit`), executor fixed in `ApprovalExecutionService`.
- Commit ledger: begin (row lock, recheck status, expiry, hash, requester RBAC; ledger `in_flight`), Workday duplicate check and submit with the requester's own token, finish. Definitive 4xx: `failed`. Timeout, 5xx, 408, 429, or 2xx without id: `unknown`, never resubmitted; operator `reconcile`. Crash mid-submit: stays `committing`, flagged after 10 minutes.
- Workday contract gate: see SANDBOX-TESTING.md. Unvalidated operations fail closed before any state change.
- Scope: self-service time off only (`/workers/me`). Manager approve/deny and other writes are not wired. Workday BP runs inside Workday.

## Notion: what is and is not per-user

Notion fetcher contract: see `createNotionHttpFetcher` (Notion-Version 2022-06-28, page check, paginated block children, depth and request budget, child pages not followed).

Notion internal integration tokens are service credentials that see every page shared with the integration. Notion public integrations use OAuth, but the token covers pages the installing user shared with the integration; it does not mirror each Notion user's page permissions per request. This repo therefore does not claim per-user Notion permission enforcement by Notion itself.

Every read requires: resource in `NOTION_RESOURCE_POLICY_PATH` for the caller's tenant, caller entitled by role or user id, caller not in `deniedUserIds`, and then a token. `NOTION_MODE=delegated` uses only the caller's stored token (missing token denies). `NOTION_MODE=allowlist` uses `NOTION_SERVICE_TOKEN` only for resources that passed the policy check. There is no fallback to arbitrary pages.

## Tested vs not verified

Tested offline (fixtures, no network): signature, stale timestamp, body tamper, replay, size caps, workspace/channel/user spoofing, team mismatch, bot/self ignore, modal nonce tamper/owner/expiry/reuse, validation errors, Notion denial cases (not entitled, denied user, cross tenant, missing user token, missing service token, disabled), prompt injection wrapping, toolset construction from permissions, deny overrides at build and execute, self approval, non approver, cross tenant, hash mismatch, expired, rejected terminal, idempotent retry, concurrent commit race, permission recheck at commit, delivery off by default.

Also tested offline: Slack UI lifecycle through the router (form submission DMs assigned approvers and the requester, Approve replaces the message and DMs a Submit button, Submit commits once, late approver gets an ephemeral note, no Workday ids, tokens, or comment text in any Slack payload); slow commit acked within budget with the result delivered through `response_url` for both the command and the button; non-Slack `response_url` never called; form submission with an expired access token makes no token endpoint call; slash command opens modal through an injected Slack API with the trigger id and an empty ack; forged, other workspace, other channel, unlinked, and unknown command requests denied without calling Slack; slow `views.open` acked within budget; shortcut opens modal; full router flow (command, modal, submit, self-approval denied, approver approves, non-requester submit denied, requester submit commits once through the fixture Workday client, repeat submit returns the same event); changed preview refused; deny after approval blocks commit; cross tenant and unmapped type refused; Workday failure terminal; plus `check:durable` (restart, multi-instance races, uncertain results, linking, encryption, contract gate); Notion API contract with a fake `fetch` (pinned version, page check, pagination, nested blocks, child pages and synced copies not followed, archived or non-page denied, request budget).

Not verified: a real Slack app, real Notion API responses, real model behavior, real Workday HTTP paths.

## Remaining gaps

- Live validation of Workday request/response contracts in a sandbox (gate stays closed until then).
- Linking cannot verify which Workday worker signed in; calls use `me`, so access is the signer's own.
- Intake keeps only metadata; there is no conversation store or autonomous agent loop by design.
- Agent and API proposals are not delivered to Slack; only form submissions are. Approver DMs show the requester's Slack mention (from the active link), not a Workday display name.
- A requester whose Submit message was lost (for example Slack DM failed) still has `/workday submit apr_...`.
- The stdio MCP server (`pnpm start`) still uses its file token store and in-memory preview store; it is a single-user developer surface, not the production runtime.
