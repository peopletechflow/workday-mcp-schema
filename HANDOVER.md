# Handover

## Current state
- Layer-3 MCP server with RBAC (roles plus per-user grants/denies), Agent-Ready catalog, AI SDK agent.
- Slack and Notion integrations plus approval workflow, fixture-tested, disabled by default. See docs/INTEGRATIONS.md.

## Checks
`npm run typecheck`, `npm run check:rbac`, `npm run check:integrations`.

## To go live (not done)
1. Create a Slack app in a sandbox workspace: Events (`message.channels`, `app_mention`) to `/slack/events`, Interactivity to `/slack/interactions`. Set signing secret and allowlists via env.
2. Build the identity link flow that fills `SLACK_IDENTITY_MAP_PATH` (or replace with a DB-backed IdentityDirectory).
3. Add a slash command or shortcut that calls `startTimeOffForm` then Slack `views.open`.
4. Wire `ApprovalWorkflow.commit` executor to the existing Workday commit path.
5. Replace in-memory stores with a shared transactional store.
6. Pick Notion mode, create the resource policy, share only those pages with the integration.
