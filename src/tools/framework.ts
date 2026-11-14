import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { assertToolEnabled } from "../config.js";
import type { AuditLogger } from "../safety/audit.js";
import type { IdempotencyStore } from "../safety/idempotency.js";
import type { PreviewStore } from "../safety/preview-store.js";
import type { TokenStore } from "../auth/token-store.js";
import type { PkcePair } from "../auth/oauth.js";
import { SignInRequiredError } from "../auth/oauth.js";
import { ensureFixtureSession, requireUserAccessToken } from "../session.js";
import type { WorkdayDomainClient } from "../workday/domain.js";
import type { WorkdayClient } from "../workday/client.js";
import { NotImplementedError } from "../workday/domain.js";
import { WorkdayApiError } from "../workday/client.js";
import type { ToolContract } from "../schemas/tools/contract.js";
import type { McpToolError } from "../schemas/errors.js";
import { classifyCommitFailure, CommitUncertainError } from "../safety/commit-outcome.js";
import { RateLimitError, type SlidingWindowRateLimiter } from "../safety/rate-limit.js";
import type { ToolMetricsSink, ToolMetricOutcome } from "../observability/tool-metrics.js";
import type { Role } from "../rbac/index.js";
import type { AssignmentStore } from "../rbac/index.js";
import { assertToolAllowedForUser, RbacDeniedError } from "../rbac/index.js";
import { registryEntry } from "./registry.js";

export type ToolDeps = {
  config: AppConfig;
  client: WorkdayClient;
  domain: WorkdayDomainClient;
  audit: AuditLogger;
  previewStore: PreviewStore;
  idempotency: IdempotencyStore;
  tokenStore: TokenStore;
  pendingPkce: Map<string, PkcePair>;
  resolveUserId: () => string;
  /** Caller roles from WORKDAY_USER_ROLES on stdio. Not a Workday security-group lookup. */
  resolveUserRoles: () => Role[];
  /** Lowest-level user permission assignments (grants/denies). Optional; fail closed without grants. */
  assignments?: AssignmentStore;
  /** Per user, per tool. Absent only in narrow unit tests. */
  rateLimit?: SlidingWindowRateLimiter;
  /** Call count, latency, and outcome. No payloads. */
  metrics?: ToolMetricsSink;
};

export type CallCtx = { userId: string; accessToken: string };
type Out<O extends z.ZodRawShape> = z.infer<z.ZodObject<O>>;
type In<I extends z.ZodRawShape> = z.infer<z.ZodObject<I>>;

export const PREVIEW_TTL_SECONDS = 900;

const registered = new WeakMap<McpServer, string[]>();

/** Record a tool name as registered on this server (registerRead/registerWritePair do this). */
export function markRegistered(server: McpServer, name: string): void {
  const list = registered.get(server) ?? [];
  list.push(name);
  registered.set(server, list);
}

/** Every tool name registered on this server, for the startup registry invariant. */
export function registeredToolNames(server: McpServer): string[] {
  return [...(registered.get(server) ?? [])];
}

export class ToolUserError extends Error {
  constructor(
    readonly code: McpToolError["error"],
    message: string,
  ) {
    super(message);
  }
}

export function toToolError(err: unknown): McpToolError {
  if (err instanceof SignInRequiredError) {
    return { error: "SIGN_IN_REQUIRED", message: err.message, authorizeUrl: err.authorizeUrl };
  }
  if (err instanceof RbacDeniedError) return { error: "PERMISSION_DENIED", message: err.message };
  if (err instanceof ToolUserError) return { error: err.code, message: err.message };
  if (err instanceof NotImplementedError) return { error: "NOT_IMPLEMENTED", message: err.message };
  if (err instanceof WorkdayApiError) {
    const code = err.status === 403 ? "PERMISSION_DENIED" : err.status === 404 ? "NOT_FOUND" : "WORKDAY_FAULT";
    return { error: code, message: `Workday error (${err.fault.code}): ${err.fault.message}`, fault: err.fault };
  }
  if (err instanceof Error && /disabled by WORKDAY_DISABLED_TOOLS/.test(err.message)) {
    return { error: "TOOL_DISABLED", message: err.message };
  }
  if (err instanceof Error && /preview token/i.test(err.message)) {
    return { error: "PREVIEW_INVALID", message: err.message };
  }
  if (err instanceof CommitUncertainError) return { error: "COMMIT_UNCERTAIN", message: err.message };
  if (err instanceof RateLimitError) return { error: "RATE_LIMITED", message: err.message };
  return { error: "INTERNAL", message: err instanceof Error ? err.message : "Unknown error" };
}

