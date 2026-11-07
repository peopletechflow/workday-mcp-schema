# Slack and Notion integrations: architecture and security

Status: implemented and covered by offline fixture checks (`npm run check:integrations`, 41 checks). Never run against a live Slack workspace, Notion workspace, or Workday tenant. Not production ready: all state is in memory in one process. Everything is disabled unless configured.

See also: [ARCHITECTURE.md](./ARCHITECTURE.md), [RBAC.md](./RBAC.md), [README](../README.md).

## Pieces

| Area | Code | What it does |
| --- | --- | --- |
| Config | `src/integrations/config.ts` | Reads env references. Slack and Notion off by default. Enabling without allowlists, identity map, or policy file throws. |
| Identity binding | `src/integrations/identity.ts` | Server-maintained map of Slack (team, user) to (tenant, user). Payload emails, display names, and model output are never used for identity. |
| Slack signing | `src/integrations/slack/verify.ts` | v0 HMAC over the exact raw body, 300 s timestamp window, constant-time compare, replay cache. |
| Slack intake | `src/integrations/slack/intake.ts` | Events API: size cap, workspace and channel allowlists, team mismatch check, ignores bots, self, and edited/subtype messages, binds identity, stores a truncated record as untrusted data, logs only fingerprints and counts. Never replies. |
| Slack forms | `src/integrations/slack/forms.ts` | Block Kit modal for time off. `private_metadata` is an opaque random nonce; the server keeps owner (team+user), tenant, kind, and expiry. Zod validation returns Slack `response_action: errors`. A valid submit consumes the nonce and creates an approval request. It never commits. |
| Approval buttons | `src/integrations/slack/interactions.ts` | Signed `block_actions`; approver is the verified Slack caller resolved through the identity map. Button value holds request id and change hash only. |
| Approval delivery | `src/integrations/slack/notify.ts` | Posts approval blocks only when explicitly called AND `SLACK_APPROVAL_DELIVERY=explicit` with channel and bot token set. Intake never calls it. |
| Approval workflow | `src/integrations/approvals/workflow.ts` | Preview bound to tenant, requester, commit tool, resource, and sha256 of canonical change. Server policy lists approvers per tenant and tool. |
| Notion | `src/integrations/notion/access.ts` | Policy allowlist intersected with caller entitlement, then a token (delegated per-user or allowlist-limited service token). |
| Agent | `src/ai/integration-agent.ts` | Toolset built from caller permissions, all model calls via `src/ai/client.ts` (AI SDK + AI Gateway). |
| Slash command and shortcut | `src/integrations/slack/commands.ts`, `slack/api.ts` | Signed `/workday` command (workspace + channel allowlist, mapped caller): no text or `timeoff` opens the modal with `views.open` and the trigger id; `submit apr_...` commits an approved request (requester only); `status apr_...` for requester or assigned approver. Global shortcut `wd_time_off_shortcut` opens the same modal. Only the HTTP ack body is returned (ephemeral); nothing is posted. `views.open` and commit run inside a 2.5 s budget so the ack stays inside Slack's 3 s limit. The Slack API client is injectable and exposes only `views.open`. |
| Approval execution | `src/integrations/approvals/execution.ts` | Fixed server-side executor (not supplied by any caller). See below. |
| Time-off core | `src/tools/time-off-core.ts` | Preview and commit logic shared by the MCP tools `preview_request_time_off` / `commit_request_time_off` and the approval service. |
| HTTP | `src/integrations/http.ts` | `createSlackRouter` (pure, used by checks) and `createSlackServer` for `/slack/events`, `/slack/commands`, `/slack/interactions`. Raw body with size cap. Refuses multi-instance settings. Returns undefined when Slack is disabled. |

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
## Approval execution path (time off)

1. Propose (Slack form or agent `propose_time_off_request`): identity tenant must equal `WORKDAY_TENANT` (token store is single tenant); requester must pass RBAC for both `preview_request_time_off` and `commit_request_time_off`; the form type maps to a Workday id through a server-side map (`DEFAULT_TIME_OFF_TYPE_MAP`, override in code); the existing preview core mints a preview token after confirming the requester's Workday session. The approval change contains the exact Workday payload (`willSubmit`), target `worker:<id>:self`, and a sha256 fingerprint of the preview token. The raw token stays only in service memory.
2. Approve: signed Slack button, approver from the identity map and policy, as described above.
3. Commit: signed `/workday submit apr_...`. Caller identity comes only from the verified Slack request. The workflow rechecks status, expiry, tenant, requester, hash, and requester RBAC; the fixed executor checks the preview token fingerprint, re-reads the preview and requires it to equal the approved payload, then calls the same commit core as `commit_request_time_off`: consume preview, requester's own Workday token, duplicate check (`findMatchingTimeOffRequest`), submit, idempotency store. The idempotency key is derived from the request id, so Slack retries do not double-submit. A Workday failure marks the request `failed` (terminal).
4. Approval TTL is 15 minutes, never longer than the preview TTL, so an approved request cannot outlive its preview.

