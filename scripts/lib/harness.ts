/** Offline harness: real runtime composition (buildRuntime) on a test Postgres with provider fakes. */
import { randomBytes } from "node:crypto";
import type { Db } from "../../src/store/db.js";
import { migrate } from "../../src/store/migrations.js";
import { buildRuntime, loadRuntimeConfig } from "../../src/server/runtime.js";
import { computeSlackSignature } from "../../src/integrations/slack/verify.js";
import type { SlackApi } from "../../src/integrations/slack/api.js";
import type { WorkdayClient } from "../../src/workday/client.js";
import { DbApprovalBackend } from "../../src/store/approvals.js";

export const SECRET = "fixture-signing-secret-0001";
export const KEY = randomBytes(32).toString("base64");
export const TEAM = "T0ALLOWED";
export const CHANNEL = "C0INTAKE";

export function baseEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    WORKDAY_USE_FIXTURES: "true",
    WORKDAY_TENANT: "acme",
    DATABASE_URL: "postgres://fixture",
    TOKEN_ENCRYPTION_KEY: KEY,
    TOKEN_ENCRYPTION_KEY_ID: "k1",
    SLACK_ENABLED: "true",
    SLACK_SIGNING_SECRET: SECRET,
    SLACK_ALLOWED_TEAM_IDS: TEAM,
    SLACK_ALLOWED_CHANNEL_IDS: CHANNEL,
    SLACK_BOT_USER_ID: "U0BOT",
    WORKDAY_OAUTH_CLIENT_ID: "fixture-client",
    WORKDAY_OAUTH_CLIENT_SECRET: "fixture-client-secret",
    WORKDAY_OAUTH_REDIRECT_URI: "https://app.example.test/oauth/callback",
    WORKDAY_OAUTH_AUTHORIZE_URL: "https://wd2-impl.workday.com/acme/authorize",
    WORKDAY_OAUTH_TOKEN_URL: "https://wd2-impl-services1.workday.com/ccx/oauth2/acme/token",
    WORKDAY_TIME_OFF_TYPE_MAP: JSON.stringify({
      vacation: { type: "Time_Off_Type_ID", value: "VACATION" },
      sick: { type: "Time_Off_Type_ID", value: "SICK" },
    }),
    ...over,
  };
}

let tsCounter = 0;
export function signed(body: string, ts?: number, secret = SECRET): Record<string, string> {
  const t = String(ts ?? Math.floor(Date.now() / 1000) - (tsCounter++ % 100));
  return { "x-slack-request-timestamp": t, "x-slack-signature": computeSlackSignature(secret, t, body) };
}

export type Instance = ReturnType<typeof buildRuntime> & { logs: string[] };

export function instance(
  db: Db,
  o: {
    env?: Record<string, string>;
    client?: WorkdayClient;
    slackApi?: SlackApi;
    fetchImpl?: typeof fetch;
    budgetMs?: number;
  } = {},
): Instance {
  const env = baseEnv(o.env);
  const logs: string[] = [];
  const rt = buildRuntime({
    cfg: loadRuntimeConfig(env),
    db,
    env,
    workdayClient: o.client,
    slackApi: o.slackApi,
    fetchImpl: o.fetchImpl,
    budgetMs: o.budgetMs,
    log: (f) => logs.push(JSON.stringify(f)),
  });
  return Object.assign(rt, { logs });
}

