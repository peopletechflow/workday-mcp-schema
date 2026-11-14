/**
 * Behavior checks for commit classification, idempotency bounds, rate limits,
 * metrics, live JSON parsing, token-store locking, and outcome routing.
 * Run: pnpm run check:safety
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { AGENT_READY_CATALOG } from "../src/agent-ready/catalog.js";
import { outcomeForCatalogTool, OUTCOME_IDS } from "../src/agent-ready/outcome-groups.js";
import { classifyCommitFailure, CommitUncertainError } from "../src/safety/commit-outcome.js";
import { IdempotencyCapacityError, IdempotencyStore } from "../src/safety/idempotency.js";
import { RateLimitError, SlidingWindowRateLimiter } from "../src/safety/rate-limit.js";
import { InMemoryToolMetrics } from "../src/observability/tool-metrics.js";
import {
  HttpWorkdayClient,
  WorkdayAmbiguousResultError,
  WorkdayApiError,
  WorkdayResponseParseError,
} from "../src/workday/client.js";
import { loadConfig } from "../src/config.js";
import { TokenStore } from "../src/auth/token-store.js";
import { exchangeAuthorizationCode } from "../src/auth/oauth.js";
import { loadAssignmentsFromJsonFile } from "../src/rbac/assignments.js";
import { commitTimeOffPreview, createTimeOffPreview } from "../src/tools/time-off-core.js";
import { FixtureWorkdayClient } from "../src/workday/fixtures.js";
import { PreviewStore } from "../src/safety/preview-store.js";
import { NATIVE_WRITE_FLOWS, type NativeBpFlow } from "../src/safety/native-write-guard.js";

let failed = 0;
function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok   ${name}`))
    .catch((e: unknown) => {
      failed++;
      console.error(`FAIL ${name}\n     ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    });
}

await check("classifyCommitFailure matches the approval ledger", () => {
  assert.equal(classifyCommitFailure(new WorkdayApiError(400, { code: "bad", message: "no" })), "error");
  assert.equal(classifyCommitFailure(new WorkdayApiError(404, { code: "missing", message: "no" })), "error");
  assert.equal(classifyCommitFailure(new WorkdayApiError(500, { code: "down", message: "no" })), "unknown");
  assert.equal(classifyCommitFailure(new WorkdayApiError(408, { code: "timeout", message: "no" })), "unknown");
  assert.equal(classifyCommitFailure(new WorkdayApiError(429, { code: "slow", message: "no" })), "unknown");
  assert.equal(classifyCommitFailure(new WorkdayAmbiguousResultError("requestTimeOff.create", "timeout")), "unknown");
  assert.equal(classifyCommitFailure(new WorkdayResponseParseError("balances.list", "bad json")), "unknown");
  const app = new Error("nope");
  app.name = "ToolUserError";
  assert.equal(classifyCommitFailure(app), "error");
});

await check("idempotency: unknown is kept, definitive rows expire, capacity refuses to drop unknown", () => {
  let now = Date.parse("2026-11-14T00:00:00Z");
  const store = new IdempotencyStore({ ttlMs: 1_000, maxEntries: 2, now: () => now });
  store.set("u", "tool", "ok-key", { status: "ok", body: { ok: true } });
  store.set("u", "tool", "unk-key", {
    status: "unknown",
    body: { error: "COMMIT_UNCERTAIN" },
    subject: { startDate: "2026-12-01" },
  });
  now += 5_000;
  assert.equal(store.get("u", "tool", "ok-key"), undefined);
  assert.equal(store.get("u", "tool", "unk-key")?.status, "unknown");
  store.set("u", "tool", "a", { status: "unknown", body: {} });
  assert.throws(() => store.set("u", "tool", "b", { status: "unknown", body: {} }), IdempotencyCapacityError);
});

await check("rate limit is per user and per tool", () => {
  const limiter = new SlidingWindowRateLimiter({ readLimit: 2, writeLimit: 1, windowMs: 60_000 });
  limiter.consume("ada", "time_off:balances", "read");
  limiter.consume("ada", "time_off:balances", "read");
  assert.throws(() => limiter.consume("ada", "time_off:balances", "read"), RateLimitError);
  limiter.consume("ada", "time_off:history", "read");
  limiter.consume("grace", "time_off:balances", "read");
  limiter.consume("ada", "time_off:request_commit", "write");
  assert.throws(() => limiter.consume("ada", "time_off:request_commit", "write"), RateLimitError);
});

await check("metrics sink records outcome and latency and does not log tokens", () => {
  const lines: string[] = [];
  const metrics = new InMemoryToolMetrics((fields) => lines.push(JSON.stringify(fields)));
  metrics.record({ tool: "time_off", action: "balances", outcome: "ok", latencyMs: 12 });
  metrics.record({
    tool: "time_off",
    action: "request_commit",
    outcome: "unknown",
    latencyMs: 40,
    errorCode: "COMMIT_UNCERTAIN",
  });
  const row = metrics.snapshot().get("time_off:balances");
  assert.equal(row?.calls, 1);
  assert.equal(row?.latencyMsTotal, 12);
  const text = lines.join("\n");
  assert.match(text, /"evt":"tool.metric"/);
  assert.equal(text.includes("Bearer"), false);
  assert.equal(text.includes("accessToken"), false);
  assert.equal(text.includes("super-secret"), false);
});

await check("live balance JSON fails closed instead of inventing values", async () => {
  const cfg = loadConfig({
    WORKDAY_USE_FIXTURES: "false",
    WORKDAY_ABSENCE_API_VERSION: "v1",
    WORKDAY_VALIDATED_OPERATIONS: "balances.list",
    WORKDAY_OAUTH_CLIENT_ID: "client",
    WORKDAY_OAUTH_CLIENT_SECRET: "secret-value",
    WORKDAY_BASE_URL: "https://wd2-impl-services1.workday.com",
    WORKDAY_TENANT: "sandbox_tenant",
  });
  const bodies = [
    {
      data: [
        { id: "PTO", timeOffTypeName: "PTO", unit: "DAYS", available: Number.NaN, pending: 0, asOf: "2026-11-14" },
      ],
    },
    { data: [{ id: "PTO", timeOffTypeName: "PTO", available: 1, pending: 0, asOf: "2026-11-14" }] },
    { data: [{ unit: "DAYS", available: 1, pending: 0, asOf: "2026-11-14" }] },
  ];
  for (const body of bodies) {
    const client = new HttpWorkdayClient(
      cfg,
      { apiVersion: "v1", validatedOperations: ["balances.list"], timeoutMs: 1000 },
      (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch,
    );
    await assert.rejects(() => client.getMyTimeOffBalances("token"), WorkdayResponseParseError);
  }
  const ok = new HttpWorkdayClient(
    cfg,
    { apiVersion: "v1", validatedOperations: ["balances.list"], timeoutMs: 1000 },
    (async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: "PTO",
              timeOffTypeName: "Paid Time Off",
              unit: "HOURS",
              available: 3,
              pending: 1,
              asOf: "2026-11-14",
            },
          ],
        }),
        { status: 200 },
      )) as typeof fetch,
  );
  const balances = await ok.getMyTimeOffBalances("token");
  assert.equal(balances[0]?.available, 3);
  assert.equal(balances[0]?.unit, "HOURS");
  assert.equal(balances[0]?.timeOffType.value, "PTO");
});

await check("uncertain time-off commit is not resubmitted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wd-safety-"));
  const config = {
    ...loadConfig({}),
    tokenStorePath: join(dir, "tokens.json"),
    auditLogPath: join(dir, "audit.jsonl"),
  };
  const client = new FixtureWorkdayClient();
  let submits = 0;
  client.submitTimeOffRequest = async () => {
    submits += 1;
    throw new WorkdayAmbiguousResultError("requestTimeOff.create", "timeout");
  };
  const deps = {
    config,
    client,
    previewStore: new PreviewStore(),
    idempotency: new IdempotencyStore(),
    tokenStore: new TokenStore(config.tokenStorePath, "local-dev-only-change-me"),
    pendingPkce: new Map(),
  };
  const preview = await createTimeOffPreview(deps, "u", {
    startDate: "2026-12-01",
    endDate: "2026-12-01",
    unit: "DAYS",
    quantity: 1,
    timeOffType: { type: "Time_Off_Type_ID", value: "PTO" },
  });
  await assert.rejects(
    () => commitTimeOffPreview(deps, "u", preview.previewToken, "idem-uncertain-1"),
    CommitUncertainError,
  );
  await assert.rejects(
    () => commitTimeOffPreview(deps, "u", preview.previewToken, "idem-uncertain-1"),
    CommitUncertainError,
  );
  assert.equal(submits, 1);
  assert.equal(deps.idempotency.get("u", "commit_request_time_off", "idem-uncertain-1")?.status, "unknown");
});

await check("token store serializes concurrent writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wd-tokens-"));
  const store = new TokenStore(join(dir, "tokens.json"), "k".repeat(40));
  await Promise.all([
    store.set("a", { accessToken: "a-token", expiresAt: 1, tokenType: "Bearer" }),
    store.set("b", { accessToken: "b-token", expiresAt: 2, tokenType: "Bearer" }),
  ]);
  assert.equal((await store.get("a"))?.accessToken, "a-token");
  assert.equal((await store.get("b"))?.accessToken, "b-token");
});

await check("oauth token JSON is parsed, not cast", async () => {
  const config = loadConfig({});
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ token_type: "bearer" }), { status: 200 })) as typeof fetch;
  await assert.rejects(() => exchangeAuthorizationCode(config, "code", "verifier", fetchImpl), /expected shape/);
});

await check("assignment file is rejected when it is not the expected shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "wd-rbac-"));
  const path = join(dir, "assignments.json");
  writeFileSync(path, JSON.stringify({ assignments: [{ roles: ["worker_self"] }] }));
  assert.throws(() => loadAssignmentsFromJsonFile(path), /not valid/);
});

await check("every catalog operation routes to one outcome", () => {
  const counts = new Map<string, number>();
  for (const id of OUTCOME_IDS) counts.set(id, 0);
  for (const tool of AGENT_READY_CATALOG.tools) {
    const outcome = outcomeForCatalogTool(tool);
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  }
  const sum = [...counts.values()].reduce((total, n) => total + n, 0);
  assert.equal(sum, 158);
  assert.equal(counts.get("time_off"), 10);
  assert.equal(counts.get("pay"), 30);
  for (const flow of Object.keys(NATIVE_WRITE_FLOWS) as NativeBpFlow[]) {
    assert.equal(typeof flow, "string");
  }
});

if (failed) {
  console.error(`${failed} safety check(s) failed`);
  process.exit(1);
}
console.log("\nall safety checks passed");
