import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as T from "../schemas/tools/index.js";
import {
  AGENT_READY_CATALOG,
  NATIVE_TOOL_DISCLAIMER,
  getAgentReadyTool as lookup,
  listAgentReadyTools,
  listProductAreas,
} from "../agent-ready/index.js";
import type { AgentReadyToolDefinition } from "../agent-ready/types.js";
import type { ToolDeps } from "./framework.js";
import { registerRead, ToolUserError } from "./framework.js";

function toSummary(t: AgentReadyToolDefinition) {
  return {
    name: t.name,
    ...(t.wid !== undefined ? { wid: t.wid } : {}),
    kind: t.kind,
    ...(t.operationType ? { operationType: t.operationType } : {}),
    ...(t.productArea ? { productArea: t.productArea } : {}),
    ...(t.category ? { category: t.category } : {}),
    description: t.description,
    ...(t.readOnly !== undefined ? { readOnly: t.readOnly } : {}),
    ...(t.params ? { params: t.params } : {}),
    ...(t.inputSchemaStatus ? { inputSchemaStatus: t.inputSchemaStatus } : {}),
    ...(t.securityDomains ? { securityDomains: t.securityDomains } : {}),
    ...(t.notes ? { notes: t.notes } : {}),
    ...(t.sensitive ? { sensitive: true } : {}),
    ...(t.skills ? { skills: [...t.skills] } : {}),
    ...(t.businessProcess ? { businessProcess: t.businessProcess } : {}),
    ...(t.requiredPromptTools ? { requiredPromptTools: t.requiredPromptTools } : {}),
    ...(t.source ? { source: t.source } : {}),
    nativeWorkdayTool: true as const,
  };
}

/**
 * Meta discovery tools + MCP resource for the Agent-Ready catalog.
 * Does not register passthrough call_* tools.
 */
export function registerAgentReadyCatalog(server: McpServer, deps: ToolDeps): void {
  registerRead(server, deps, T.listAgentReadyTools, async (_ctx, args) => {
    const matching = listAgentReadyTools({
      search: args.search,
      kind: args.kind,
      productArea: args.productArea,
      operationType: args.operationType,
    });
    const slice = matching.slice(args.offset, args.offset + args.limit);
    return {
      disclaimer: NATIVE_TOOL_DISCLAIMER,
      completenessNote: AGENT_READY_CATALOG.meta.completenessNote,
      generatedAt: AGENT_READY_CATALOG.meta.generatedAt,
      totalMatching: matching.length,
      tools: slice.map(toSummary),
      productAreas: listProductAreas(),
    };
  });

  registerRead(server, deps, T.getAgentReadyTool, async (_ctx, args) => {
    if (!args.name && !args.wid) {
      throw new ToolUserError("VALIDATION_FAILED", "Provide name and/or wid.");
    }
    const tool = lookup({ name: args.name, wid: args.wid });
    return {
      disclaimer: NATIVE_TOOL_DISCLAIMER,
      found: Boolean(tool),
      ...(tool ? { tool: toSummary(tool) } : {}),
    };
  });

  server.registerResource(
    "agent-ready-catalog",
    "agent-ready://catalog",
    {
      title: "Workday Agent-Ready MCP tools catalog",
      description:
        "Local seed/sync catalog of native Workday Agent-Ready MCP tools (Basic/Advanced/Prompt). " +
        "Not a live Workday MCP listing. Refresh via scripts/sync-agent-ready-catalog.ts.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              disclaimer: NATIVE_TOOL_DISCLAIMER,
              ...AGENT_READY_CATALOG,
            },
            null,
            2,
          ),
        },
      ],
    }),
  );
}
