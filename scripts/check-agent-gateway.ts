/** Agent Gateway runtime checks: ceilings, recursive subject binding, identity, drift, ASU binding, session file (node:test under tsx). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, symlinkSync, writeFileSync, statSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectUpstream, type UpstreamTool } from "../src/agent-gateway/upstream.js";
import { AgentToolRegistry, analyzeSchema, fingerprint, ToolPolicyFile, type Ceiling, type ToolPolicy } from "../src/agent-gateway/agentready.js";
import { writeOwnerOnlyJson, readOwnerOnlyJson } from "../src/agent-gateway/secure-file.js";
import { AsuContextMismatch, AsuReauthRequired, AsuTokenProvider, asuEndpoints, authorizeUrl, exchangeCode, type AsuConfig } from "../src/agent-gateway/asu.js";

type World = { tools: UpstreamTool[]; calls: { name: string; args: any }[]; pageSize: number; results?: Record<string, unknown> };
async function upstream(w: World) {
  const s = new Server({ name: "wd", version: "0" }, { capabilities: { tools: { listChanged: true } } });
  s.setRequestHandler(ListToolsRequestSchema, async (r) => {
    const start = Number(r.params?.cursor ?? 0); const page = w.tools.slice(start, start + w.pageSize);
    return { tools: page as never, nextCursor: start + w.pageSize < w.tools.length ? String(start + w.pageSize) : undefined };
  });
  s.setRequestHandler(CallToolRequestSchema, async (r) => { w.calls.push({ name: r.params.name, args: r.params.arguments }); const res = w.results?.[r.params.name] ?? (r.params.name === "whoAmI" ? { data: [{ id: "W-ME" }] } : { ok: true }); return { content: [{ type: "text", text: JSON.stringify(res) }] }; });
  const [a, b] = InMemoryTransport.createLinkedPair(); await s.connect(a);
  return { s, up: await connectUpstream({ transport: b }) };
}
const obj = (props: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: "object", properties: props, additionalProperties: false, ...extra });
const T = (name: string, schema: Record<string, unknown>, extra: Partial<UpstreamTool> = {}): UpstreamTool => ({ name, description: `d ${name}`, inputSchema: schema as never, ...extra });
const CEIL: Ceiling[] = [
  { capability: "goals.self.read", access: "read", permission: "rc.read", description: "goals", enabled: true },
  { capability: "goal.self.update", access: "write", permission: "rc.submit", description: "update goal", enabled: true },
  { capability: "payroll.write", access: "write", permission: "rc.submit", description: "never", enabled: false },
];
const base = () => [
  T("whoAmI", obj({ contextInstanceId: { type: "string" } })),
  ...Array.from({ length: 7 }, (_, i) => T(`filler${i}`, obj({}))),
  T("getMyGoals", obj({ workerId: { type: "string" }, from: { type: "string", format: "date" } }), { annotations: { readOnlyHint: true } }),
  T("goalStatus", obj({ workerId: { type: "string" }, goalId: { type: "string" } })),
  T("updateMyGoal", obj({ workerId: { type: "string" }, goalId: { type: "string" }, percent: { type: "number" } })),
];
type E = ToolPolicy["tools"][number];
function policy(ts: UpstreamTool[], extra: Partial<E>[] = [], replaceIdentity?: Partial<E>): ToolPolicy {
  const f = (n: string) => { const t = ts.find((x) => x.name === n); return t ? fingerprint(t) : "0".repeat(64); };
  const id = { name: "whoAmI", fingerprint: f("whoAmI"), capability: "identity.self", subject: { contextInstanceId: "me" }, identity: { workerIdPath: "data[].id", attestedBy: "test", attestedAt: "2026-11-08" }, ...replaceIdentity };
  return ToolPolicyFile.parse({ version: 2, approvedBy: "t", approvedAt: "2026-11-08", tenantAlias: "acme", agentClientId: "cid", tools: [
    id,
    { name: "getMyGoals", fingerprint: f("getMyGoals"), capability: "goals.self.read", subject: { workerId: "caller" } },
    { name: "goalStatus", fingerprint: f("goalStatus"), capability: "goals.self.read", subject: { workerId: "caller" } },
    { name: "updateMyGoal", fingerprint: f("updateMyGoal"), capability: "goal.self.update", subject: { workerId: "caller" } },
    ...extra.map((x) => ({ fingerprint: f(x.name!), subject: {}, ...x })),
  ] });
}
const reg = async (w: World, p?: ToolPolicy, opts = {}) => { const u = await upstream(w); const r = new AgentToolRegistry(u.up, p ?? policy(w.tools), CEIL, opts); return { ...u, r }; };
const st = (r: AgentToolRegistry, n: string) => r.statuses().find((x) => x.name === n)!;

test("paginated discovery, attested self identity, top-level subject bound server-side", async () => {
  const w: World = { tools: base(), calls: [], pageSize: 3 };
  const { up, r } = await reg(w);
  assert.equal(await r.resolveWorkerId(), "W-ME");
  assert.deepEqual(w.calls.at(-1), { name: "whoAmI", args: { contextInstanceId: "me" } });
  assert.ok(r.statuses().every((s) => s.status === "available"), JSON.stringify(r.statuses()));
  await r.read("getMyGoals", "goals.self.read", { from: "2026-01-01" }, "W-ME", "k");
  assert.deepEqual(w.calls.at(-1)!.args, { from: "2026-01-01", workerId: "W-ME" });
  await assert.rejects(r.read("getMyGoals", "goals.self.read", { workerId: "BOB" }, "W-ME", "k"), /set by the server/);
  await assert.rejects(r.read("getMyGoals", "goal.self.update", {}, "W-ME", "k"), /not approved for/);
  await up.close();
});

test("nested person field: unbound is refused; bound is filled; model injection at depth is rejected", async () => {
  const nested = T("searchGoals", obj({ contextInstanceId: { type: "string" }, filter: obj({ worker: { type: "string" }, from: { type: "string", format: "date" } }) }));
  const w: World = { tools: [...base(), nested], calls: [], pageSize: 50 };
  let x = await reg(w, policy(w.tools, [{ name: "searchGoals", capability: "goals.self.read", subject: { contextInstanceId: "me" } }]));
  await x.r.ensureFresh(); assert.match(st(x.r, "searchGoals").reason!, /without a server binding: filter\.worker/); await x.up.close();
  x = await reg(w, policy(w.tools, [{ name: "searchGoals", capability: "goals.self.read", subject: { contextInstanceId: "me", "filter.worker": "caller" } }]));
  await x.r.ensureFresh(); assert.equal(st(x.r, "searchGoals").status, "available");
  await assert.rejects(x.r.read("searchGoals", "goals.self.read", { filter: { worker: "BOB_WID" } }, "W-ME", "k"), /person fields are set by the server/);
  await assert.rejects(x.r.read("searchGoals", "goals.self.read", { filter: { surprise: "x" } }, "W-ME", "k"), /unknown field/);
  await x.r.read("searchGoals", "goals.self.read", { filter: { from: "2026-01-01" } }, "W-ME", "k");
  assert.deepEqual(w.calls.at(-1)!.args, { filter: { from: "2026-01-01", worker: "W-ME" }, contextInstanceId: "me" });
  await x.up.close();
});

test("schemas that cannot be bound safely are refused: arrays, unions, open objects, refs", () => {
  const probs = (s: object) => analyzeSchema(s as never).problems.join("|");
  assert.match(probs(obj({ list: { type: "array", items: obj({ workerId: { type: "string" } }) } })), /array or union/);
  assert.match(probs(obj({ q: { anyOf: [obj({ employee: { type: "string" } }), { type: "string" }] } })), /array or union/);
  assert.match(probs(obj({ q: { type: "object", additionalProperties: { type: "string" } } })), /open additionalProperties/);
  assert.match(probs(obj({ q: { type: "object", patternProperties: { ".*": {} } } })), /patternProperties/);
  assert.match(probs(obj({ q: { $ref: "https://x/y" } })), /external/);
  assert.match(probs({ ...obj({ q: { $ref: "#/$defs/A" } }), $defs: { A: obj({ q: { $ref: "#/$defs/A" } }) } }), /recursive/);
  const aliased = analyzeSchema({ ...obj({ who: { $ref: "#/$defs/P" } }), $defs: { P: obj({ employee: { type: "string" } }) } } as never);
  assert.deepEqual(aliased.subjectPaths, ["who.employee"]);
});

test("$ref alias to a person field must be bound and cannot be injected", async () => {
  const t = T("refTool", { ...obj({ who: { $ref: "#/$defs/P" } }), $defs: { P: obj({ employee: { type: "string" } }) } });
  const w: World = { tools: [...base(), t], calls: [], pageSize: 50 };
  const x = await reg(w, policy(w.tools, [{ name: "refTool", capability: "goals.self.read", subject: { "who.employee": "caller" } }]));
  await x.r.ensureFresh(); assert.equal(st(x.r, "refTool").status, "available");
  await assert.rejects(x.r.read("refTool", "goals.self.read", { who: { employee: "BOB" } }, "W-ME", "k"), /set by the server/);
  await x.up.close();
});

test("opaque ids need ownership proof: only values from your own earlier results", async () => {
  const w: World = { tools: base(), calls: [], pageSize: 50, results: { getMyGoals: { goals: [{ id: "G-MINE" }] } } };
  const { up, r } = await reg(w);
  await assert.rejects(r.read("goalStatus", "goals.self.read", { goalId: "G-SOMEONE" }, "W-ME", "k"), /id not from your own records/);
  await r.read("getMyGoals", "goals.self.read", {}, "W-ME", "k");
  await r.read("goalStatus", "goals.self.read", { goalId: "G-MINE" }, "W-ME", "k");
  await assert.rejects(r.read("goalStatus", "goals.self.read", { goalId: "G-MINE" }, "W-ME", "other-caller"), /own records/);
  await up.close();
});

test("ceilings: undefined or disabled capabilities, destructive and writing annotations are refused", async () => {
  const w: World = { tools: [...base(), T("deny_business_process_event_step", obj({ eventId: { type: "string" } })), T("wipe", obj({}), { annotations: { destructiveHint: true } }), T("pay", obj({}))], calls: [], pageSize: 50 };
  const x = await reg(w, policy(w.tools, [
    { name: "deny_business_process_event_step", capability: "bp.manage" },
    { name: "wipe", capability: "goal.self.update" },
    { name: "pay", capability: "payroll.write" },
    { name: "request_payroll_input", capability: "goals.self.read" },
  ]));
  await x.r.ensureFresh();
  assert.match(st(x.r, "deny_business_process_event_step").reason!, /not defined by this project/);
  assert.match(st(x.r, "wipe").reason!, /destructive/);
  assert.match(st(x.r, "pay").reason!, /disabled/);
  assert.match(st(x.r, "request_payroll_input").reason!, /payroll/);
  await x.up.close();
});

test("identity must be one attested self lookup returning exactly one record", async () => {
  const w: World = { tools: [...base(), T("whoAmI2", obj({ contextInstanceId: { type: "string" }, q: { type: "string" } }))], calls: [], pageSize: 50, results: { whoAmI: { data: [{ id: "A" }, { id: "B" }] } } };
  let x = await reg(w);
  await assert.rejects(x.r.resolveWorkerId(), /exactly one record/); await x.up.close();
  x = await reg(w, policy(w.tools, [], { name: "whoAmI2", fingerprint: fingerprint(w.tools.at(-1)!) }));
  await x.r.ensureFresh(); assert.match(st(x.r, "whoAmI2").reason!, /no other inputs/); await x.up.close();
  x = await reg(w, policy(w.tools, [], { subject: { contextInstanceId: "caller" } as never }));
  await x.r.ensureFresh(); assert.match(st(x.r, "whoAmI").reason!, /exactly one self selector/); await x.up.close();
  assert.throws(() => policy(w.tools, [], { identity: { workerIdPath: "data.0.id", attestedBy: "t", attestedAt: "t" } }));
  x = await reg(w, policy(w.tools, [{ name: "getMyGoals", capability: "identity.self", subject: { workerId: "caller" } } as never]));
  await assert.rejects(x.r.resolveWorkerId(), /exactly one identity\.self/); await x.up.close();
});

test("after token refresh the identity is re-read; a different worker ends the session", async () => {
  const w: World = { tools: base(), calls: [], pageSize: 50 };
  let ended = false;
  const { up, r } = await reg(w, undefined, { onIdentityMismatch: () => { ended = true; } });
  await r.resolveWorkerId();
  r.identityRecheck = true; await r.read("getMyGoals", "goals.self.read", {}, "W-ME", "k"); assert.equal(r.identityRecheck, false);
  w.results = { whoAmI: { data: [{ id: "W-SOMEONE" }] } }; r.identityRecheck = true;
  await assert.rejects(r.read("getMyGoals", "goals.self.read", {}, "W-ME", "k"), /worker changed/); assert.ok(ended);
  await up.close();
});

test("rename, schema drift and list_changed turn tools off; description rewrites do not", async () => {
  const w: World = { tools: base(), calls: [], pageSize: 50 };
  const { s, up, r } = await reg(w, undefined, { ttlMs: 3600_000 });
  await r.ensureFresh();
  w.tools = w.tools.map((t) => (t.name === "getMyGoals" ? { ...t, name: "listGoalsForMe" } : t.name === "updateMyGoal" ? T("updateMyGoal", obj({ workerId: { type: "string" }, goalId: { type: "string" }, percent: { type: "string" } })) : { ...t, description: "rewritten" }));
  await s.sendToolListChanged(); await new Promise((x) => setTimeout(x, 20)); await r.ensureFresh();
  assert.equal(st(r, "getMyGoals").status, "missing"); assert.equal(st(r, "updateMyGoal").status, "drifted"); assert.equal(st(r, "goalStatus").status, "available");
  assert.ok(!r.statuses().some((x) => x.name === "listGoalsForMe"));
  await up.close();
});

test("session file: atomic owner-only write, symlinks and loose permissions refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "asu-"));
  const p = join(dir, "s.json");
  writeOwnerOnlyJson(p, { a: 1 }); assert.equal(statSync(p).mode & 0o777, 0o600); assert.deepEqual(readOwnerOnlyJson(p), { a: 1 });
  writeOwnerOnlyJson(p, { a: 2 }); assert.deepEqual(readOwnerOnlyJson(p), { a: 2 });
  assert.deepEqual(readdirSync(dir), ["s.json"], "no temp files left behind");
  const victim = join(dir, "victim"); writeFileSync(victim, "keep", { mode: 0o600 });
  const link = join(dir, "link.json"); symlinkSync(victim, link);
  assert.throws(() => writeOwnerOnlyJson(link, { x: 1 }), /symlink/); assert.throws(() => readOwnerOnlyJson(link), /symlink/);
  const loose = join(dir, "loose.json"); writeFileSync(loose, "{}"); chmodSync(loose, 0o644);
  assert.throws(() => readOwnerOnlyJson(loose), /chmod 600/);
});


const CFG: AsuConfig = { gatewayHost: "us.agent.workday.com", tenantAlias: "acme", clientId: "cid", clientSecret: "sec", redirectUri: "https://agent.example.com/cb", production: true };

test("ASU endpoints follow the documented Agent Gateway contract and PKCE is always sent", () => {
  assert.deepEqual(asuEndpoints(CFG), { authorize: "https://us.agent.workday.com/auth/authorize/acme", token: "https://us.agent.workday.com/auth/oauth2/acme/token", mcp: "https://us.agent.workday.com/acme/mcp" });
  const u = new URL(authorizeUrl(CFG, "st", "ch"));
  assert.equal(u.searchParams.get("response_type"), "code"); assert.equal(u.searchParams.get("code_challenge_method"), "S256"); assert.equal(u.searchParams.get("state"), "st");
  assert.throws(() => asuEndpoints({ ...CFG, gatewayHost: "evil.example.com" }), /Agent Gateway host/);
  assert.throws(() => asuEndpoints({ ...CFG, gatewayHost: "127.0.0.1:9" }), /tests only/);
  assert.throws(() => asuEndpoints({ ...CFG, redirectUri: "http://agent.example.com/cb" }), /https/);
});

test("ASU token exchange: documented form fields, string expires_in, redirect refused", async () => {
  let seen: { url: string; body: string; redirect?: string } | undefined;
  const f = (async (url: string, init: RequestInit) => { seen = { url, body: String(init.body), redirect: init.redirect }; return new Response(JSON.stringify({ access_token: "a", token_type: "Bearer", refresh_token: "r", expires_in: "3600" })); }) as unknown as typeof fetch;
  const s = await exchangeCode(CFG, "code1", "ver1", f, () => 0);
  assert.equal(seen!.url, "https://us.agent.workday.com/auth/oauth2/acme/token"); assert.equal(seen!.redirect, "error");
  const b = new URLSearchParams(seen!.body);
  assert.deepEqual([b.get("grant_type"), b.get("code"), b.get("client_id"), b.get("client_secret"), b.get("code_verifier")], ["authorization_code", "code1", "cid", "sec", "ver1"]);
  assert.equal(s.expiresAt, 3600_000);
  const bad = (async () => new Response(JSON.stringify({ access_token: "a", token_type: "mac" }))) as unknown as typeof fetch;
  await assert.rejects(exchangeCode(CFG, "c", "v", bad), AsuReauthRequired);
});

test("ASU session binding: tenant, agent and worker mismatches are refused", () => {
  const base = { gatewayHost: "us.agent.workday.com", tenantAlias: "acme", clientId: "cid", accessToken: "a", expiresAt: Date.now() + 3600_000 };
  assert.throws(() => new AsuTokenProvider(CFG, { ...base, tenantAlias: "other" }), AsuContextMismatch);
  assert.throws(() => new AsuTokenProvider(CFG, { ...base, clientId: "other-agent" }), AsuContextMismatch);
  assert.throws(() => new AsuTokenProvider(CFG, { ...base, gatewayHost: "eu.agent.workday.com" }), AsuContextMismatch);
  const p = new AsuTokenProvider(CFG, { ...base });
  p.bindWorker("W-ME");
  assert.throws(() => p.bindWorker("W-OTHER"), AsuContextMismatch);
  assert.throws(() => p.assertWorker("W-OTHER"), AsuContextMismatch);
  p.assertWorker("W-ME");
});

test("ASU refresh failure ends the session with no fallback", async () => {
  let calls = 0; let cleared = false;
  const f = (async () => { calls++; return new Response("{}", { status: 400 }); }) as unknown as typeof fetch;
  const p = new AsuTokenProvider(CFG, { gatewayHost: "us.agent.workday.com", tenantAlias: "acme", clientId: "cid", accessToken: "old", refreshToken: "r", expiresAt: 1000 }, { fetch: f, now: () => 0, onChange: (s) => { if (!s) cleared = true; } });
  await assert.rejects(p.token(), AsuReauthRequired);
  assert.ok(cleared); assert.equal(calls, 1);
  await assert.rejects(p.token(), /No ASU session/); assert.equal(calls, 1);
  const noRefresh = new AsuTokenProvider(CFG, { gatewayHost: "us.agent.workday.com", tenantAlias: "acme", clientId: "cid", accessToken: "old", expiresAt: 1000 }, { now: () => 0 });
  await assert.rejects(noRefresh.token(), /no refresh token/);
});

test("ASU refresh is single-flight and keeps the worker binding", async () => {
  let calls = 0;
  const f = (async () => { calls++; return new Response(JSON.stringify({ access_token: "new", token_type: "bearer" })); }) as unknown as typeof fetch;
  const p = new AsuTokenProvider(CFG, { gatewayHost: "us.agent.workday.com", tenantAlias: "acme", clientId: "cid", workerId: "W-ME", accessToken: "old", refreshToken: "r", expiresAt: 1000 }, { fetch: f, now: () => 0 });
  assert.deepEqual(await Promise.all([p.token(), p.token()]), ["new", "new"]); assert.equal(calls, 1);
  p.assertWorker("W-ME");
});


test("token refresh triggers the identity re-check hook", async () => {
  let fired = 0;
  const f = (async () => new Response(JSON.stringify({ access_token: "n", token_type: "Bearer" }))) as unknown as typeof fetch;
  const p = new AsuTokenProvider(CFG, { gatewayHost: "us.agent.workday.com", tenantAlias: "acme", clientId: "cid", accessToken: "o", refreshToken: "r", expiresAt: 1 }, { fetch: f, now: () => 0, onRefreshed: () => { fired++; } });
  await p.token(); assert.equal(fired, 1);
});

