/**
 * Offline checks for the production runtime: real composition (buildRuntime + router) on Postgres
 * (PGlite by default, real Postgres when CHECK_DATABASE_URL is set), with Workday, Slack, and OAuth
 * provider fakes. Run: npm run check:durable
 */
import assert from "node:assert/strict";
import type { Db } from "../src/store/db.js";
import { migrate, schemaVersion, LATEST_SCHEMA_VERSION } from "../src/store/migrations.js";
import { KeyRing } from "../src/store/crypto.js";
import { DbTokenStore } from "../src/store/repos.js";
import { DbApprovalBackend } from "../src/store/approvals.js";
import { loadRuntimeConfig } from "../src/server/runtime.js";
import { FixtureWorkdayClient } from "../src/workday/fixtures.js";
import { HttpWorkdayClient, WorkdayAmbiguousResultError, WorkdayApiError, ContractNotValidatedError, buildRequestTimeOffBody, type WorkdayClient } from "../src/workday/client.js";
import { loadConfig } from "../src/config.js";
import { durableAccessTokens, LinkRequiredError } from "../src/auth/user-tokens.js";
import { buildIntegrationToolset } from "../src/ai/integration-agent.js";
import type { TimeOffRequestInput, TimeOffRequestResult } from "../src/workday/types.js";
import { testDb } from "./lib/test-db.js";
import { KEY, SECRET, TEAM, baseEnv, button, cmdBody, fakeSlack, instance, seed, signed, submission, type Instance } from "./lib/harness.js";

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}
const alice = { tenantId: "acme", userId: "alice" };
const good = { start: "2026-12-01", end: "2026-12-02", type: "vacation", days: "2" };
const form = { startDate: "2026-12-01", endDate: "2026-12-02", timeOffType: "vacation", quantity: 2 };
const text = (r: { body: string }) => (JSON.parse(r.body) as { text: string }).text;
const dbs: Db[] = [];
async function fresh(): Promise<Db> {
  const { db } = await testDb();
  dbs.push(db);
  return db;
}
async function seeded(o?: Parameters<typeof seed>[1]): Promise<Db> {
  const db = await fresh();
  await seed(db, o);
  return db;
}
class CountingClient extends FixtureWorkdayClient {
  submits = 0;
  constructor(private readonly delayMs = 0) {
    super();
  }
  override async submitTimeOffRequest(t: string, i: TimeOffRequestInput): Promise<TimeOffRequestResult> {
    this.submits++;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return super.submitTimeOffRequest(t, i);
  }
}
async function approvedRequest(rt: Instance) {
  const r = await rt.service.proposeTimeOff(alice, form, "api");
  await rt.backend.decide({ requestId: r.id, approver: { tenantId: "acme", userId: "mgr" }, decision: "approve", presentedHash: r.changeHash });
  return r;
}
const { kind } = await testDb().then(async (x) => (await x.db.close(), x));
console.log(`# database: ${kind}`);

await check("schema: migrate idempotent; readyz 503 before migrate, 200 after; healthz", async () => {
  const db = await fresh();
  const rt = instance(db);
  assert.equal((await rt.route("GET", "/healthz", "", {})).status, 200);
  assert.equal((await rt.route("GET", "/readyz", "", {})).status, 503);
  assert.deepEqual(await migrate(db), [1]);
  assert.deepEqual(await migrate(db), []);
  assert.equal(await schemaVersion(db), LATEST_SCHEMA_VERSION);
  assert.equal((await rt.route("GET", "/readyz", "", {})).status, 200);
});

await check("config: production refuses fixtures, http redirect, missing keys; live mode needs API version", async () => {
  assert.throws(() => loadRuntimeConfig(baseEnv({ NODE_ENV: "production" })), /WORKDAY_USE_FIXTURES=false/);
  assert.throws(() => loadRuntimeConfig(baseEnv({ NODE_ENV: "production", WORKDAY_USE_FIXTURES: "false", WORKDAY_ABSENCE_API_VERSION: "v1", WORKDAY_OAUTH_REDIRECT_URI: "http://x/cb" })), /https/);
  assert.throws(() => loadRuntimeConfig(baseEnv({ TOKEN_ENCRYPTION_KEY: "" })), /TOKEN_ENCRYPTION_KEY/);
  assert.throws(() => loadRuntimeConfig(baseEnv({ DATABASE_URL: "" })), /DATABASE_URL/);
  assert.throws(() => loadRuntimeConfig(baseEnv({ WORKDAY_USE_FIXTURES: "false" })), /WORKDAY_ABSENCE_API_VERSION/);
  assert.throws(() => loadRuntimeConfig(baseEnv({ SLACK_ALLOWED_CHANNEL_IDS: "" })), /SLACK_ALLOWED_CHANNEL_IDS/);
});

