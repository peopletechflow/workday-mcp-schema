# Testing against a Workday sandbox tenant

Nothing in this repo has been run against a real tenant. Offline checks prove the logic, not Workday's contract. Use an implementation or sandbox tenant only (`WORKDAY_ALLOW_PROD` stays false).

## What works offline today

```bash
npm ci
npm run check            # typecheck + check:rbac + check:integrations + check:durable (PGlite)
CHECK_DATABASE_URL=postgresql://... npm run check:durable   # same suite on a real Postgres
```

## What is blocked until sandbox validation

Every live Workday operation is gated by `WORKDAY_VALIDATED_OPERATIONS` and fails closed (no network call) until you list it:

| Operation | Path (verified in Workday REST Directory) | Not verified |
| --- | --- | --- |
| `timeOffDetails.list` | `GET /ccx/api/absenceManagement/{version}/{tenant}/workers/me/timeOffDetails` | `fromDate` / `toDate` filter names, response field names |
| `requestTimeOff.create` | `POST .../workers/me/requestTimeOff` ("creates a time off request ... and initiates the business process") | body shape `days[].date, dailyQuantity, timeOffType.id, comment`, response `id` |
| `balances.list` | `GET .../balances` | worker query parameter name |

Source: Workday REST Directory, absenceManagement (https://community.workday.com/sites/default/files/file-hosting/restapi/). Body and filter names in this repo come from non-official specs and must be confirmed against your tenant's REST directory for the version you pin in `WORKDAY_ABSENCE_API_VERSION`. Account linking does not verify which Workday worker signed in (no validated "who am I" call); all calls use the `me` entry, so a token only ever acts as its signer.

## Prerequisites in Workday (your admin)

1. An API client for the integration using OAuth 2.0 authorization code grant, with redirect URI `https://<your-host>/oauth/callback` and only the functional-area scope needed for time off. Record the client id/secret and the tenant's authorize and token endpoints (shown when the client is registered).
2. A least-privilege test worker in the sandbox who can request their own time off, plus an approver test user. A prior browser login to the tenant does not replace this: the server needs its own OAuth consent and stores its own token.
3. The time-off type ids you will map in `WORKDAY_TIME_OFF_TYPE_MAP`.

## Step-by-step (read first, then one write)

```bash
cp .env.example .env    # fill WORKDAY_*, WORKDAY_USE_FIXTURES=false, WORKDAY_ABSENCE_API_VERSION, DATABASE_URL, Slack values
npm run build
npm run admin -- keygen # put TOKEN_ENCRYPTION_KEY / _ID into .env
set -a; . ./.env; set +a
npm run db:migrate
npm run admin -- roles-set --user-id tester1 --roles worker_self --actor you
npm run admin -- roles-set --user-id approver1 --roles worker_self,manager --actor you
npm run admin -- policy-set --approvers approver1 --actor you
npm run admin -- link-invite --slack-team T... --slack-user U_TESTER --user-id tester1 --actor you
npm run admin -- link-invite --slack-team T... --slack-user U_APPROVER --user-id approver1 --actor you
npm run serve
```

1. Expose the server over https to Slack (sandbox Slack app: slash command `/workday` to `/slack/commands`, interactivity to `/slack/interactions`, events to `/slack/events`).
2. As each test user, run `/workday link` in an allowlisted channel and complete Workday sign-in. Check `/readyz` and logs.
3. Read validation: create one time-off entry for the tester in the Workday UI, then set `WORKDAY_VALIDATED_OPERATIONS=timeOffDetails.list` and run `npm run admin -- probe-time-off --user-id tester1 --from <date> --to <date> --type vacation`. It must print `match: event ...`; a date with no entry must print `no matching entries`. If not, the filter or field names differ: adjust `src/workday/client.ts`, add a contract fixture to `scripts/check-durable.ts`, rerun `npm run check`.
4. One write: add `requestTimeOff.create`, restart. As tester: `/workday` form for one future day, approver clicks Approve, tester runs `/workday submit apr_...`. Confirm in Workday that the business process started, then cancel it in Workday. Run the same submit again: it must return the stored result without a second request.
5. If the submit returns `unknown`, use `approvals-list --status reconcile` and `reconcile`.

Only after steps 3 and 4 match Workday should the contract be considered validated for that tenant and version.
