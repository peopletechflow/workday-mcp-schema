/**
 * Stdio MCP server checks: drives the real registered tools through the SDK's in-memory
 * transport. Covers RBAC denies on the original time-off tools, the production-tenant guard,
 * the token-store key requirement, commit ordering around sign-in, audit redaction, tool
 * annotations, pending-sign-in expiry, the loopback OAuth callback, and refresh failures.
 * Run: pnpm run check:mcp
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, tokenStoreSecret, type AppConfig } from "../src/config.js";
import { buildMcpServer } from "../src/mcp-server.js";
import { FixtureWorkdayClient } from "../src/workday/fixtures.js";
import { FixtureWorkdayDomainClient } from "../src/workday/domain-fixtures.js";
import { TokenStore } from "../src/auth/token-store.js";
import { AuditLogger, redactPii } from "../src/safety/audit.js";
import { redactFields } from "../src/observability/log.js";
import { HttpWorkdayClient, WorkdayApiError } from "../src/workday/client.js";
import {
  createPkcePair,
  PKCE_TTL_MS,
  rememberPkce,
  SignInRequiredError,
  takePkce,
  type OAuthTokens,
  type PkcePair,
} from "../src/auth/oauth.js";
import { requireUserAccessToken } from "../src/session.js";
import { createLoopbackCallbackServer, isLoopbackRedirect } from "../src/auth/loopback-callback.js";

const LIVE_KEY = "k".repeat(40);
const USER = "mcp-check-user";

let failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}\n     ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  }
}

function tmpPaths() {
  const dir = mkdtempSync(join(tmpdir(), "wd-mcp-check-"));
  return { tokenStorePath: join(dir, "tokens.json"), auditLogPath: join(dir, "audit.jsonl") };
}

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { WORKDAY_USER_ID: USER, WORKDAY_USER_ROLES: "worker_self", ...extra };
}

/** Fixture config, optionally flipped to "live" (tokens must come from the store, no auto session). */
function makeConfig(opts: { live?: boolean } = {}): AppConfig {
  const cfg = { ...loadConfig({}), ...tmpPaths() };
  return opts.live ? { ...cfg, useFixtures: false } : cfg;
}