await check("e2e across instances and restart: command -> modal -> submit (A) -> approve (B, new process) -> commit (C) -> idempotent replay", async () => {
  const db = await seeded();
  const client = new CountingClient();
  const slack = fakeSlack();
  const A = instance(db, { client, slackApi: slack.api });
  const c1 = cmdBody();
  const r0 = await A.route("POST", "/slack/commands", c1, signed(c1));
  assert.equal(r0.status, 200); assert.equal(slack.calls.length, 1);
  const nonce = (slack.calls[0]!.view as { private_metadata: string }).private_metadata;
  assert.ok(!JSON.stringify(slack.calls[0]!.view).includes("alice"));
  const vs = submission(nonce, good);
  assert.equal(JSON.parse((await A.route("POST", "/slack/interactions", vs, signed(vs))).body).response_action, "clear");
  const [req] = await A.backend.list("acme");
  assert.ok(req && req.status === "pending" && req.requesterUserId === "alice");
  const B = instance(db, { client }); // simulates a restart / second instance
  const self = button(req.id, req.changeHash, "U0ALICE");
  assert.equal((await B.route("POST", "/slack/interactions", self, signed(self))).status, 403);
  const ok = button(req.id, req.changeHash, "U0MGR");
  assert.equal((await B.route("POST", "/slack/interactions", ok, signed(ok))).status, 200);
  const C = instance(db, { client });
  const s1 = cmdBody(`submit ${req.id}`);
  assert.match(text(await C.route("POST", "/slack/commands", s1, signed(s1))), /Submitted to Workday \(SUBMITTED, event evt_fixture_1\)/);
  const s2 = cmdBody(`submit ${req.id}`);
  assert.match(text(await A.route("POST", "/slack/commands", s2, signed(s2))), /evt_fixture_1/);
  assert.equal(client.submits, 1);
  assert.equal((await A.backend.get(req.id))!.status, "committed");
  const st = cmdBody(`status ${req.id}`, { user_id: "U0MALLORY" });
  assert.match(text(await A.route("POST", "/slack/commands", st, signed(st))), /NOT_FOUND/);
});

await check("replay guard and form nonce are shared across instances", async () => {
  const db = await seeded();
  const slack = fakeSlack();
  const A = instance(db, { slackApi: slack.api }), B = instance(db, { slackApi: slack.api });
  const c = cmdBody(); const h = signed(c);
  assert.equal((await A.route("POST", "/slack/commands", c, h)).status, 200);
  assert.equal((await B.route("POST", "/slack/commands", c, h)).status, 401, "replay on other instance");
  const nonce = (slack.calls[0]!.view as { private_metadata: string }).private_metadata;
  const vs = submission(nonce, good);
  assert.equal(JSON.parse((await B.route("POST", "/slack/interactions", vs, signed(vs))).body).response_action, "clear");
  const again = submission(nonce, { ...good, days: "1", end: "2026-12-01" });
  assert.equal((await A.route("POST", "/slack/interactions", again, signed(again))).status, 403, "nonce single use across instances");
});

await check("concurrency: 8 parallel commits from 4 instances execute Workday exactly once", async () => {
  const db = await seeded();
  const client = new CountingClient(30);
  const insts = [0, 1, 2, 3].map(() => instance(db, { client }));
  const r = await approvedRequest(insts[0]!);
  const res = await Promise.allSettled(insts.flatMap((rt, i) => [rt, rt].map((x, j) => x.service.commitApproved(alice, r.id, `race-${i}-${j}-key`))));
  assert.equal(client.submits, 1);
  assert.ok(res.filter((x) => x.status === "fulfilled").length >= 1);
  for (const x of res) if (x.status === "rejected") assert.match(String((x.reason as Error).message), /in flight|unknown|Request is committ/);
  assert.equal((await insts[0]!.backend.get(r.id))!.status, "committed");
});

