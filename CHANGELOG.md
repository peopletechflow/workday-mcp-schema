# Changelog

## Unreleased

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
