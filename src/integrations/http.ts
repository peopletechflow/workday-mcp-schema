/**
 * Slack HTTP entrypoint: /slack/events, /slack/commands, /slack/interactions.
 *
 * Single process only. Approvals, preview tokens, form sessions, replay cache, and idempotency
 * live in memory: a restart loses pending approvals, and running more than one instance would
 * split state. `assertSingleInstance` refuses common multi-instance settings.
 */
import cluster from "node:cluster";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { loadIntegrationConfig, type SlackConfig } from "./config.js";
import { IdentityDirectory } from "./identity.js";
import { ReplayCache } from "./slack/verify.js";
import { handleSlackEvent, InMemoryIntakeSink, type IntakeSink } from "./slack/intake.js";
import { FormSessionStore, handleViewSubmission } from "./slack/forms.js";
import { handleApprovalAction } from "./slack/interactions.js";
import { handleShortcut, handleSlashCommand } from "./slack/commands.js";
import { createHttpSlackApi, type SlackApi } from "./slack/api.js";
import { ApprovalWorkflow } from "./approvals/workflow.js";
import { ApprovalExecutionService, DEFAULT_TIME_OFF_TYPE_MAP, type AuthzResolver, type TimeOffTypeMap } from "./approvals/execution.js";
import type { TimeOffCoreDeps } from "../tools/time-off-core.js";
import type { IntakeLog } from "./slack/redact.js";

export function assertSingleInstance(env: NodeJS.ProcessEnv = process.env): void {
  const n = (k: string) => Number(env[k] ?? "1");
  if (cluster.isWorker) throw new Error("Integrations refuse to run in a cluster worker: approval state is in-memory.");
  for (const k of ["WEB_CONCURRENCY", "INTEGRATIONS_INSTANCE_COUNT"]) {
    if (Number.isFinite(n(k)) && n(k) > 1) throw new Error(`${k}>1 is unsupported: approval state is in-memory, single process only.`);
  }
  if (env.NODE_APP_INSTANCE && env.NODE_APP_INSTANCE !== "0") throw new Error("Multiple PM2 instances unsupported: approval state is in-memory.");
}

export type SlackRouterContext = {
  config: SlackConfig;
  identities: IdentityDirectory;
  service: ApprovalExecutionService;
  workflow: ApprovalWorkflow;
  slackApi?: SlackApi;
  commandName: string;
  sink: IntakeSink;
  replay?: ReplayCache;
  sessions?: FormSessionStore;
  nowSec?: number;
  log?: IntakeLog;
};

export type RouteResult = { status: number; contentType?: string; body: string };

/** Pure router, used by the HTTP server and by offline end-to-end checks. */
export function createSlackRouter(ctx: SlackRouterContext): (path: string, rawBody: string, headers: Record<string, string | undefined>) => Promise<RouteResult> {
  const replay = ctx.replay ?? new ReplayCache();
  const sessions = ctx.sessions ?? new FormSessionStore();
  const base = { config: ctx.config, identities: ctx.identities, replay, nowSec: ctx.nowSec };
  const cmd = { ...base, sessions, service: ctx.service, slackApi: ctx.slackApi, commandName: ctx.commandName, log: ctx.log };
  return async (path, raw, headers) => {
    if (path === "/slack/events") {
      const out = handleSlackEvent(raw, headers, { ...base, sink: ctx.sink, log: ctx.log });
      return { status: out.status, contentType: "text/plain", body: out.body };
    }
    if (path === "/slack/commands") {
      const out = await handleSlashCommand(raw, headers, cmd);
      return { status: out.status, contentType: "application/json", body: out.body === "" ? "" : JSON.stringify(out.body) };
    }
    if (path === "/slack/interactions") {
      // Type peek is for dispatch only; every handler verifies the signature before trusting anything.
      let type: string | undefined;
      try {
        type = (JSON.parse(new URLSearchParams(raw).get("payload") ?? "{}") as { type?: string }).type;
      } catch {
        type = undefined;
      }
      if (type === "view_submission") {
        const out = await handleViewSubmission(raw, headers, { ...base, sessions, service: ctx.service });
        return { status: out.status, contentType: "application/json", body: out.body === "" ? "" : JSON.stringify(out.body) };
      }
      if (type === "shortcut") return { status: (await handleShortcut(raw, headers, cmd)).status, body: "" };
      if (type === "block_actions") return { status: handleApprovalAction(raw, headers, { ...base, workflow: ctx.workflow }).status, body: "" };
      return { status: 400, body: "" };
    }
    return { status: 404, body: "" };
  };
}

export async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function headerMap(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  return out;
}

/** Build the server from env. Returns undefined when Slack is disabled. */
export function createSlackServer(opts: {
  env?: NodeJS.ProcessEnv;
  core: TimeOffCoreDeps;
  authzFor: AuthzResolver;
  typeMap?: TimeOffTypeMap;
  sink?: IntakeSink;
}): Server | undefined {
  const env = opts.env ?? process.env;
  const cfg = loadIntegrationConfig(env);
  if (!cfg.slack.enabled) return undefined;
  assertSingleInstance(env);
  if (!cfg.approvals.policyPath) throw new Error("APPROVAL_POLICY_PATH required when Slack is enabled (fail closed).");
  const identities = IdentityDirectory.fromFile(cfg.slack.identityMapPath!);
  const workflow = ApprovalWorkflow.fromFile(cfg.approvals.policyPath, cfg.approvals.ttlMs);
  const service = new ApprovalExecutionService({ workflow, core: opts.core, authzFor: opts.authzFor, typeMap: opts.typeMap ?? DEFAULT_TIME_OFF_TYPE_MAP });
  const route = createSlackRouter({
    config: cfg.slack,
    identities,
    service,
    workflow,
    slackApi: cfg.slack.botToken ? createHttpSlackApi(cfg.slack.botToken) : undefined,
    commandName: env.SLACK_COMMAND_NAME || "/workday",
    sink: opts.sink ?? new InMemoryIntakeSink(),
  });
  return createServer(async (req, res) => {
    if (req.method !== "POST") return void res.writeHead(405).end();
    const raw = await readRawBody(req, cfg.slack.maxBodyBytes);
    if (raw === undefined) return void res.writeHead(413).end();
    const out = await route(req.url ?? "", raw, headerMap(req));
    res.writeHead(out.status, out.contentType ? { "content-type": out.contentType } : {}).end(out.body);
  });
}