const UNPINNED = new Set([
  "SIGN_IN_REQUIRED",
  "PERMISSION_DENIED",
  "CONFIRMATION_REQUIRED",
  "PREVIEW_INVALID",
  "TOOL_DISABLED",
  "RATE_LIMITED",
]);

function metricOutcome(errorCode: string | undefined, ok: boolean): ToolMetricOutcome {
  if (ok) return "ok";
  if (errorCode === "COMMIT_UNCERTAIN") return "unknown";
  if (
    errorCode === "SIGN_IN_REQUIRED" ||
    errorCode === "PERMISSION_DENIED" ||
    errorCode === "RATE_LIMITED" ||
    errorCode === "TOOL_DISABLED"
  )
    return "denied";
  return "error";
}

function recordMetric(
  deps: ToolDeps,
  event: { tool: string; action?: string; outcome: ToolMetricOutcome; latencyMs: number; errorCode?: string },
): void {
  deps.metrics?.record(event);
}

function ok<O extends z.ZodRawShape>(contract: ToolContract<z.ZodRawShape, O>, body: unknown) {
  const parsed = z.object(contract.output).parse(body) as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(parsed, null, 2) }],
    structuredContent: parsed,
  };
}

function fail(e: McpToolError) {
  return { content: [{ type: "text" as const, text: JSON.stringify(e, null, 2) }], isError: true };
}

export async function signIn(deps: ToolDeps, userId: string): Promise<string> {
  await ensureFixtureSession(deps.config, deps.tokenStore, userId);
  // Per-user token only. Missing token => SignInRequiredError, never a shared account.
  return requireUserAccessToken(deps.config, deps.tokenStore, userId, deps.pendingPkce);
}

/**
 * MCP tool annotations, one per tool (not per action).
 * readOnlyHint is false only for commits, which submit. Previews and reads do not submit.
 * destructiveHint is true only for cancel and deny commits.
 * idempotentHint is false for previews, because each call mints a new preview token.
 * Commits are idempotent for a given key. Reads are idempotent.
 * openWorldHint is true when the tool may call Workday, and false for the static catalog.
 */
export const annotationsFor = (c: {
  name: string;
  toolClass: ToolContract<z.ZodRawShape, z.ZodRawShape>["toolClass"];
}) => ({
  readOnlyHint: c.toolClass !== "write-commit",
  destructiveHint: c.toolClass === "write-commit" && registryEntry(c.name)?.destructive === true,
  idempotentHint: c.toolClass !== "write-preview",
  openWorldHint: registryEntry(c.name)?.surface !== "catalog",
});