async function connect(config: AppConfig, env: NodeJS.ProcessEnv) {
  const built = buildMcpServer({
    config,
    env: { ...env, ...(config.useFixtures ? {} : { WORKDAY_TOKEN_ENCRYPTION_KEY: LIVE_KEY }) },
    client: new FixtureWorkdayClient(),
    domain: new FixtureWorkdayDomainClient(),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "check-mcp", version: "0" });
  await Promise.all([built.server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    return { isError: r.isError === true, text: r.content.map((c) => c.text).join("\n") };
  };
  return { ...built, client, call };
}

const liveToken = (): OAuthTokens => ({
  accessToken: "at",
  refreshToken: "rt",
  expiresAt: Date.now() + 3_600_000,
  tokenType: "Bearer",
});
const timeOff = {
  startDate: "2026-12-01",
  endDate: "2026-12-01",
  unit: "DAYS",
  quantity: 1,
  timeOffType: { type: "Time_Off_Type_ID", value: "PTO" },
};
const previewTokenOf = (text: string): string => (JSON.parse(text) as { previewToken: string }).previewToken;

await check("deny wins on the original time-off tools (balance, preview, commit)", async () => {
  const env = baseEnv({
    WORKDAY_USER_DENIES: "tool:get_my_time_off_balance,tool:preview_request_time_off,tool:commit_request_time_off",
  });
  const { call } = await connect(makeConfig(), env);
  for (const args of [
    { action: "balances" },
    { action: "request_preview", ...timeOff },
    { action: "request_commit", previewToken: "x".repeat(20), idempotencyKey: "key-12345", userConfirmed: true },
  ]) {
    const r = await call("time_off", args);
    assert.ok(r.isError, `${String(args.action)} should be denied`);
    assert.match(r.text, /explicitly denied/, String(args.action));
  }
});

await check("roles still allow the original tools when no deny is set", async () => {
  const { call } = await connect(makeConfig(), baseEnv());
  const r = await call("time_off", { action: "balances" });
  assert.ok(!r.isError, r.text);
});

await check("production guard: data-center-prefixed Workday hosts are refused without WORKDAY_ALLOW_PROD", () => {
  for (const host of [
    "https://wd2-services1.workday.com",
    "https://wd5-services1.myworkday.com",
    "https://services1.workday.com",
    "https://wd3.myworkday.com",
  ]) {
    assert.throws(() => loadConfig({ WORKDAY_BASE_URL: host, WORKDAY_TENANT: "acme" }), /production/, host);
    assert.doesNotThrow(
      () => loadConfig({ WORKDAY_BASE_URL: host, WORKDAY_TENANT: "acme", WORKDAY_ALLOW_PROD: "true" }),
      host,
    );
  }
  for (const host of ["https://wd2-impl-services1.workday.com", "https://wd5-preview-services1.myworkday.com"]) {
    assert.doesNotThrow(() => loadConfig({ WORKDAY_BASE_URL: host, WORKDAY_TENANT: "acme" }), host);
  }
});

await check("live mode requires a real token-store key; fixtures may use the dev key", () => {
  const live = makeConfig({ live: true });
  assert.throws(() => tokenStoreSecret(live, {}), /WORKDAY_TOKEN_ENCRYPTION_KEY/);
  assert.throws(() => tokenStoreSecret(live, { WORKDAY_TOKEN_ENCRYPTION_KEY: "short" }), /at least 32/);
  assert.throws(
    () => tokenStoreSecret(live, { WORKDAY_TOKEN_ENCRYPTION_KEY: "local-dev-only-change-me" }),
    /WORKDAY_TOKEN_ENCRYPTION_KEY/,
  );
  assert.equal(tokenStoreSecret(live, { WORKDAY_TOKEN_ENCRYPTION_KEY: LIVE_KEY }), LIVE_KEY);
  assert.ok(tokenStoreSecret(makeConfig(), {}).length > 0);
});

await check(
  "time_off request_commit: SIGN_IN_REQUIRED keeps the preview and does not pin the idempotency key",
  async () => {
    const { call, deps } = await connect(makeConfig({ live: true }), baseEnv());
    await deps.tokenStore.set(USER, liveToken());
    const pv = await call("time_off", { action: "request_preview", ...timeOff });
    assert.ok(!pv.isError, pv.text);
    const previewToken = previewTokenOf(pv.text);
    await deps.tokenStore.delete(USER); // session lost between preview and commit
    const args = { action: "request_commit", previewToken, idempotencyKey: "commit-key-1", userConfirmed: true };
    const first = await call("time_off", args);
    assert.ok(first.isError && /sign-in required/i.test(first.text), first.text);
    await deps.tokenStore.set(USER, liveToken());
    const second = await call("time_off", args);
    assert.ok(!second.isError, second.text);
    assert.equal((JSON.parse(second.text) as { submitted: boolean }).submitted, true);
  },
);

await check("framework commit (cancel): SIGN_IN_REQUIRED keeps the preview token", async () => {
  const { call, deps } = await connect(makeConfig({ live: true }), baseEnv());
  await deps.tokenStore.set(USER, liveToken());
  const pv = await call("time_off", {
    action: "cancel_preview",
    requestId: { type: "Time_Off_Entry_ID", value: "TOE_MY_1" },
  });
  assert.ok(!pv.isError, pv.text);
  const previewToken = previewTokenOf(pv.text);
  await deps.tokenStore.delete(USER);
  const args = { action: "cancel_commit", previewToken, idempotencyKey: "cancel-key-1", userConfirmed: true };
  const first = await call("time_off", args);
  assert.ok(first.isError && /SIGN_IN_REQUIRED/.test(first.text), first.text);
  await deps.tokenStore.set(USER, liveToken());
  const second = await call("time_off", args);
  assert.ok(!second.isError, second.text);
});

await check("redactPii covers schema PII names and scrubs emails and bearer tokens", async () => {
  const redacted = redactPii({
    preferredName: "Ada Lovelace",
    grossAmount: 4200,
    nationalId: "NL123456",
    descriptor: "Ada Lovelace",
    hireDate: "2020-01-01",
    summary: "ping ada@example.com with Bearer super-secret-token",
    manager: { descriptor: "Grace Hopper" },
  }) as Record<string, unknown>;
  assert.equal(redacted.preferredName, "[REDACTED]");
  assert.equal(redacted.grossAmount, "[REDACTED]");
  assert.equal(redacted.nationalId, "[REDACTED]");
  assert.equal(redacted.descriptor, "[REDACTED]");
  assert.equal(redacted.hireDate, "[REDACTED]");
  assert.equal((redacted.manager as { descriptor: string }).descriptor, "[REDACTED]");
  assert.equal(String(redacted.summary).includes("ada@example.com"), false);
  assert.equal(String(redacted.summary).includes("super-secret-token"), false);
  assert.match(String(redacted.summary), /\[REDACTED_EMAIL\]/);
  assert.match(String(redacted.summary), /Bearer \[REDACTED\]/);

  const config = makeConfig();
  const audit = new AuditLogger(config.auditLogPath);
  await audit.log({
    ts: new Date().toISOString(),
    userId: USER,
    tool: "get_my_worker_profile",
    inputs: { preferredName: "Ada Lovelace" },
    result: "error",
    latencyMs: 1,
    errorMessage: "failed for ada@example.com Bearer super-secret-token",
  });
  const log = readFileSync(config.auditLogPath, "utf8");
  assert.equal(log.includes("Ada Lovelace"), false);
  assert.equal(log.includes("ada@example.com"), false);
  assert.equal(log.includes("super-secret-token"), false);
  assert.match(log, /\[REDACTED_EMAIL\]/);
  assert.match(log, /Bearer \[REDACTED\]/);
});

await check("stderr logger redacts nested fields with the same key predicate", () => {
  const out = redactFields({
    evt: "sample",
    nested: { preferredName: "Ada Lovelace", note: "ada@example.com Bearer super-secret-token" },
    items: [{ grossAmount: 10 }],
  }) as { nested: { preferredName: string; note: string }; items: Array<{ grossAmount: string }> };
  assert.equal(out.nested.preferredName, "[redacted]");
  assert.equal(out.nested.note, "[redacted]");
  assert.equal(out.items[0]!.grossAmount, "[redacted]");
  assert.equal(JSON.stringify(out).includes("Ada Lovelace"), false);
  assert.equal(JSON.stringify(out).includes("super-secret-token"), false);
});

await check("Workday fault text drops emails and bearer tokens before the model sees it", async () => {
  const config = loadConfig({
    WORKDAY_USE_FIXTURES: "false",
    WORKDAY_ABSENCE_API_VERSION: "v1",
    WORKDAY_VALIDATED_OPERATIONS: "balances.list",
    WORKDAY_OAUTH_CLIENT_ID: "client",
    WORKDAY_OAUTH_CLIENT_SECRET: "secret-value",
    WORKDAY_BASE_URL: "https://wd2-impl-services1.workday.com",
    WORKDAY_TENANT: "sandbox_tenant",
  });
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ message: "Contact ada@example.com. Bearer super-secret-token" }), {
      status: 400,
    })) as typeof fetch;
  const client = new HttpWorkdayClient(
    config,
    { apiVersion: "v1", validatedOperations: ["balances.list"], timeoutMs: 5000 },
    fetchImpl,
  );
  await assert.rejects(
    () => client.getMyTimeOffBalances("at"),
    (err: unknown) => {
      assert.ok(err instanceof WorkdayApiError);
      assert.equal(err.message.includes("ada@example.com"), false);
      assert.equal(err.message.includes("super-secret-token"), false);
      assert.match(err.message, /\[REDACTED_EMAIL\]/);
      assert.match(err.message, /Bearer \[REDACTED\]/);
      return true;
    },
  );
});