await check("uncertain Workday result: unknown state, no automatic resubmit, operator reconcile found/not found/confirm", async () => {
  const db = await seeded();
  class Ambiguous extends CountingClient {
    found: TimeOffRequestResult | undefined;
    override async submitTimeOffRequest(): Promise<never> {
      this.submits++;
      throw new WorkdayAmbiguousResultError("requestTimeOff.create", "timeout");
    }
    override async findMatchingTimeOffRequest(): Promise<TimeOffRequestResult | undefined> {
      return this.found;
    }
  }
  const client = new Ambiguous();
  const rt = instance(db, { client });
  const r = await approvedRequest(rt);
  await assert.rejects(rt.service.commitApproved(alice, r.id, "unk-key-0001"), /COMMIT_UNCERTAIN|did not confirm/);
  assert.equal((await rt.backend.get(r.id))!.status, "unknown");
  await assert.rejects(rt.service.commitApproved(alice, r.id, "unk-key-0002"), /operator must reconcile|unknown/);
  assert.equal(client.submits, 1, "no second submit");
  assert.equal((await rt.backend.needingReconcile("acme")).length, 1);
  assert.equal(await rt.service.reconcile("ops", r.id), "still_unknown");
  client.found = { workdayEventId: "wd-123", status: "SUBMITTED", startDate: form.startDate, endDate: form.endDate, quantity: 2, unit: "DAYS", timeOffType: { type: "Time_Off_Type_ID", value: "VACATION" } };
  assert.equal(await rt.service.reconcile("ops", r.id), "committed");
  assert.equal((await rt.backend.get(r.id))!.status, "committed");
  const r2 = await approvedRequest(rt);
  client.found = undefined;
  await assert.rejects(rt.service.commitApproved(alice, r2.id, "unk-key-0003"));
  assert.equal(await rt.service.reconcile("ops", r2.id, true), "failed");
  const audit = await db.query("SELECT count(*)::int AS n FROM admin_audit WHERE action = 'approval.reconcile'");
  assert.equal(Number(audit.rows[0]!.n), 2);
});

await check("crash between begin and finish: stays committing, flagged for reconcile, never retried", async () => {
  const db = await seeded();
  const client = new CountingClient();
  const rt = instance(db, { client });
  const r = await approvedRequest(rt);
  const authz = await rt.entitlements.authzFor(alice);
  await rt.backend.beginCommit({ requestId: r.id, caller: alice, authz, idempotencyKey: "crash-key-01" }); // process dies here
  await assert.rejects(rt.service.commitApproved(alice, r.id, "crash-key-02"), /operator must reconcile/);
  assert.equal(client.submits, 0);
  assert.equal((await new DbApprovalBackend(db, 15 * 60 * 1000, 0).needingReconcile("acme")).length, 1);
});

await check("revocation and deny at execution: revoked link, role deny, deleted token", async () => {
  const db = await seeded();
  const client = new CountingClient();
  const rt = instance(db, { client });
  const r1 = await approvedRequest(rt);
  await rt.entitlements.set("ops", alice, { roles: ["worker_self"], denies: ["tool:commit_request_time_off"] });
  await assert.rejects(rt.service.commitApproved(alice, r1.id, "deny-key-001"), /denied|not allowed|deny/i);
  await rt.entitlements.set("ops", alice, { roles: ["worker_self"] });
  const r2 = await approvedRequest(rt);
  await rt.tokens.delete("alice");
  await assert.rejects(rt.service.commitApproved(alice, r2.id, "tok-key-0001"), LinkRequiredError);
  assert.equal((await rt.backend.get(r2.id))!.status, "failed");
  await rt.links.revoke("ops", TEAM, "U0ALICE");
  const s = cmdBody(`status ${r2.id}`);
  assert.match(text(await rt.route("POST", "/slack/commands", s, signed(s))), /not linked/);
  assert.equal(client.submits, 0);
});

