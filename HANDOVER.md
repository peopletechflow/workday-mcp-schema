# Handover

## Current state
- Layer-3 MCP server with RBAC (roles plus per-user grants/denies), Agent-Ready catalog, AI SDK agent.
- Slack (intake, `/workday` command, shortcut, modal, approval buttons), Notion reads, and the approval execution path for self-service time off. All fixture-tested offline; nothing run live. Disabled by default. See docs/INTEGRATIONS.md.

## Done and tested offline
- Signed, allowlisted slash command and shortcut open the modal via `views.open` (injectable client).
- Approved requests commit through the same preview/commit core as the MCP tools, with the requester's token, idempotency, and permission recheck.
- Notion fetcher matches the documented pages and block children contract.

## Not done / unconfigured
1. No Slack app exists. Create one in a sandbox workspace: Events to `/slack/events`, slash command `/workday` to `/slack/commands`, Interactivity (and global shortcut `wd_time_off_shortcut`) to `/slack/interactions`. Scopes: `commands`, `chat:write` only if you enable approval delivery, channel history scopes for intake.
2. Something must call `createSlackServer({ core, authzFor })` and listen; there is no CLI entry yet. `authzFor` must derive roles from Workday security groups in production.
3. Identity map is a JSON file; real account linking is out of scope.
4. Workday HTTP time-off paths are unverified (see INTEGRATIONS.md, adapter status).
5. In-memory single process: restart loses approvals; no multi-instance.
6. Notion: choose mode, write the resource policy, share only those pages.

## Checks
`npm run typecheck`, `npm run check:rbac`, `npm run check:integrations` (41).
