# Slack and Notion integrations: architecture and security

Status: implemented and covered by offline fixture checks (`npm run check:integrations`). Not yet run against a live Slack workspace or Notion workspace. Everything is disabled unless configured.

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
| HTTP | `src/integrations/http.ts` | `node:http` handler for `/slack/events` and `/slack/interactions`, raw body with size cap. Returns undefined when Slack is disabled. |

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
- Existing Workday guards stay: the commit executor you wire should call the existing preview/commit path (`src/tools/*`, `src/safety/native-write-guard.ts`) so business process, team/org/pay-group proofs, and Workday security on the user token still apply.

## Notion: what is and is not per-user

Notion internal integration tokens are service credentials that see every page shared with the integration. Notion public integrations use OAuth, but the token covers pages the installing user shared with the integration; it does not mirror each Notion user's page permissions per request. This repo therefore does not claim per-user Notion permission enforcement by Notion itself.

Every read requires: resource in `NOTION_RESOURCE_POLICY_PATH` for the caller's tenant, caller entitled by role or user id, caller not in `deniedUserIds`, and then a token. `NOTION_MODE=delegated` uses only the caller's stored token (missing token denies). `NOTION_MODE=allowlist` uses `NOTION_SERVICE_TOKEN` only for resources that passed the policy check. There is no fallback to arbitrary pages.

## Tested vs not verified

Tested offline (fixtures, no network): signature, stale timestamp, body tamper, replay, size caps, workspace/channel/user spoofing, team mismatch, bot/self ignore, modal nonce tamper/owner/expiry/reuse, validation errors, Notion denial cases (not entitled, denied user, cross tenant, missing user token, missing service token, disabled), prompt injection wrapping, toolset construction from permissions, deny overrides at build and execute, self approval, non approver, cross tenant, hash mismatch, expired, rejected terminal, idempotent retry, concurrent commit race, permission recheck at commit, delivery off by default.

Not verified: live Slack app (slash command or shortcut to call `views.open` with `startTimeOffForm`), live Notion API response parsing (`notionHttpFetcher`), live model behavior, live Workday commit executor wiring, multi-instance deployment.

## Production gaps

- Stores are in memory (replay cache, form sessions, approval requests, idempotency). Use a shared transactional store (row lock or compare-and-set on status) before running more than one instance.
- `views.open` (opening the modal from a slash command) and the commit executor binding to the live Workday path are integration points left to the deployment.
- Identity map must be populated from an authenticated link flow (Workday OAuth sign-in plus Slack OAuth `users.identity` or admin-approved mapping), not from Slack profile emails.
