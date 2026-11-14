/**
 * Outcome-shaped MCP tools. Each tool is one user goal. Actions route to the
 * layer-3 handlers or to a catalog operation row. Catalog names are not called.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AGENT_READY_CATALOG, getAgentReadyTool, listAgentReadyTools } from "../agent-ready/index.js";
import {
  catalogCallReason,
  catalogToolsForOutcome,
  outcomeForCatalogTool,
  type OutcomeId,
} from "../agent-ready/outcome-groups.js";
import type { AgentReadyToolDefinition } from "../agent-ready/types.js";
import { MAX_RECORDS_PER_CALL } from "../schemas/common.js";
import { CompactOperationSchema, OUTCOME_SCHEMAS, OUTCOME_TOOL_CONTRACTS } from "../schemas/tools/outcomes.js";
import { grantsFor } from "../rbac/agent-ready.js";
import { assertToolAllowedForUser, RbacDeniedError } from "../rbac/index.js";
import { assertToolEnabled } from "../config.js";
import { classifyCommitFailure, CommitUncertainError } from "../safety/commit-outcome.js";
import type { TimeOffRequest } from "../schemas/absence.js";
import type { WorkdayId } from "../schemas/common.js";
import {
  PREVIEW_TTL_SECONDS,
  ToolUserError,
  markRegistered,
  signIn,
  toToolError,
  type CallCtx,
  type ToolDeps,
} from "./framework.js";
import { COMMIT_TOOL, commitTimeOffPreview, createTimeOffPreview, type TimeOffPreviewInput } from "./time-off-core.js";

const page = <R>(rows: R[], limit: number, offset: number) => {
  const capped = Math.min(limit, MAX_RECORDS_PER_CALL);
  return { rows: rows.slice(offset, offset + capped), page: { total: rows.length, limit: capped, offset } };
};

function compact(tool: AgentReadyToolDefinition) {
  return CompactOperationSchema.parse({
    name: tool.name,
    readOnly: tool.readOnly !== false,
    description: tool.description.slice(0, 160),
    reason: catalogCallReason(tool),
  });
}

function findOperations(outcome: OutcomeId, search: string | undefined, limit: number) {
  let rows = catalogToolsForOutcome(outcome);
  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter(
      (tool) =>
        tool.name.toLowerCase().includes(q) ||
        tool.description.toLowerCase().includes(q) ||
        (tool.category ?? "").toLowerCase().includes(q),
    );
  }
  return { action: "find_operation" as const, total: rows.length, operations: rows.slice(0, limit).map(compact) };
}

type ActionSpec = {
  permission: string;
  kind: "read" | "write";
  run: (ctx: CallCtx, args: Record<string, unknown>) => Promise<unknown>;
};

/**
 * MCP listTools only publishes Zod object schemas. Fold a discriminated union into one
 * object: `action` is an enum, and every other field is present so the client can see it.
 * The handler still parses the original union, which enforces which fields each action needs.
 */
function mcpInputFromUnion(input: z.ZodType): z.ZodType {
  const options = (input as { options?: Array<{ shape: Record<string, z.ZodType> }> }).options;
  if (!options?.length) return input;
  const actions = options.flatMap((option) => {
    const values = (option.shape.action as { values?: Set<string> } | undefined)?.values;
    return values ? [...values] : [];
  });
  const shape: Record<string, z.ZodType> = {
    action: z.enum(actions as [string, ...string[]]).describe("What to do. The other fields depend on this value."),
  };
  for (const option of options) {
    for (const [key, field] of Object.entries(option.shape)) {
      if (key === "action" || shape[key]) continue;
      shape[key] = field.optional();
    }
  }
  return z.object(shape);
}

const mcpOutput = z.object({
  action: z.string().max(40).describe("Echo of the action that ran."),
});