await check("audit log redacts free-text comment and is owner-only", async () => {
  const config = makeConfig();
  const { call } = await connect(config, baseEnv());
  const r = await call("time_off", { action: "request_preview", ...timeOff, comment: "flu, doctor's note attached" });
  assert.ok(!r.isError, r.text);
  const log = readFileSync(config.auditLogPath, "utf8");
  assert.ok(!log.includes("flu"), "comment leaked into audit log");
  assert.match(log, /"comment":"\[REDACTED\]"/);
  if (process.platform !== "win32") {
    const { statSync } = await import("node:fs");
    assert.equal(statSync(config.auditLogPath).mode & 0o777, 0o600);
  }
});

await check(
  "tool annotations: time_off can write and is destructive, catalog is closed-world, pay is read-only",
  async () => {
    const { client } = await connect(makeConfig(), baseEnv());
    const tools = new Map((await client.listTools()).tools.map((t) => [t.name, t.annotations ?? {}]));
    assert.equal(tools.get("time_off")?.readOnlyHint, false);
    assert.equal(tools.get("time_off")?.destructiveHint, true);
    assert.equal(tools.get("time_off")?.idempotentHint, false);
    assert.equal(tools.get("time_off")?.openWorldHint, true);
    assert.equal(tools.get("catalog")?.openWorldHint, false);
    assert.equal(tools.get("worker")?.readOnlyHint, true);
    assert.equal(tools.get("pay")?.readOnlyHint, true);
    assert.equal(tools.has("get_my_time_off_balance"), false);
    assert.ok(tools.size >= 8 && tools.size <= 15, `tool count ${tools.size}`);
  },
);

await check("pending sign-ins expire, are capped, and are single use", () => {
  const pending = new Map<string, PkcePair>();
  const old = { ...createPkcePair(), createdAt: Date.now() - PKCE_TTL_MS - 1 };
  pending.set(old.state, old);
  rememberPkce(pending, createPkcePair());
  assert.ok(!pending.has(old.state), "expired pair kept");
  for (let i = 0; i < 50; i++) rememberPkce(pending, createPkcePair());
  assert.ok(pending.size <= 20, `pending map grew to ${pending.size}`);
  const p = createPkcePair();
  rememberPkce(pending, p);
  assert.ok(takePkce(pending, p.state));
  assert.equal(takePkce(pending, p.state), undefined);
});