/** Migrate and seed links, roles, policy, and linked tokens. */
export async function seed(db: Db, opts: { approvers?: string[]; rotate?: boolean } = {}): Promise<void> {
  await migrate(db);
  const rt = instance(db);
  const users: Array<[string, string, string[]]> = [
    ["U0ALICE", "alice", ["worker_self"]],
    ["U0MGR", "mgr", ["worker_self", "manager"]],
    ["U0MALLORY", "mallory", ["worker_self"]],
    ["U0HR", "hr", ["worker_self", "hr_partner"]],
  ];
  for (const [slack, user, roles] of users) {
    await rt.links.invite("seed", { slackTeamId: TEAM, slackUserId: slack, tenantId: "acme", userId: user });
    await db.query("UPDATE identity_links SET status = 'active', linked_at = now() WHERE slack_user_id = $1", [slack]);
    await rt.entitlements.set("seed", { tenantId: "acme", userId: user }, { roles });
    await rt.tokens.set(user, {
      accessToken: `at-${user}-SENSITIVE`,
      refreshToken: `rt-${user}-SENSITIVE`,
      expiresAt: Date.now() + 3_600_000,
      tokenType: "Bearer",
    });
  }
  await rt.backend.setPolicy("seed", {
    tenantId: "acme",
    commitTool: "commit_request_time_off",
    approverUserIds: opts.approvers ?? ["mgr", "alice", "hr"],
    rotate: opts.rotate === true,
  });
}

/** Fake Slack Web API: records views.open, chat.postMessage, and response_url posts. */
export function fakeSlack(delayMs = 0, ok = true) {
  const calls: Array<{ triggerId: string; view: Record<string, unknown> }> = [];
  const posts: Array<{ channel: string; text: string; blocks?: Record<string, unknown>[] | undefined }> = [];
  const responses: Array<{ url: string; body: Record<string, unknown> }> = [];
  const api: SlackApi = {
    async viewsOpen(triggerId, view) {
      calls.push({ triggerId, view });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return ok ? { ok: true } : { ok: false, error: "expired_trigger_id" };
    },
    async postMessage(channel, text, blocks) {
      posts.push({ channel, text, blocks });
      return { ok: true, ts: `${posts.length}.000` };
    },
    async respond(url, body) {
      responses.push({ url, body });
      return { ok: true };
    },
  };
  return { api, calls, posts, responses };
}

/** Everything the fake Slack saw, as one string (for "never contains X" assertions). */
export const slackText = (s: ReturnType<typeof fakeSlack>) => JSON.stringify([s.calls, s.posts, s.responses]);

export const cmdBody = (text = "", o: Record<string, string> = {}) =>
  new URLSearchParams({
    team_id: TEAM,
    user_id: "U0ALICE",
    channel_id: CHANNEL,
    command: "/workday",
    text,
    trigger_id: "1334.7384.abc",
    ...o,
  }).toString();

export function submission(
  nonce: string,
  values: { start: string; end: string; type: string; days: string },
  user = "U0ALICE",
  team = TEAM,
): string {
  const v = (x: unknown) => ({ v: x });
  return `payload=${encodeURIComponent(
    JSON.stringify({
      type: "view_submission",
      team: { id: team },
      user: { id: user },
      view: {
        callback_id: "wd_time_off_request",
        private_metadata: nonce,
        state: {
          values: {
            start: v({ selected_date: values.start }),
            end: v({ selected_date: values.end }),
            type: v({ selected_option: { value: values.type } }),
            days: v({ value: values.days }),
            comment: v({ value: null }),
          },
        },
      },
    }),
  )}`;
}

export const RESPONSE_URL = "https://hooks.slack.com/actions/T0ALLOWED/123/abc";

export const button = (
  requestId: string,
  hash: string,
  user: string,
  action = "wd_approval_approve",
  team = TEAM,
  responseUrl?: string,
) =>
  `payload=${encodeURIComponent(JSON.stringify({ type: "block_actions", team: { id: team }, user: { id: user }, ...(responseUrl ? { response_url: responseUrl } : {}), actions: [{ action_id: action, value: `${requestId}|${hash}` }] }))}`;

/** The requester's "Submit to Workday" button (value is the request id only). */
export const submitButton = (requestId: string, user: string, responseUrl: string = RESPONSE_URL, team = TEAM) =>
  `payload=${encodeURIComponent(JSON.stringify({ type: "block_actions", team: { id: team }, user: { id: user }, response_url: responseUrl, actions: [{ action_id: "wd_approval_submit", value: requestId }] }))}`;

export { DbApprovalBackend };