await check("tenant and user isolation; non-approver and wrong hash refused; forged/stale callbacks refused", async () => {
  const db = await seeded();
  const rt = instance(db);
  await assert.rejects(rt.service.proposeTimeOff({ tenantId: "globex", userId: "alice" }, form, "api"), /CROSS_TENANT|tenant/);
  await assert.rejects(rt.service.proposeTimeOff({ tenantId: "acme", userId: "nobody" }, form, "api"), /denied|not allowed|role/i);
  const r = await rt.service.proposeTimeOff(alice, form, "api");
  const mal = button(r.id, r.changeHash, "U0MALLORY");
  assert.equal((await rt.route("POST", "/slack/interactions", mal, signed(mal))).status, 403);
  const bad = button(r.id, "0".repeat(64), "U0MGR");
  assert.equal((await rt.route("POST", "/slack/interactions", bad, signed(bad))).status, 403);
  const forged = button(r.id, r.changeHash, "U0MGR");
  assert.equal((await rt.route("POST", "/slack/interactions", forged, signed(forged, undefined, "wrong"))).status, 401);
  assert.equal((await rt.route("POST", "/slack/interactions", forged, signed(forged, Math.floor(Date.now() / 1000) - 3600))).status, 401);
  const other = button(r.id, r.changeHash, "U0EVE", "wd_approval_approve", "T0OTHER");
  assert.equal((await rt.route("POST", "/slack/interactions", other, signed(other))).status, 403);
  assert.equal((await rt.backend.get(r.id))!.status, "pending");
  await assert.rejects(rt.service.commitApproved({ tenantId: "acme", userId: "mgr" }, r.id, "steal-key-01"), /NOT_REQUESTER|requester/);
});

await check("rotation assigns one approver per request from policy, never the requester", async () => {
  const db = await seeded({ rotate: true });
  const rt = instance(db);
  const a = [];
  for (let i = 0; i < 4; i++) a.push((await rt.service.proposeTimeOff(alice, form, "api")).assignedApprovers);
  assert.deepEqual(a, [["mgr"], ["hr"], ["mgr"], ["hr"]]);
});

await check("stored change tampered in DB after approval: refused, Workday not called", async () => {
  const db = await seeded();
  const client = new CountingClient();
  const rt = instance(db, { client });
  const r = await approvedRequest(rt);
  await db.query(`UPDATE approval_requests SET change = jsonb_set(change, '{willSubmit,quantity}', '9') WHERE id = $1`, [r.id]);
  await assert.rejects(rt.service.commitApproved(alice, r.id, "tamper-key-1"), /TAMPERED|does not match/);
  assert.equal(client.submits, 0);
});

await check("live mode without validated contract: commit refused before any state change", async () => {
  const db = await seeded();
  const rt = instance(db, { env: { WORKDAY_USE_FIXTURES: "false", WORKDAY_ABSENCE_API_VERSION: "v1" }, fetchImpl: (async () => { throw new Error("network must not be called"); }) as unknown as typeof fetch });
  const fx = instance(db);
  const r = await approvedRequest(fx);
  await assert.rejects(rt.service.commitApproved(alice, r.id, "gate-key-001"), ContractNotValidatedError);
  assert.equal((await rt.backend.get(r.id))!.status, "approved");
});