await check("loopback OAuth callback: valid state stores tokens once; replayed or unknown state refused", async () => {
  assert.ok(isLoopbackRedirect("http://127.0.0.1:8787/oauth/callback"));
  assert.ok(!isLoopbackRedirect("https://example.com/oauth/callback"));
  const config = makeConfig({ live: true });
  const tokenStore = new TokenStore(config.tokenStorePath, LIVE_KEY);
  const pending = new Map<string, PkcePair>();
  const pkce = createPkcePair();
  rememberPkce(pending, pkce);
  let verifierSeen = "";
  const fetchImpl = (async (_url: string, init: { body: URLSearchParams }) => {
    verifierSeen = init.body.get("code_verifier") ?? "";
    return new Response(JSON.stringify({ access_token: "linked-at", refresh_token: "linked-rt", expires_in: 3600 }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  const server = createLoopbackCallbackServer({
    config,
    tokenStore,
    pendingPkce: pending,
    resolveUserId: () => USER,
    fetchImpl,
    log: () => {},
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as AddressInfo).port;
    const url = (state: string) => `http://127.0.0.1:${port}/oauth/callback?state=${state}&code=abc`;
    assert.equal((await fetch(url(pkce.state))).status, 200);
    assert.equal(verifierSeen, pkce.codeVerifier);
    assert.equal((await tokenStore.get(USER))?.accessToken, "linked-at");
    assert.equal((await fetch(url(pkce.state))).status, 400, "replay accepted");
    assert.equal((await fetch(url("unknown-state-123456"))).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 404);
  } finally {
    server.close();
  }
});

await check("token file binds ciphertext to the user id", async () => {
  const config = makeConfig({ live: true });
  const store = new TokenStore(config.tokenStorePath, LIVE_KEY);
  await store.set("alice", { ...liveToken(), accessToken: "alice-token" });
  await store.set("bob", { ...liveToken(), accessToken: "bob-token" });
  const rows = JSON.parse(readFileSync(config.tokenStorePath, "utf8")) as Array<{
    userId: string;
    ciphertext: string;
    iv: string;
    tag: string;
  }>;
  const alice = rows.find((r) => r.userId === "alice");
  const bob = rows.find((r) => r.userId === "bob");
  assert.ok(alice && bob);
  const swapped = rows.map((r) =>
    r.userId === "bob" ? { ...r, ciphertext: alice.ciphertext, iv: alice.iv, tag: alice.tag } : r,
  );
  writeFileSync(config.tokenStorePath, JSON.stringify(swapped));
  await assert.rejects(() => store.get("bob"));
  assert.equal((await store.get("alice"))?.accessToken, "alice-token");
});

await check("extend skills declare when to use them, and self-service stops on the missing marital-status tool", () => {
  const dir = new URL("../extend/skills/", import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith(".md"));
  assert.equal(files.length, 6);
  for (const name of files) {
    const text = readFileSync(new URL(name, dir), "utf8");
    assert.match(text, /^---\nname: /);
    assert.match(text, /^description: /m);
    assert.match(text, /\*\*Boundary\.\*\*/);
  }
  const self = readFileSync(new URL("self-service-skill.md", dir), "utf8");
  assert.match(self, /Do not call it/);
  assert.match(self, /update_personal_information_marital_status/);
  const payroll = readFileSync(new URL("payroll-viewer-skill.md", dir), "utf8");
  const admin = readFileSync(new URL("admin-skill.md", dir), "utf8");
  assert.match(payroll, /The body below is the tenant text, unchanged\./);
  assert.match(admin, /The body below is the tenant text, unchanged\./);
  assert.match(payroll, /^# Payroll Viewer Skill/m);
  assert.match(admin, /^# Admin Skill/m);
});

await check("refresh: refused grant deletes token and asks for sign-in; outage keeps token", async () => {
  const config = makeConfig({ live: true });
  const store = new TokenStore(config.tokenStorePath, LIVE_KEY);
  const expired = { ...liveToken(), expiresAt: Date.now() - 1 };
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;
    await store.set(USER, expired);
    await assert.rejects(
      requireUserAccessToken(config, store, USER, new Map()),
      (e) => !(e instanceof SignInRequiredError),
    );
    assert.ok(await store.get(USER), "token deleted on a 503");

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;
    await assert.rejects(requireUserAccessToken(config, store, USER, new Map()), SignInRequiredError);
    assert.equal(await store.get(USER), undefined, "dead token kept after invalid_grant");
  } finally {
    globalThis.fetch = realFetch;
  }
});

if (failed) {
  console.error(`${failed} MCP check(s) failed`);
  process.exit(1);
}
console.log("\nall MCP checks passed");