/** Register a read tool. Handler returns data matching contract.output (validated). */
export function registerRead<I extends z.ZodRawShape, O extends z.ZodRawShape>(
  server: McpServer,
  deps: ToolDeps,
  contract: ToolContract<I, O>,
  handler: (ctx: CallCtx, args: In<I>) => Promise<Out<O>>,
): void {
  const c = contract as unknown as ToolContract<z.ZodRawShape, z.ZodRawShape>;
  markRegistered(server, c.name);
  server.registerTool(
    c.name,
    {
      title: c.title,
      description: c.description,
      inputSchema: c.input,
      outputSchema: c.output,
      annotations: annotationsFor(c),
    },
    async (args: Record<string, unknown>) => {
      const started = Date.now();
      const userId = deps.resolveUserId();
      try {
        deps.rateLimit?.consume(userId, c.name, "read");
        assertToolEnabled(deps.config, c.name);
        assertToolAllowedForUser({
          userId,
          roles: deps.resolveUserRoles(),
          toolName: c.name,
          assignments: deps.assignments,
        });
        const accessToken = await signIn(deps, userId);
        const body = await handler({ userId, accessToken }, args as In<I>);
        const res = ok(c, body);
        await deps.audit.log({
          ts: new Date().toISOString(),
          userId,
          tool: c.name,
          inputs: args,
          result: "ok",
          latencyMs: Date.now() - started,
        });
        recordMetric(deps, { tool: c.name, outcome: "ok", latencyMs: Date.now() - started });
        return res;
      } catch (err) {
        const e = toToolError(err);
        const denied =
          e.error === "SIGN_IN_REQUIRED" ||
          e.error === "PERMISSION_DENIED" ||
          e.error === "RATE_LIMITED" ||
          e.error === "TOOL_DISABLED";
        await deps.audit.log({
          ts: new Date().toISOString(),
          userId,
          tool: c.name,
          inputs: args,
          result: denied ? "denied" : "error",
          latencyMs: Date.now() - started,
          errorMessage: e.message,
        });
        recordMetric(deps, {
          tool: c.name,
          outcome: metricOutcome(e.error, false),
          latencyMs: Date.now() - started,
          errorCode: e.error,
        });
        return fail(e);
      }
    },
  );
}

export type PreviewPlan<W> = { summary: string; willSubmit: W };

/**
 * Register a preview_X + commit_X pair sharing one preview kind.
 * - preview: validates, checks current Workday state, mints a user-bound token. No writes.
 * - commit: requires userConfirmed=true + idempotencyKey; replays stored result on retry;
 *   consumes the token; submits via the business process.
 */
export function registerWritePair<
  PI extends z.ZodRawShape,
  PO extends z.ZodRawShape,
  CI extends z.ZodRawShape,
  CO extends z.ZodRawShape,
  W,
