# Slack app manifest

`slack/app-manifest.json` creates the Slack app this runtime expects. It matches the handlers in `src/integrations/http.ts` and `src/integrations/slack/*` (checked by `check:integrations`).

Bot display name and handle: `workday-custom` (`features.bot_user.display_name`). The app name stays "PeopleTech Flow Workday" and the command stays `/workday`.

## Before you import

Replace every `https://REPLACE-WITH-YOUR-PUBLIC-HTTPS-HOST.example.com` with the public HTTPS origin that reaches this server (a deployment, or an HTTPS tunnel to `http://127.0.0.1:8787` for local testing). Slack cannot call `localhost`. Paths stay as they are:

| Manifest field                                                                                                   | Runtime route              |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `features.slash_commands[0].url` (`/workday`)                                                                    | `POST /slack/commands`     |
| `settings.interactivity.request_url` (modal, Approve / Reject / Submit buttons, shortcut `wd_time_off_shortcut`) | `POST /slack/interactions` |
| `settings.event_subscriptions.request_url` (`message.channels`, `app_mention`)                                   | `POST /slack/events`       |

If you rename the slash command, set `SLACK_COMMAND_NAME` to the same value.

## Scopes (bot only, least privilege)

- `commands`: the `/workday` slash command and the global shortcut.
- `chat:write`: approver DMs, requester receipts and decision messages (`chat.postMessage` to a user id).
- `im:write`: lets the app open those DMs with users.
- `channels:history` with event `message.channels`: intake of messages in allowlisted public channels the bot is in.
- `app_mentions:read` with event `app_mention`.
  No user scopes, no OAuth redirect URL (install it to your own workspace from the app settings), no private channels or DMs intake, no App Home. To add private-channel intake later you would need `groups:history` and `message.groups`; the code already applies the same channel allowlist.

## Order of setup (the events URL check needs the server running)

1. Create the app from this manifest (api.slack.com/apps, From a manifest) and install it to your workspace.
2. Put these in `.env.local` (or your deployment environment):
   - `SLACK_ENABLED=true`
   - `SLACK_SIGNING_SECRET`: Basic Information, App Credentials, Signing Secret.
   - `SLACK_BOT_TOKEN`: OAuth & Permissions, Bot User OAuth Token (`xoxb-...`), after install.
   - `SLACK_ALLOWED_TEAM_IDS`: your workspace id (`T...`).
   - `SLACK_ALLOWED_CHANNEL_IDS`: comma-separated channel ids (`C...`) where `/workday` and intake are allowed. Invite the bot to those channels.
   - `SLACK_BOT_USER_ID`: the bot's user id (`U...`), so its own messages are ignored.
   - Optional: `SLACK_APPROVAL_DELIVERY=explicit` to send approver and requester DMs; `SLACK_APPROVAL_CHANNEL_ID` as fallback when no approver has a Slack link.
3. Start the server (`pnpm dev:serve`) and the HTTPS tunnel or deployment.
4. In the app settings, verify the Event Subscriptions request URL. The runtime answers Slack's signed `url_verification` challenge only when `SLACK_ENABLED=true`, the signing secret is set, and team and channel allowlists are non-empty (otherwise startup fails closed or the route returns 404).
5. Link users and set roles before anyone can use it: `pnpm admin link-invite`, `roles-set`, `policy-set` (docs/RUNBOOK.md), then each user runs `/workday link` (needs the Workday OAuth settings).

Notes

- `/workday` works only in the allowlisted channels. The global shortcut has no channel; it checks workspace and the caller's active link.
- Workday writes stay blocked until operations are listed in `WORKDAY_VALIDATED_OPERATIONS`; with `WORKDAY_USE_FIXTURES=true` nothing reaches Workday.