function registerOutcome(
  server: McpServer,
  deps: ToolDeps,
  name: string,
  title: string,
  description: string,
  input: z.ZodType,
  output: z.ZodType,
  actions: Record<string, ActionSpec>,
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean },
): void {
  markRegistered(server, name);
  server.registerTool(
    name,
    { title, description, inputSchema: mcpInputFromUnion(input), outputSchema: mcpOutput, annotations },
    async (raw: unknown) => {
      const parsedInput = input.safeParse(raw ?? {});
      if (!parsedInput.success) {
        const message = parsedInput.error.issues[0]?.message ?? "Invalid input.";
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "VALIDATION_FAILED", message }) }],
          isError: true as const,
        };
      }
      const args = parsedInput.data as Record<string, unknown>;
      const started = Date.now();
      const userId = deps.resolveUserId();
      const action = typeof args.action === "string" ? args.action : "";
      const spec = actions[action];
      try {
        if (!spec) throw new ToolUserError("VALIDATION_FAILED", "Unknown action.");
        deps.rateLimit?.consume(userId, `${name}:${action}`, spec.kind);
        assertToolEnabled(deps.config, name);
        assertToolEnabled(deps.config, spec.permission);
        assertToolAllowedForUser({
          userId,
          roles: deps.resolveUserRoles(),
          toolName: spec.permission,
          assignments: deps.assignments,
        });
        const accessToken = await signIn(deps, userId);
        const body = output.parse(await spec.run({ userId, accessToken }, args));
        await deps.audit.log({
          ts: new Date().toISOString(),
          userId,
          tool: name,
          inputs: args,
          result: "ok",
          latencyMs: Date.now() - started,
        });
        deps.metrics?.record({ tool: name, action, outcome: "ok", latencyMs: Date.now() - started });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
          structuredContent: body as Record<string, unknown>,
        };
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
          tool: name,
          inputs: args,
          result: e.error === "COMMIT_UNCERTAIN" ? "unknown" : denied ? "denied" : "error",
          latencyMs: Date.now() - started,
          errorMessage: e.message,
        });
        deps.metrics?.record({
          tool: name,
          action,
          outcome: e.error === "COMMIT_UNCERTAIN" ? "unknown" : denied ? "denied" : "error",
          latencyMs: Date.now() - started,
          errorCode: e.error,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(e, null, 2) }], isError: true };
      }
    },
  );
}

async function genericCommit(
  deps: ToolDeps,
  ctx: CallCtx,
  toolName: string,
  args: { previewToken?: string; idempotencyKey?: string; userConfirmed?: boolean },
  execute: (data: {
    requestId: WorkdayId;
    reason?: string | null;
    comment?: string | null;
    request?: TimeOffRequest;
  }) => Promise<{ result: unknown; reusedExisting: boolean; workdayEventId?: string }>,
) {
  if (args.userConfirmed !== true)
    throw new ToolUserError("CONFIRMATION_REQUIRED", "userConfirmed must be true before committing a write.");
  if (!args.previewToken || !args.idempotencyKey)
    throw new ToolUserError("VALIDATION_FAILED", "previewToken and idempotencyKey are required.");
  const cached = deps.idempotency.get(ctx.userId, toolName, args.idempotencyKey);
  if (cached?.status === "unknown") throw new CommitUncertainError();
  if (cached?.status === "ok") return { replayed: true, ...(cached.body as object) };
  if (cached?.status === "error") {
    const body = cached.body as { error?: string; message?: string };
    throw new ToolUserError("WORKDAY_FAULT", body.message ?? body.error ?? "Stored commit failure.");
  }
  const payload = deps.previewStore.consumeGeneric<{
    requestId: WorkdayId;
    reason?: string | null;
    comment?: string | null;
    request?: TimeOffRequest;
  }>(args.previewToken, ctx.userId, toolName);
  try {
    const out = await execute(payload.data);
    const body = {
      replayed: false,
      submitted: !out.reusedExisting,
      reusedExisting: out.reusedExisting,
      summary: payload.summary,
      request: out.result,
    };
    deps.idempotency.set(ctx.userId, toolName, args.idempotencyKey, {
      status: "ok",
      body,
      workdayEventId: out.workdayEventId,
      subject: payload.data,
    });
    return body;
  } catch (err) {
    const state = classifyCommitFailure(err);
    deps.idempotency.set(ctx.userId, toolName, args.idempotencyKey, {
      status: state,
      body: { error: state === "unknown" ? "COMMIT_UNCERTAIN" : err instanceof Error ? err.name : "error" },
      subject: payload.data,
    });
    if (state === "unknown") throw new CommitUncertainError();
    throw err;
  }
}