Scope checks: this path only does self-service time off for the caller's own worker record (`/workers/me` on the caller's token). Team, org, and pay-group proofs do not apply to self time off and are not bypassed; manager approve/deny and other writes are not wired into this approval path (their tools are fixture-only scaffolds). Workday business process routing happens inside Workday on submit.

## Workday adapter status (honest)

- `FixtureWorkdayClient`: used by all offline checks. Records submissions in memory.
- `HttpWorkdayClient` (`src/workday/client.ts`): registry marks time-off tools `live-stub`. It calls `{base}/api/absenceManagement/v1/{tenant}/workers/me/timeOffRequest`. These paths have not been verified against a tenant, and Workday's public REST docs describe time-off requests under `workers/{ID}/requestTimeOff`, so expect to adjust paths and payload shape during sandbox testing. No live Workday call has been made from this repo.

## Notion: what is and is not per-user

Notion fetcher contract: see `createNotionHttpFetcher` (Notion-Version 2022-06-28, page check, paginated block children, depth and request budget, child pages not followed).

Notion internal integration tokens are service credentials that see every page shared with the integration. Notion public integrations use OAuth, but the token covers pages the installing user shared with the integration; it does not mirror each Notion user's page permissions per request. This repo therefore does not claim per-user Notion permission enforcement by Notion itself.

Every read requires: resource in `NOTION_RESOURCE_POLICY_PATH` for the caller's tenant, caller entitled by role or user id, caller not in `deniedUserIds`, and then a token. `NOTION_MODE=delegated` uses only the caller's stored token (missing token denies). `NOTION_MODE=allowlist` uses `NOTION_SERVICE_TOKEN` only for resources that passed the policy check. There is no fallback to arbitrary pages.

## Tested vs not verified

Tested offline (fixtures, no network): signature, stale timestamp, body tamper, replay, size caps, workspace/channel/user spoofing, team mismatch, bot/self ignore, modal nonce tamper/owner/expiry/reuse, validation errors, Notion denial cases (not entitled, denied user, cross tenant, missing user token, missing service token, disabled), prompt injection wrapping, toolset construction from permissions, deny overrides at build and execute, self approval, non approver, cross tenant, hash mismatch, expired, rejected terminal, idempotent retry, concurrent commit race, permission recheck at commit, delivery off by default.

Also tested offline: slash command opens modal through an injected Slack API with the trigger id and an empty ack; forged, other workspace, other channel, unlinked, and unknown command requests denied without calling Slack; slow `views.open` acked within budget; shortcut opens modal; full router flow (command, modal, submit, self-approval denied, approver approves, non-requester submit denied, requester submit commits once through the fixture Workday client, repeat submit returns the same event); changed preview refused; deny after approval blocks commit; cross tenant and unmapped type refused; Workday failure terminal; multi-instance settings refused; Notion API contract with a fake `fetch` (pinned version, page check, pagination, nested blocks, child pages and synced copies not followed, archived or non-page denied, request budget).

Not verified: a real Slack app, real Notion API responses, real model behavior, real Workday HTTP paths.

## Production gaps

- Everything is in memory in one process: replay cache, form sessions, approval requests, preview tokens, idempotency. A restart loses all pending and approved requests (users must start over). This cannot run distributed: `createSlackServer` refuses `WEB_CONCURRENCY>1`, `INTEGRATIONS_INSTANCE_COUNT>1`, PM2 instances other than 0, and cluster workers. A shared transactional store is required before production.
- The Slack HTTP server and the stdio MCP server are separate processes with separate stores; an approval created in Slack can only be committed through Slack `/workday submit`.
- Token store is keyed by user id within one Workday tenant per deployment.
- Identity map must be populated from an authenticated link flow (Workday OAuth sign-in plus Slack OAuth `users.identity` or admin-approved mapping), not from Slack profile emails.
