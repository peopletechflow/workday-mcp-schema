/**
 * Enterprise ToolLoopAgent for Layer-3 custom MCP.
 *
 * Wraps in-process Layer-3 tools as AI SDK `tool()` entries (stdio server today;
 * when an HTTP MCP transport exists, callers may instead use `@ai-sdk/mcp`
 * `createMCPClient`). Every tool execute path must call `assertToolAllowedForUser`
 * before any Workday work. Writes still need preview → confirm (no auto-commit).
 */
import { ToolLoopAgent, stepCountIs, tool, type Tool } from "ai";
import { z } from "zod";
import type { Role } from "../rbac/index.js";
import type { AssignmentStore } from "../rbac/index.js";
import { assertToolAllowedForUser, permissionIdForTool } from "../rbac/index.js";
import { TOOL_REGISTRY, contractFor } from "../tools/registry.js";
import { createEnterpriseModel, loadEnterpriseAiConfig, AiDisabledError } from "./client.js";
import { AI_POLICY } from "./policy.js";

export type EnterpriseAgentSession = {
  userId: string;
  roles: readonly Role[];
  assignments?: AssignmentStore;
  /** When false, write-commit tools refuse even if the model asks. Default false. */
  allowWriteCommits?: boolean;
};

export type Layer3ToolInvoker = (
  toolName: string,
  args: Record<string, unknown>,
  session: EnterpriseAgentSession,
) => Promise<unknown>;

export type EnterpriseAgentOptions = {
  session: EnterpriseAgentSession;
  /** Invoke a registered Layer-3 tool after RBAC (fixtures or live domain). */
  invokeTool: Layer3ToolInvoker;
  /** Limit which registry tools are exposed to the model. Default: all reads + write-previews. */
  includeToolNames?: readonly string[];
  instructions?: string;
  env?: NodeJS.ProcessEnv;
};

/** Upper bound on model turns per request (docs/CONTEXT-ENGINEERING.md). */
export const MAX_ENTERPRISE_AGENT_STEPS = 10;

const DEFAULT_INSTRUCTIONS = `<background>
You are the PeopleTechFlow enterprise Workday assistant, acting for one signed-in user. Tools were chosen from that user's permissions; Workday security on their own token stays authoritative.
</background>

<rules>
1. Use only the provided tools. A missing tool means the action is not allowed; say so.
2. Never invent worker ids or act for another user. Identity comes from the server.
3. Writes are two steps: call the preview_* tool, show its summary to the human, and call the matching commit_* tool only after the human confirms, with userConfirmed true, the preview token, and a fresh idempotency key. Never commit without that confirmation.
</rules>

<tool_guidance>
Read first when the answer depends on current data. Use the narrowest input that answers the question. Do not repeat a call with the same input.
</tool_guidance>

<output>
Plain language, a few sentences, quoting the values you relied on. For a preview, show the summary and ask for confirmation. For a commit, report the result id.
</output>`;

/**
 * Build AI SDK tools from the Layer-3 registry. Each execute:
 * 1. assertToolAllowedForUser (deny/grant/role)
 * 2. refuse write-commit unless session.allowWriteCommits
 * 3. invokeTool
 */
export function buildLayer3AiTools(
  session: EnterpriseAgentSession,
  invokeTool: Layer3ToolInvoker,
  includeToolNames?: readonly string[],
): Record<string, Tool> {
  const allow = new Set(includeToolNames ?? TOOL_REGISTRY.map((t) => t.name));
  const tools: Record<string, Tool> = {};

  for (const entry of TOOL_REGISTRY) {
    if (!allow.has(entry.name)) continue;
    const toolName = entry.name;
    const isCommit = entry.toolClass === "write-commit";

    // Description and parameters come from the schema-first contract so the model sees what a
    // caller would (what it does, who may use it, every input). buildReason is internal rationale.
    const contract = contractFor(toolName);
    const inputSchema: z.ZodType<Record<string, unknown>> = contract ? z.object(contract.input).strict() : z.record(z.string(), z.unknown());
    tools[toolName] = tool({
      description: `${contract?.description ?? entry.buildReason} [${entry.toolClass}; permission ${permissionIdForTool(toolName)}]`,
      // Args are validated again by each tool's Zod contract inside invokeTool / framework.
      inputSchema,
      execute: async (args: Record<string, unknown>) => {
        assertToolAllowedForUser({
          userId: session.userId,
          roles: session.roles,
          toolName,
          assignments: session.assignments,
        });
        if (isCommit && !session.allowWriteCommits) {
          return {
            error: "CONFIRMATION_REQUIRED",
            message:
              "Write commits are blocked until allowWriteCommits is true after an explicit human confirmation. " +
              "Call the matching preview tool first.",
            policy: AI_POLICY,
          };
        }
        if (isCommit && args.userConfirmed !== true) {
          return {
            error: "CONFIRMATION_REQUIRED",
            message: "userConfirmed must be true before committing a write.",
          };
        }
        return invokeTool(toolName, args, session);
      },
    });
  }

  return tools;
}

/**
 * Construct a ToolLoopAgent bound to the session user, roles, and assignment store.
 * Throws AiDisabledError when AI is offline (no key / WORKDAY_AI_DISABLED).
 */
export function createEnterpriseAgent(options: EnterpriseAgentOptions): ToolLoopAgent {
  const env = options.env ?? process.env;
  const cfg = loadEnterpriseAiConfig(env);
  if (cfg.disabled) {
    throw new AiDisabledError(
      "createEnterpriseAgent requires AI_GATEWAY_API_KEY and WORKDAY_AI_DISABLED unset/false.",
    );
  }

  const session: EnterpriseAgentSession = {
    ...options.session,
    allowWriteCommits: options.session.allowWriteCommits === true,
  };
  const tools = buildLayer3AiTools(session, options.invokeTool, options.includeToolNames);

  return new ToolLoopAgent({
    model: createEnterpriseModel(env),
    instructions: options.instructions ?? DEFAULT_INSTRUCTIONS,
    tools,
    stopWhen: stepCountIs(MAX_ENTERPRISE_AGENT_STEPS),
    runtimeContext: {
      userId: session.userId,
      roles: [...session.roles],
      allowWriteCommits: session.allowWriteCommits,
      policy: AI_POLICY,
    },
  });
}
