/**
 * HTTP routing for the integration runtime:
 *   GET  /healthz              liveness (process up)
 *   GET  /readyz               readiness (database reachable, schema current)
 *   GET  /oauth/callback       Workday OAuth redirect for account linking
 *   POST /slack/events         Events API intake
 *   POST /slack/commands       /workday slash command
 *   POST /slack/interactions   modal submit, shortcut, approval buttons
 * State is in Postgres (see src/store), so any number of instances can serve traffic.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { SlackConfig } from "./config.js";
import type { IdentityResolver } from "./identity.js";
import type { ReplayGuard } from "./slack/verify.js";
import { handleSlackEvent, type IntakeSink } from "./slack/intake.js";
import { handleViewSubmission, type FormSessions } from "./slack/forms.js";
import { handleApprovalAction } from "./slack/interactions.js";
import { handleShortcut, handleSlashCommand } from "./slack/commands.js";
import type { SlackApi } from "./slack/api.js";
import type { ApprovalDecider } from "./approvals/workflow.js";
import type { ApprovalExecutionService } from "./approvals/execution.js";
import type { LinkService } from "./link.js";
import type { LogFn } from "../observability/log.js";

export type RouterContext = {
  slack: SlackConfig;
  identities: IdentityResolver;
  replay: ReplayGuard;
  sessions: FormSessions;
  service: ApprovalExecutionService;
  decider: ApprovalDecider;
  link?: LinkService;
  slackApi?: SlackApi;
  commandName: string;
  sink: IntakeSink;
  ready: () => Promise<boolean>;
  log: LogFn;
  nowSec?: number;
};

export type RouteResult = { status: number; contentType?: string; body: string };

const html = (status: number, message: string): RouteResult => ({
  status,
  contentType: "text/html; charset=utf-8",
  body: `<!doctype html><meta charset="utf-8"><title>Workday link</title><p>${message.replace(/[<>&]/g, "")}</p>`,
});

export function createRouter(ctx: RouterContext): (method: string, url: string, rawBody: string, headers: Record<string, string | undefined>) => Promise<RouteResult> {
  const base = { config: ctx.slack, identities: ctx.identities, replay: ctx.replay, nowSec: ctx.nowSec };
  const cmd = { ...base, sessions: ctx.sessions, service: ctx.service, slackApi: ctx.slackApi, link: ctx.link, commandName: ctx.commandName, log: ctx.log };
  return async (method, url, raw, headers) => {
    const u = new URL(url, "http://local");
    if (method === "GET" && u.pathname === "/healthz") return { status: 200, contentType: "text/plain", body: "ok" };
    if (method === "GET" && u.pathname === "/readyz") {
      const ok = await ctx.ready().catch(() => false);
      return { status: ok ? 200 : 503, contentType: "text/plain", body: ok ? "ready" : "not ready" };
    }
    if (method === "GET" && u.pathname === "/oauth/callback") {
      if (!ctx.link) return html(404, "Linking is not configured.");
      const out = await ctx.link.callback(u.searchParams);
      ctx.log({ evt: "oauth_callback", status: out.status });
      return html(out.status, out.message);
    }
    if (method !== "POST") return { status: 405, body: "" };
    if (!ctx.slack.enabled) return { status: 404, body: "" };
    if (u.pathname === "/slack/events") {
      const out = await handleSlackEvent(raw, headers, { ...base, sink: ctx.sink, log: ctx.log });
      return { status: out.status, contentType: "text/plain", body: out.body };
    }
    if (u.pathname === "/slack/commands") {
      const out = await handleSlashCommand(raw, headers, cmd);
      return { status: out.status, contentType: "application/json", body: out.body === "" ? "" : JSON.stringify(out.body) };
    }
    if (u.pathname === "/slack/interactions") {
      // Type peek is for dispatch only; every handler verifies the signature before trusting anything.
      let type: string | undefined;
      try {
        type = (JSON.parse(new URLSearchParams(raw).get("payload") ?? "{}") as { type?: string }).type;
      } catch {
        type = undefined;
      }
      if (type === "view_submission") {
        const out = await handleViewSubmission(raw, headers, { ...base, sessions: ctx.sessions, service: ctx.service });
        return { status: out.status, contentType: "application/json", body: out.body === "" ? "" : JSON.stringify(out.body) };
      }
      if (type === "shortcut") return { status: (await handleShortcut(raw, headers, cmd)).status, body: "" };
      if (type === "block_actions") return { status: (await handleApprovalAction(raw, headers, { ...base, workflow: ctx.decider })).status, body: "" };
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

/** node:http server with request/header timeouts and body size cap. */
export function createHttpServer(route: ReturnType<typeof createRouter>, opts: { maxBodyBytes: number; log: LogFn }): Server {
  const server = createServer(async (req, res) => {
    const started = Date.now();
    try {
      const raw = req.method === "POST" ? await readRawBody(req, opts.maxBodyBytes) : "";
      if (raw === undefined) return void res.writeHead(413).end();
      const out = await route(req.method ?? "GET", req.url ?? "/", raw, headerMap(req));
      res.writeHead(out.status, { ...(out.contentType ? { "content-type": out.contentType } : {}), "cache-control": "no-store" }).end(out.body);
      opts.log({ evt: "http", path: (req.url ?? "").split("?")[0], status: out.status, ms: Date.now() - started });
    } catch (e) {
      opts.log({ evt: "http_error", path: (req.url ?? "").split("?")[0], err: e instanceof Error ? e.name : "error" });
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