await check("Workday HTTP contract: pinned path, me entry, user bearer, per-day body, ambiguity classification, gate", async () => {
  const cfg = loadConfig(baseEnv({ WORKDAY_USE_FIXTURES: "false", WORKDAY_ABSENCE_API_VERSION: "v1", WORKDAY_BASE_URL: "https://wd2-impl-services1.workday.com" }));
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let reply: () => Response = () => new Response(JSON.stringify({ id: "evt-1" }), { status: 201 });
  const f = (async (url: string, init: RequestInit) => (calls.push({ url, init }), reply())) as unknown as typeof fetch;
  const all = ["requestTimeOff.create", "timeOffDetails.list", "balances.list"] as const;
  const c = new HttpWorkdayClient(cfg, { apiVersion: "v1", validatedOperations: all, timeoutMs: 2000 }, f);
  const input: TimeOffRequestInput = { startDate: "2026-12-01", endDate: "2026-12-02", unit: "DAYS", quantity: 2, timeOffType: { type: "Time_Off_Type_ID", value: "VAC" } };
  const out = await c.submitTimeOffRequest("user-token", input);
  assert.equal(out.workdayEventId, "evt-1");
  assert.equal(calls[0]!.url, "https://wd2-impl-services1.workday.com/ccx/api/absenceManagement/v1/acme/workers/me/requestTimeOff");
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, "Bearer user-token");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { days: [{ date: "2026-12-01", dailyQuantity: 1, timeOffType: { id: "VAC" } }, { date: "2026-12-02", dailyQuantity: 1, timeOffType: { id: "VAC" } }] });
  reply = () => new Response("{}", { status: 503 });
  await assert.rejects(c.submitTimeOffRequest("t", input), WorkdayAmbiguousResultError);
  reply = () => new Response(JSON.stringify({ message: "invalid date" }), { status: 400 });
  await assert.rejects(c.submitTimeOffRequest("t", input), WorkdayApiError);
  reply = () => new Response("{}", { status: 201 });
  await assert.rejects(c.submitTimeOffRequest("t", input), WorkdayAmbiguousResultError, "2xx without id");
  const slow = new HttpWorkdayClient(cfg, { apiVersion: "v1", validatedOperations: all, timeoutMs: 1000 }, ((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch);
  await assert.rejects(slow.submitTimeOffRequest("t", input), WorkdayAmbiguousResultError, "timeout is ambiguous");
  assert.throws(() => buildRequestTimeOffBody({ ...input, quantity: 3 }), /quantity/);
  const gated = new HttpWorkdayClient(cfg, { apiVersion: "v1", validatedOperations: [], timeoutMs: 1000 }, f);
  const n = calls.length;
  await assert.rejects(gated.getMyTimeOffBalances("t"), ContractNotValidatedError);
  await assert.rejects(gated.submitTimeOffRequest("t", input), ContractNotValidatedError);
  assert.equal(calls.length, n, "no network when gated");
  reply = () => new Response(JSON.stringify({ data: [{ id: "e1", date: "2026-12-01", timeOffType: { id: "VAC" }, status: { descriptor: "Submitted" } }, { id: "e2", date: "2026-12-02", timeOffType: { id: "VAC" }, status: { descriptor: "Approved" } }] }), { status: 200 });
  assert.equal((await c.findMatchingTimeOffRequest("t", input))?.workdayEventId, "e1");
  assert.match(calls.at(-1)!.url, /\/workers\/me\/timeOffDetails\?fromDate=2026-12-01&toDate=2026-12-02/);
});

await check("token encryption: no plaintext at rest, AAD prevents row swap, key rotation, no fallback key", async () => {
  const db = await seeded();
  const rows = await db.query<{ user_id: string; ciphertext: string; iv: string; tag: string; key_id: string }>("SELECT * FROM oauth_tokens ORDER BY user_id");
  assert.ok(rows.rows.every((r) => !r.ciphertext.includes("SENSITIVE")));
  const keys = KeyRing.fromEnv(baseEnv());
  const store = new DbTokenStore(db, keys, "acme");
  const a = rows.rows.find((r) => r.user_id === "alice")!;
  await db.query("UPDATE oauth_tokens SET ciphertext = $1, iv = $2, tag = $3 WHERE user_id = 'mgr'", [a.ciphertext, a.iv, a.tag]);
  await assert.rejects(store.get("mgr"), /auth|Unsupported state/i);
  const rotated = new KeyRing("k2", Buffer.alloc(32, 7), { id: "k1", key: Buffer.from(KEY, "base64") });
  assert.equal((await new DbTokenStore(db, rotated, "acme").get("alice"))!.accessToken, "at-alice-SENSITIVE");
  assert.throws(() => KeyRing.fromEnv({}), /required/);
  assert.throws(() => new KeyRing("x", Buffer.alloc(16)), /32 bytes/);
});

