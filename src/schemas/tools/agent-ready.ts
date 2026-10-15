import { z } from "zod";
import { defineTool } from "./contract.js";

const KindEnum = z.enum(["basic", "advanced", "prompt"]);
const OpEnum = z.enum(["CREATE", "PATCH", "VIEW"]);

const CatalogToolSummary = z.object({
  name: z.string(),
  wid: z.string().optional(),
  kind: KindEnum,
  operationType: OpEnum.optional(),
  productArea: z.string().optional(),
  description: z.string(),
  requiredPromptTools: z.array(z.string()).optional(),
  source: z.string().optional(),
  /** Always true — these are native Workday tools, not this server's implementations. */
  nativeWorkdayTool: z.literal(true),
});

/**
 * Meta tools that expose the local Agent-Ready catalog for discovery.
 * They do NOT call Workday MCP; Layer-1 runtime still uses Workday's endpoint.
 */
export const listAgentReadyTools = defineTool({
  name: "list_agent_ready_tools",
  title: "List Agent-Ready MCP tools (catalog)",
  description:
    "List native Workday Agent-Ready MCP tools from the local catalog seed " +
    "(Basic / Advanced / Prompt). Filter by product area, kind, or search string. " +
    "This is catalog metadata only — not a live Workday MCP call. " +
    "Refresh via scripts/sync-agent-ready-catalog.ts + Explorer CSV / ASOR dump. " +
    "RBAC: worker_self, manager, hr_partner, admin.",
  toolClass: "read",
  input: {
    search: z.string().optional().describe("Case-insensitive match on name, description, product area, or WID"),
    kind: KindEnum.optional().describe("basic | advanced | prompt"),
    productArea: z.string().optional().describe("Substring match on product area (e.g. Workforce, Financials)"),
    operationType: OpEnum.optional(),
    limit: z.number().int().min(1).max(500).default(100),
    offset: z.number().int().min(0).default(0),
  },
  output: {
    disclaimer: z.string(),
    completenessNote: z.string(),
    generatedAt: z.string(),
    totalMatching: z.number().int().nonnegative(),
    tools: z.array(CatalogToolSummary),
    productAreas: z.array(z.string()),
  },
});

export const getAgentReadyTool = defineTool({
  name: "get_agent_ready_tool",
  title: "Get Agent-Ready MCP tool (catalog)",
  description:
    "Look up one native Workday Agent-Ready MCP tool by exact/case-insensitive name or WID " +
    "from the local catalog. Returns catalog metadata only — does not invoke Workday. " +
    "RBAC: worker_self, manager, hr_partner, admin.",
  toolClass: "read",
  input: {
    name: z.string().optional().describe("Tool name as exposed by Workday MCP"),
    wid: z.string().optional().describe("ASOR agent_resource.id (WID)"),
  },
  output: {
    disclaimer: z.string(),
    found: z.boolean(),
    tool: CatalogToolSummary.optional(),
  },
});
