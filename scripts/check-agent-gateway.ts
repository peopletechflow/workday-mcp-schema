/** Agent Gateway runtime checks: discovery, drift, policy, ASU binding (node:test under tsx). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { connectUpstream, type UpstreamTool } from "../src/agent-gateway/upstream.js";
import { AgentToolRegistry, fingerprint, ToolPolicyFile, type ToolPolicy } from "../src/agent-gateway/agentready.js";
import { AsuContextMismatch, AsuReauthRequired, AsuTokenProvider, asuEndpoints, authorizeUrl, exchangeCode, type AsuConfig } from "../src/agent-gateway/asu.js";

type World = { tools: UpstreamTool[]; calls: { name: string; args: unknown }[]; pageSize: number };
async function upstream(w: World) {
  const s = new Server({ name: "wd", version: "0" }, { capabilities: { tools: { listChanged: true } } });
  s.setRequestHandler(ListToolsRequestSchema, async (r) => {
    const start = Number(r.params?.cursor ?? 0); const page = w.tools.slice(start, start + w.pageSize);
    return { tools: page as never, nextCursor: start + w.pageSize < w.tools.length ? String(start + w.pageSize) : undefined };
  });
  s.setRequestHandler(CallToolRequestSchema, async (r) => { w.calls.push({ name: r.params.name, args: r.params.arguments }); return { content: [{ type: "text", text: JSON.stringify(r.params.name === "whoAmI" ? { data: { worker: "W-ME" } } : { ok: true }) }] }; });
  const [a, b] = InMemoryTransport.createLinkedPair(); await s.connect(a);
  return { s, up: await connectUpstream({ transport: b }) };
}
const T = (name: string, props: Record<string, unknown>, extra: Partial<UpstreamTool> = {}): UpstreamTool => ({ name, description: `d ${name}`, inputSchema: { type: "object", properties: props, additionalProperties: false }, ...extra });
const tools = () => [
  T("whoAmI", { contextInstanceId: { type: "string" } }),
  ...Array.from({ length: 7 }, (_, i) => T(`filler${i}`, {})),
  T("getMyGoals", { workerId: { type: "string" }, from: { type: "string" } }, { annotations: { readOnlyHint: true } }),
  T("updateMyGoal", { goalId: { type: "string" }, percent: { type: "number" } }),
  T("giveFeedback", { recipientWorker: { type: "string" }, text: { type: "string" } }),
];
function policyFor(ts: UpstreamTool[]): ToolPolicy {
  const f = (n: string) => fingerprint(ts.find((t) => t.name === n)!);
  return ToolPolicyFile.parse({ version: 1, approvedBy: "test", approvedAt: "2026-11-08", tenantAlias: "acme", agentClientId: "cid", tools: [
    { name: "whoAmI", fingerprint: f("whoAmI"), access: "read", subject: { contextInstanceId: "me" }, identity: { workerIdPath: "data.worker" } },
    { name: "getMyGoals", fingerprint: f("getMyGoals"), access: "read", subject: { workerId: "caller" } },
    { name: "updateMyGoal", fingerprint: f("updateMyGoal"), access: "write" },
    { name: "giveFeedback", fingerprint: f("giveFeedback"), access: "write", objectArgs: ["recipientWorker"] },
  ] });
}

test("discovery is paginated, identity uses the approved tool, subject args are bound server-side", async () => {
  const w: World = { tools: tools(), calls: [], pageSize: 3 };
  const { up } = await upstream(w);
  const reg = new AgentToolRegistry(up, policyFor(w.tools));
  assert.equal(await reg.resolveWorkerId(), "W-ME");
  assert.deepEqual(w.calls.at(-1), { name: "whoAmI", args: { contextInstanceId: "me" } });
  assert.ok(reg.statuses().every((s) => s.status === "available"), JSON.stringify(reg.statuses()));
  await reg.read("getMyGoals", { from: "2026-01-01" }, "W-ME");
  assert.deepEqual(w.calls.at(-1)!.args, { from: "2026-01-01", workerId: "W-ME" });
  await assert.rejects(reg.read("getMyGoals", { workerId: "W-OTHER" }, "W-ME"), /set by the server/);
  await assert.rejects(reg.read("filler1", {}, "W-ME"), /not an approved/);
  await assert.rejects(reg.read("getMyGoals", { nope: 1 }, "W-ME"), /Unknown argument/);
  await up.close();
});

test("rename, schema drift and list_changed turn tools off (fail closed)", async () => {
  const w: World = { tools: tools(), calls: [], pageSize: 50 };
  const { s, up } = await upstream(w);
  const reg = new AgentToolRegistry(up, policyFor(w.tools), { ttlMs: 60 * 60_000 });
  await reg.ensureFresh();
  w.tools = w.tools.map((t) => (t.name === "getMyGoals" ? { ...t, name: "listGoalsForMe" } : t.name === "updateMyGoal" ? T("updateMyGoal", { goalId: { type: "string" }, percent: { type: "string" } }) : t));
  await s.sendToolListChanged();
  await new Promise((r) => setTimeout(r, 20));
  await reg.ensureFresh();
  const st = Object.fromEntries(reg.statuses().map((x) => [x.name, x.status]));
  assert.equal(st.getMyGoals, "missing"); assert.equal(st.updateMyGoal, "drifted");
  assert.ok(!reg.statuses().some((x) => x.name === "listGoalsForMe"), "renamed tool is not auto-approved");
  await up.close();
});

test("description rewrites do not count as drift", async () => {
  const w: World = { tools: tools(), calls: [], pageSize: 50 };
  const { up } = await upstream(w);
  const reg = new AgentToolRegistry(up, policyFor(w.tools));
  w.tools = w.tools.map((t) => ({ ...t, description: "rewritten" }));
  await reg.ensureFresh(true);
  assert.equal(reg.statuses().find((x) => x.name === "getMyGoals")!.status, "available");
  await up.close();
});

test("unbound person argument or read approval of a writing tool is refused", async () => {
  const w: World = { tools: [...tools(), T("peek", { employeeId: { type: "string" } }), T("sneaky", {}, { annotations: { readOnlyHint: false } })], calls: [], pageSize: 50 };
  const { up } = await upstream(w);
  const p = policyFor(w.tools);
  p.tools.push({ name: "peek", fingerprint: fingerprint(w.tools.at(-2)!), access: "read", subject: {}, objectArgs: [] }, { name: "sneaky", fingerprint: fingerprint(w.tools.at(-1)!), access: "read", subject: {}, objectArgs: [] },
    { name: "request_payroll_input", fingerprint: "0".repeat(64), access: "write", subject: {}, objectArgs: [] });
  const reg = new AgentToolRegistry(up, p); await reg.ensureFresh();
  const st = Object.fromEntries(reg.statuses().map((x) => [x.name, x]));
  assert.match(st.peek!.reason!, /without a binding/); assert.match(st.sneaky!.reason!, /marks it as writing/); assert.match(st.request_payroll_input!.reason!, /payroll/);
  await up.close();
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

test("write contract drift between preview and commit is refused before sending", async () => {
  const w: World = { tools: tools(), calls: [], pageSize: 50 };
  const { s, up } = await upstream(w);
  const reg = new AgentToolRegistry(up, policyFor(w.tools));
  await reg.ensureFresh(true);
  const b = reg.buildArgs("updateMyGoal", "write", { goalId: "G1", percent: 5 }, "W-ME");
  w.tools = w.tools.map((t) => (t.name === "updateMyGoal" ? T("updateMyGoal", { goalId: { type: "string" } }) : t));
  await s.sendToolListChanged();
  await assert.rejects(reg.assertUnchanged("updateMyGoal", b.fingerprint), /changed|drifted|re-approve/);
  assert.equal(w.calls.filter((c) => c.name === "updateMyGoal").length, 0);
  await up.close();
});