>(
  server: McpServer,
  deps: ToolDeps,
  preview: ToolContract<PI, PO>,
  commit: ToolContract<CI, CO>,
  plan: (ctx: CallCtx, args: In<PI>) => Promise<PreviewPlan<W>>,
  execute: (
    ctx: CallCtx,
    willSubmit: W,
  ) => Promise<{ result: unknown; reusedExisting: boolean; workdayEventId?: string }>,
): void {
  const p = preview as unknown as ToolContract<z.ZodRawShape, z.ZodRawShape>;
  const k = commit as unknown as ToolContract<z.ZodRawShape, z.ZodRawShape>;
  const kind = k.name;

  registerRead(server, deps, p, async (ctx, args) => {
    const { summary, willSubmit } = await plan(ctx, args as In<PI>);
    const previewToken = deps.previewStore.createGeneric(kind, ctx.userId, summary, willSubmit);
    return {
      previewToken,
      expiresInSeconds: PREVIEW_TTL_SECONDS,
      summary,
      willSubmit,
      nextStep: `Show the summary to the user. On explicit confirmation, call ${kind} with this previewToken, userConfirmed=true and a fresh idempotencyKey.`,
    };
  });

  markRegistered(server, k.name);
  server.registerTool(
    k.name,
    {
      title: k.title,
      description: k.description,
      inputSchema: k.input,
      outputSchema: k.output,
      annotations: annotationsFor(k),
    },
    async (raw: Record<string, unknown>) => {
      const args = raw as { previewToken: string; idempotencyKey: string; userConfirmed: boolean };
      const started = Date.now();
      const userId = deps.resolveUserId();
      const auditInputs = { idempotencyKey: args.idempotencyKey };
      try {
        assertToolEnabled(deps.config, k.name);
        assertToolAllowedForUser({
          userId,
          roles: deps.resolveUserRoles(),
          toolName: k.name,
          assignments: deps.assignments,
        });
        if (args.userConfirmed !== true) {
          throw new ToolUserError("CONFIRMATION_REQUIRED", "userConfirmed must be true before committing a write.");
        }
        deps.rateLimit?.consume(userId, k.name, "write");
        const cached = deps.idempotency.get(userId, k.name, args.idempotencyKey);
        if (cached?.status === "unknown") {
          recordMetric(deps, {
            tool: k.name,
            outcome: "unknown",
            latencyMs: Date.now() - started,
            errorCode: "COMMIT_UNCERTAIN",
          });
          return fail({
            error: "COMMIT_UNCERTAIN",
            message: "A previous submit did not confirm. It will not be resubmitted. Reconcile it before retrying.",
          });
        }
        if (cached) {
          await deps.audit.log({
            ts: new Date().toISOString(),
            userId,
            tool: k.name,
            inputs: { ...auditInputs, replay: true },
            result: cached.status === "ok" ? "ok" : "error",
            workdayEventId: cached.workdayEventId,
            latencyMs: Date.now() - started,
          });
          recordMetric(deps, {
            tool: k.name,
            outcome: cached.status === "ok" ? "ok" : "error",
            latencyMs: Date.now() - started,
          });
          return cached.status === "ok"
            ? ok(k, { ...(cached.body as object), replayed: true })
            : fail(cached.body as McpToolError);
        }
        // Sign in first so a SIGN_IN_REQUIRED retry still has its preview token.
        const accessToken = await signIn(deps, userId);
        const payload = deps.previewStore.consumeGeneric<W>(args.previewToken, userId, kind);
        const out = await execute({ userId, accessToken }, payload.data);
        const body = {
          replayed: false,
          submitted: !out.reusedExisting,
          reusedExisting: out.reusedExisting,
          summary: payload.summary,
          result: out.result,
        };
        const res = ok(k, body);
        deps.idempotency.set(userId, k.name, args.idempotencyKey, {
          status: "ok",
          body,
          workdayEventId: out.workdayEventId,
        });
        await deps.audit.log({
          ts: new Date().toISOString(),
          userId,
          tool: k.name,
          inputs: auditInputs,
          result: "ok",
          workdayEventId: out.workdayEventId,
          latencyMs: Date.now() - started,
        });
        recordMetric(deps, { tool: k.name, outcome: "ok", latencyMs: Date.now() - started });
        return res;
      } catch (err) {
        const e = toToolError(err);
        // Do not pin sign-in, permission, confirmation, or rate-limit failures.
        // Pin success elsewhere. Pin definitive failures as error. Pin timeouts,
        // 5xx, and network errors as unknown so a retry reconciles instead of resubmitting.
        if (!UNPINNED.has(e.error)) {
          const state = e.error === "COMMIT_UNCERTAIN" ? "unknown" : classifyCommitFailure(err);
          deps.idempotency.set(userId, k.name, args.idempotencyKey, {
            status: state,
            body: state === "unknown" ? { error: "COMMIT_UNCERTAIN", message: e.message } : e,
          });
        }
        const denied = e.error === "SIGN_IN_REQUIRED" || e.error === "PERMISSION_DENIED" || e.error === "RATE_LIMITED";
        await deps.audit.log({
          ts: new Date().toISOString(),
          userId,
          tool: k.name,
          inputs: auditInputs,
          result: denied ? "denied" : e.error === "COMMIT_UNCERTAIN" ? "unknown" : "error",
          latencyMs: Date.now() - started,
          errorMessage: e.message,
        });
        recordMetric(deps, {
          tool: k.name,
          outcome: metricOutcome(e.error, false),
          latencyMs: Date.now() - started,
          errorCode: e.error,
        });
        return fail(e);
      }
    },
  );
}
