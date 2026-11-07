/**
 * Minimal node:http listener for Slack Events and Interactivity. Starts only when
 * SLACK_ENABLED=true and required config is present. Reads the raw body with a size cap
 * (signature is computed over the exact bytes). Responds with status only; never posts
 * messages on its own.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { loadIntegrationConfig } from "./config.js";
import { IdentityDirectory } from "./identity.js";
import { ReplayCache } from "./slack/verify.js";
import { handleSlackEvent, InMemoryIntakeSink, type IntakeSink } from "./slack/intake.js";
import { FormSessionStore, handleViewSubmission } from "./slack/forms.js";
import { handleApprovalAction } from "./slack/interactions.js";
import { ApprovalWorkflow, type RequesterAuthz } from "./approvals/workflow.js";
import type { BoundIdentity } from "./identity.js";

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

export function createSlackServer(opts: {
  env?: NodeJS.ProcessEnv;
  authzFor: (identity: BoundIdentity) => RequesterAuthz;
  sink?: IntakeSink;
}): Server | undefined {
  const cfg = loadIntegrationConfig(opts.env);
  if (!cfg.slack.enabled) return undefined;
  if (!cfg.approvals.policyPath) throw new Error("APPROVAL_POLICY_PATH required when Slack is enabled (fail closed).");
  const identities = IdentityDirectory.fromFile(cfg.slack.identityMapPath!);
  const workflow = ApprovalWorkflow.fromFile(cfg.approvals.policyPath, cfg.approvals.ttlMs);
  const replay = new ReplayCache();
  const sessions = new FormSessionStore();
  const sink = opts.sink ?? new InMemoryIntakeSink();

  return createServer(async (req, res) => {
    const raw = req.method === "POST" ? await readRawBody(req, cfg.slack.maxBodyBytes) : undefined;
    if (raw === undefined) {
      res.writeHead(req.method === "POST" ? 413 : 405).end();
      return;
    }
    const headers = headerMap(req);
    if (req.url === "/slack/events") {
      const out = handleSlackEvent(raw, headers, { config: cfg.slack, identities, replay, sink });
      res.writeHead(out.status, { "content-type": "text/plain" }).end(out.body);
      return;
    }
    if (req.url === "/slack/interactions") {
      const payloadType = (() => {
        try {
          return (JSON.parse(new URLSearchParams(raw).get("payload") ?? "{}") as { type?: string }).type;
        } catch {
          return undefined;
        }
      })();
      if (payloadType === "view_submission") {
        const out = handleViewSubmission(raw, headers, { config: cfg.slack, identities, replay, sessions, workflow, authzFor: opts.authzFor });
        res.writeHead(out.status, { "content-type": "application/json" }).end(out.body === "" ? "" : JSON.stringify(out.body));
        return;
      }
      const out = handleApprovalAction(raw, headers, { config: cfg.slack, identities, replay, workflow });
      res.writeHead(out.status).end();
      return;
    }
    res.writeHead(404).end();
  });
}