await check("account linking: invited user gets PKCE URL; callback stores token and activates; state single use; uninvited refused", async () => {
  const db = await fresh();
  await migrate(db);
  let tokenCalls = 0;
  const f = (async (url: string, init: RequestInit) => {
    assert.equal(url, "https://wd2-impl-services1.workday.com/ccx/oauth2/acme/token");
    const body = new URLSearchParams(String(init.body));
    assert.equal(body.get("grant_type"), "authorization_code"); assert.ok(body.get("code_verifier"));
    tokenCalls++;
    return new Response(JSON.stringify({ access_token: "new-at-SENSITIVE", refresh_token: "new-rt-SENSITIVE", expires_in: 3600 }), { status: 200 });
  }) as unknown as typeof fetch;
  const rt = instance(db, { fetchImpl: f });
  await rt.links.invite("ops", { slackTeamId: TEAM, slackUserId: "U0NEW", tenantId: "acme", userId: "newbie" });
  assert.equal(await rt.links.resolveSlack(TEAM, "U0NEW"), undefined, "invited is not active");
  const c = cmdBody("link", { user_id: "U0NEW" });
  const msg = text(await rt.route("POST", "/slack/commands", c, signed(c)));
  const url = new URL(msg.slice(msg.indexOf("https://")));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const state = url.searchParams.get("state")!;
  const cb = await rt.route("GET", `/oauth/callback?state=${state}&code=abc123`, "", {});
  assert.equal(cb.status, 200); assert.ok(!cb.body.includes("SENSITIVE"));
  assert.deepEqual(await rt.links.resolveSlack(TEAM, "U0NEW"), { tenantId: "acme", userId: "newbie" });
  assert.equal((await rt.tokens.get("newbie"))!.accessToken, "new-at-SENSITIVE");
  assert.equal((await rt.route("GET", `/oauth/callback?state=${state}&code=abc123`, "", {})).status, 400, "state reuse");
  assert.equal(tokenCalls, 1);
  const u = cmdBody("link", { user_id: "U0STRANGER" });
  assert.match(text(await rt.route("POST", "/slack/commands", u, signed(u))), /not been invited/);
  assert.equal((await rt.route("GET", "/oauth/callback?state=AAAAAAAAAAAAAAAAAAAA&code=x", "", {})).status, 400);
  assert.ok(!rt.logs.join("\n").includes("SENSITIVE") && !rt.logs.join("\n").includes("abc123"));
});

await check("token refresh: single refresh under concurrency; refresh failure deletes token and requires relink", async () => {
  const db = await seeded();
  const keys = KeyRing.fromEnv(baseEnv());
  const store = new DbTokenStore(db, keys, "acme");
  await store.set("alice", { accessToken: "old", refreshToken: "rt-1", expiresAt: Date.now() - 1000, tokenType: "Bearer" });
  let refreshes = 0;
  const f = (async () => (refreshes++, await new Promise((r) => setTimeout(r, 20)), new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), { status: 200 }))) as unknown as typeof fetch;
  const cfg = loadConfig(baseEnv());
  const p1 = durableAccessTokens(db, store, cfg, f), p2 = durableAccessTokens(db, store, cfg, f);
  const out = await Promise.all([p1("alice"), p2("alice"), p1("alice")]);
  assert.deepEqual(out, ["fresh", "fresh", "fresh"]); assert.equal(refreshes, 1);
  await store.set("alice", { accessToken: "old", refreshToken: "rt-revoked", expiresAt: Date.now() - 1000, tokenType: "Bearer" });
  const bad = durableAccessTokens(db, store, cfg, (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch);
  await assert.rejects(bad("alice"), LinkRequiredError);
  assert.equal(await store.get("alice"), undefined);
});

await check("agent propose uses durable service; logs contain no secrets, tokens, or message text", async () => {
  const db = await seeded();
  const rt = instance(db);
  const tools = buildIntegrationToolset({ identity: alice, roles: ["worker_self"], invokeTool: async () => ({}), approvals: rt.service });
  assert.ok(!Object.keys(tools).some((n) => /commit|approve/.test(n)));
  const out = (await (tools.propose_time_off_request as unknown as { execute: (a: unknown, o: unknown) => Promise<{ approvalRequestId: string }> }).execute(form, { toolCallId: "t", messages: [] }));
  assert.equal((await rt.backend.get(out.approvalRequestId))!.status, "pending");
  const ev = JSON.stringify({ type: "event_callback", team_id: TEAM, event_id: "Ev9", event: { type: "message", user: "U0ALICE", channel: "C0INTAKE", text: "my secret medical note", ts: "1.2" } });
  assert.equal((await rt.route("POST", "/slack/events", ev, signed(ev))).status, 200);
  const logs = rt.logs.join("\n");
  for (const s of ["SENSITIVE", SECRET, "medical", KEY]) assert.ok(!logs.includes(s), `log leaked ${s.slice(0, 8)}`);
});

for (const db of dbs) await db.close().catch(() => {});
console.log(`\n${passed} durable checks passed (${kind})`);