function roleCanSeeCatalog(roles: readonly string[], toolName: string): boolean {
  const grant = grantsFor(toolName);
  if (!grant) return false;
  return roles.some((role) => role in grant);
}

export function registerOutcomeTools(server: McpServer, deps: ToolDeps): void {
  const domain = deps.domain;
  const schemas = OUTCOME_SCHEMAS;
  const described = Object.fromEntries(OUTCOME_TOOL_CONTRACTS.map((tool) => [tool.name, tool]));

  const timeOff: Record<string, ActionSpec> = {
    balances: {
      permission: "get_my_time_off_balance",
      kind: "read",
      run: async (ctx, args) => ({
        action: "balances",
        balances: await deps.client.getMyTimeOffBalances(ctx.accessToken, args.asOf as string | undefined),
      }),
    },
    history: {
      permission: "list_my_time_off_requests",
      kind: "read",
      run: async (ctx, args) => {
        const rows = await domain.listMyTimeOffRequests(
          ctx.accessToken,
          { from: args.from as string | undefined, to: args.to as string | undefined },
          args.status as never,
        );
        const p = page(rows, Number(args.limit ?? 25), Number(args.offset ?? 0));
        return { action: "history", requests: p.rows, page: p.page };
      },
    },
    team_history: {
      permission: "list_team_time_off_requests",
      kind: "read",
      run: async (ctx, args) => {
        const status = (args.status as never) ?? ["SUBMITTED", "IN_PROGRESS"];
        const rows = await domain.listTeamTimeOffRequests(
          ctx.accessToken,
          { from: args.from as string | undefined, to: args.to as string | undefined },
          status,
        );
        const p = page(rows, Number(args.limit ?? 25), Number(args.offset ?? 0));
        return { action: "team_history", requests: p.rows, page: p.page };
      },
    },
    request_preview: {
      permission: "preview_request_time_off",
      kind: "write",
      run: async (ctx, args) => {
        const preview = await createTimeOffPreview(deps, ctx.userId, args as unknown as TimeOffPreviewInput);
        return {
          action: "request_preview",
          previewToken: preview.previewToken,
          expiresInSeconds: PREVIEW_TTL_SECONDS,
          summary: preview.summary,
          willSubmit: preview.willSubmit,
          nextStep: `Show the summary. On explicit confirmation, call time_off request_commit with this previewToken, userConfirmed true, and a new idempotencyKey.`,
        };
      },
    },
    request_commit: {
      permission: COMMIT_TOOL,
      kind: "write",
      run: async (ctx, args) => {
        if (args.userConfirmed !== true)
          throw new ToolUserError("CONFIRMATION_REQUIRED", "userConfirmed must be true before committing a write.");
        const outcome = await commitTimeOffPreview(
          deps,
          ctx.userId,
          String(args.previewToken),
          String(args.idempotencyKey),
        );
        if (outcome.replayed && outcome.status === "error") {
          throw new ToolUserError(
            "WORKDAY_FAULT",
            "Stored commit failure. Use a new idempotency key after fixing the request.",
          );
        }
        const body = outcome.body as { submitted: boolean; reusedExisting: boolean; request: unknown; summary: string };
        return {
          action: "request_commit",
          replayed: outcome.replayed,
          submitted: body.submitted,
          reusedExisting: body.reusedExisting,
          summary: body.summary,
          request: body.request,
        };
      },
    },
    cancel_preview: {
      permission: "preview_cancel_time_off",
      kind: "write",
      run: async (ctx, args) => {
        const requestId = args.requestId as WorkdayId;
        const req = await domain.getTimeOffRequest(ctx.accessToken, requestId);
        if (!req || req.worker)
          throw new ToolUserError("NOT_FOUND", "Time-off request not found among your own requests.");
        if (req.status === "CANCELED" || req.status === "DENIED")
          throw new ToolUserError("VALIDATION_FAILED", `Request is already ${req.status}.`);
        const summary = `Cancel time off ${req.startDate}..${req.endDate} (${req.quantity} ${req.unit.toLowerCase()}, currently ${req.status})`;
        const willSubmit = {
          requestId,
          startDate: req.startDate,
          endDate: req.endDate,
          currentStatus: req.status,
          reason: (args.reason as string | undefined) ?? null,
        };
        const previewToken = deps.previewStore.createGeneric("commit_cancel_time_off", ctx.userId, summary, willSubmit);
        return {
          action: "cancel_preview",
          previewToken,
          expiresInSeconds: PREVIEW_TTL_SECONDS,
          summary,
          willSubmit,
          nextStep: "On confirmation, call time_off cancel_commit with this previewToken.",
        };
      },
    },
    cancel_commit: {
      permission: "commit_cancel_time_off",
      kind: "write",
      run: async (ctx, args) => {
        const body = await genericCommit(deps, ctx, "commit_cancel_time_off", args, async (data) => {
          const current = await domain.getTimeOffRequest(ctx.accessToken, data.requestId);
          if (current?.status === "CANCELED")
            return { result: current, reusedExisting: true, workdayEventId: current.requestId.value };
          const updated = await domain.cancelTimeOffRequest(ctx.accessToken, data.requestId, data.reason ?? undefined);
          return { result: updated, reusedExisting: false, workdayEventId: updated.requestId.value };
        });
        return { action: "cancel_commit", ...body };
      },
    },
    approve_preview: {
      permission: "preview_approve_time_off",
      kind: "write",
      run: (ctx, args) => decisionPreview(deps, ctx, "APPROVE", args),
    },
    approve_commit: {
      permission: "commit_approve_time_off",
      kind: "write",
      run: (ctx, args) => decisionCommit(deps, ctx, "APPROVE", args),
    },
    deny_preview: {
      permission: "preview_deny_time_off",
      kind: "write",
      run: (ctx, args) => decisionPreview(deps, ctx, "DENY", args),
    },
    deny_commit: {
      permission: "commit_deny_time_off",
      kind: "write",
      run: (ctx, args) => decisionCommit(deps, ctx, "DENY", args),
    },
    find_operation: {
      permission: "list_agent_ready_tools",
      kind: "read",
      run: async (_ctx, args) =>
        findOperations("time_off", args.search as string | undefined, Number(args.limit ?? 10)),
    },
  };

  registerOutcome(
    server,
    deps,
    "time_off",
    described.time_off!.title,
    described.time_off!.description,
    schemas.time_off.input,
    schemas.time_off.output,
    timeOff,
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  );

  registerOutcome(
    server,
    deps,
    "worker",
    described.worker!.title,
    described.worker!.description,
    schemas.worker.input,
    schemas.worker.output,
    {
      profile: {
        permission: "get_my_worker_profile",
        kind: "read",
        run: async (ctx) => ({ action: "profile", worker: await domain.getMyWorker(ctx.accessToken) }),
      },
      find_operation: {
        permission: "list_agent_ready_tools",
        kind: "read",
        run: async (_ctx, args) =>
          findOperations("worker", args.search as string | undefined, Number(args.limit ?? 10)),
      },
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  );

  registerOutcome(
    server,
    deps,
    "organization",
    described.organization!.title,
    described.organization!.description,
    schemas.organization.input,
    schemas.organization.output,
    {
      my_team: {
        permission: "list_my_team",
        kind: "read",
        run: async (ctx, args) => {
          const p = page(
            await domain.listMyTeam(ctx.accessToken, Boolean(args.includeInactive)),
            Number(args.limit ?? 25),
            Number(args.offset ?? 0),
          );
          return { action: "my_team", members: p.rows, page: p.page };
        },
      },
      supervisory_org: {
        permission: "get_supervisory_org",
        kind: "read",
        run: async (ctx, args) => {
          const org = await domain.getSupervisoryOrg(ctx.accessToken, args.orgId as WorkdayId);
          if (!org) throw new ToolUserError("NOT_FOUND", "Supervisory org not found or not visible to you.");
          return { action: "supervisory_org", org };
        },
      },
      find_operation: {
        permission: "list_agent_ready_tools",
        kind: "read",
        run: async (_ctx, args) =>
          findOperations("organization", args.search as string | undefined, Number(args.limit ?? 10)),
      },
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  );

  registerOutcome(
    server,
    deps,
    "benefits",
    described.benefits!.title,
    described.benefits!.description,
    schemas.benefits.input,
    schemas.benefits.output,
    {
      enrollments: {
        permission: "get_my_benefits_enrollments",
        kind: "read",
        run: async (ctx, args) => ({
          action: "enrollments",
          enrollments: await domain.getMyBenefitEnrollments(ctx.accessToken, args.asOf as string | undefined),
        }),
      },
      find_operation: {
        permission: "list_agent_ready_tools",
        kind: "read",
        run: async (_ctx, args) =>
          findOperations("benefits", args.search as string | undefined, Number(args.limit ?? 10)),
      },
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  );

  registerOutcome(
    server,
    deps,
    "pay",
    described.pay!.title,
    described.pay!.description,
    schemas.pay.input,
    schemas.pay.output,
    {
      statements: {
        permission: "list_my_pay_statements",
        kind: "read",
        run: async (ctx, args) => {
          const p = page(
            await domain.listMyPayStatements(ctx.accessToken, {
              from: args.from as string | undefined,
              to: args.to as string | undefined,
            }),
            Number(args.limit ?? 25),
            Number(args.offset ?? 0),
          );
          return { action: "statements", statements: p.rows, page: p.page };
        },
      },
      find_operation: {
        permission: "list_agent_ready_tools",
        kind: "read",
        run: async (_ctx, args) => findOperations("pay", args.search as string | undefined, Number(args.limit ?? 10)),
      },
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  );

  for (const outcome of [
    "job",
    "compensation",
    "talent",
    "recruiting",
    "personal_data",
    "expenses",
    "business_process",
  ] as const) {
    const contract = described[outcome]!;
    registerOutcome(
      server,
      deps,
      outcome,
      contract.title,
      contract.description,
      schemas[outcome].input,
      schemas[outcome].output,
      {
        find_operation: {
          permission: "list_agent_ready_tools",
          kind: "read",
          run: async (_ctx, args) =>
            findOperations(outcome, args.search as string | undefined, Number(args.limit ?? 10)),
        },
      },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    );
  }

  registerOutcome(
    server,
    deps,
    "catalog",
    described.catalog!.title,
    described.catalog!.description,
    schemas.catalog.input,
    schemas.catalog.output,
    {
      search: {
        permission: "list_agent_ready_tools",
        kind: "read",
        run: async (_ctx, args) => {
          const outcome = args.outcome as OutcomeId | undefined;
          let rows = outcome ? catalogToolsForOutcome(outcome) : [...listAgentReadyTools({})];
          const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
          if (query)
            rows = rows.filter(
              (tool) => tool.name.toLowerCase().includes(query) || tool.description.toLowerCase().includes(query),
            );
          const limit = Number(args.limit ?? 10);
          return { action: "search", total: rows.length, operations: rows.slice(0, limit).map(compact) };
        },
      },
      get: {
        permission: "get_agent_ready_tool",
        kind: "read",
        run: async (_ctx, args) => {
          const tool = getAgentReadyTool({ name: String(args.name) });
          if (!tool) return { action: "get", found: false };
          return { action: "get", found: true, operation: compact(tool) };
        },
      },
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );

  if (!deps.config.exposeFullCatalog) return;
  for (const tool of AGENT_READY_CATALOG.tools) {
    const outcome = outcomeForCatalogTool(tool);
    markRegistered(server, tool.name);
    server.registerTool(
      tool.name,
      {
        title: tool.name,
        description: `${tool.description.slice(0, 140)} Discovery only. Use ${outcome}.`,
        inputSchema: z.object({ note: z.string().max(80).optional() }),
        outputSchema: z.object({
          name: z.string(),
          outcome: z.string(),
          executed: z.literal(false),
          reason: z.string(),
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () => {
        const userId = deps.resolveUserId();
        try {
          if (!roleCanSeeCatalog(deps.resolveUserRoles(), tool.name)) {
            throw new RbacDeniedError(tool.name, [], deps.resolveUserRoles());
          }
          const body = { name: tool.name, outcome, executed: false as const, reason: catalogCallReason(tool) };
          deps.metrics?.record({ tool: tool.name, outcome: "ok", latencyMs: 0 });
          await deps.audit.log({
            ts: new Date().toISOString(),
            userId,
            tool: tool.name,
            inputs: {},
            result: "ok",
            latencyMs: 0,
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(body) }], structuredContent: body };
        } catch (err) {
          const e = toToolError(err);
          deps.metrics?.record({ tool: tool.name, outcome: "denied", latencyMs: 0, errorCode: e.error });
          return { content: [{ type: "text" as const, text: JSON.stringify(e) }], isError: true as const };
        }
      },
    );
  }
}

async function decisionPreview(
  deps: ToolDeps,
  ctx: CallCtx,
  action: "APPROVE" | "DENY",
  args: Record<string, unknown>,
) {
  const requestId = args.requestId as WorkdayId;
  const req = await deps.domain.getTimeOffRequest(ctx.accessToken, requestId);
  if (!req || !req.worker) throw new ToolUserError("NOT_FOUND", "Request not found in your team approval inbox.");
  if (req.status !== "SUBMITTED" && req.status !== "IN_PROGRESS") {
    throw new ToolUserError("VALIDATION_FAILED", `Request is ${req.status}; nothing to ${action.toLowerCase()}.`);
  }
  const summary = `${action === "APPROVE" ? "Approve" : "Deny"} ${req.worker.descriptor}'s time off ${req.startDate}..${req.endDate} (${req.quantity} ${req.unit.toLowerCase()})`;
  const willSubmit = { action, request: req, comment: (args.comment as string | undefined) ?? null };
  const toolName = action === "APPROVE" ? "commit_approve_time_off" : "commit_deny_time_off";
  const previewToken = deps.previewStore.createGeneric(toolName, ctx.userId, summary, willSubmit);
  return {
    action: action === "APPROVE" ? "approve_preview" : "deny_preview",
    previewToken,
    expiresInSeconds: PREVIEW_TTL_SECONDS,
    summary,
    willSubmit,
    nextStep: `On confirmation, call time_off ${action === "APPROVE" ? "approve_commit" : "deny_commit"} with this previewToken.`,
  };
}

async function decisionCommit(deps: ToolDeps, ctx: CallCtx, action: "APPROVE" | "DENY", args: Record<string, unknown>) {
  const toolName = action === "APPROVE" ? "commit_approve_time_off" : "commit_deny_time_off";
  const target = action === "APPROVE" ? "APPROVED" : "DENIED";
  const body = await genericCommit(deps, ctx, toolName, args, async (data) => {
    const stored = data.request;
    if (!stored) throw new ToolUserError("VALIDATION_FAILED", "Preview is missing the request.");
    const current = await deps.domain.getTimeOffRequest(ctx.accessToken, stored.requestId);
    if (current?.status === target)
      return { result: current, reusedExisting: true, workdayEventId: current.requestId.value };
    const updated = await deps.domain.decideTimeOffRequest(
      ctx.accessToken,
      stored.requestId,
      action,
      data.comment ?? undefined,
    );
    return { result: updated, reusedExisting: false, workdayEventId: updated.requestId.value };
  });
  return { action: action === "APPROVE" ? "approve_commit" : "deny_commit", ...body };
}
