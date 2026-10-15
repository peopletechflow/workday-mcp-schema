/**
 * GENERATED / MAINTAINED SEED — do not hand-edit large diffs.
 * Regenerate with: npx tsx scripts/sync-agent-ready-catalog.ts --csv <path> [--asor <path>]
 * or merge ASOR JSON dumps the same way.
 *
 * Seeded from public Workday developer docs only. Workday reports 400+ Agent-Ready
 * tools; this file holds every *publicly named* tool found without tenant credentials.
 * Refresh via MCP Explorer CSV export and/or ASOR Agent Resource Search dumps.
 */
import type { AgentReadyCatalog } from "./types.js";

export const AGENT_READY_CATALOG: AgentReadyCatalog = {
  meta: {
    generatedAt: "2026-10-15T18:10:00.000Z",
    completenessNote:
      "Seeded from public Workday developer documentation only (not a full Explorer dump). " +
      "Workday marketing cites 400+ generally available Agent-Ready tools spanning Core HR, " +
      "Financials, Workforce Management, Talent & Learning, Payroll, Recruiting, and Student. " +
      "Refresh this catalog with scripts/sync-agent-ready-catalog.ts + an MCP Explorer CSV " +
      "and/or ASOR JSON dump from a tenant with Setup: Agents.",
    sources: [
      "https://developer.workday.com/documentation/GUID-f86470b2-4283-48e6-8d7e-18c91c470878-enHYPHENus (Discover Available Agent-Ready MCP Tools)",
      "https://developer.workday.com/documentation/GUID-bd1ec8d8-7bcf-40d9-a58a-aa805282ebe7-enHYPHENus (Agent-Ready MCP Prompt Tools)",
      "https://developer.workday.com/documentation/GUID-949559e7-10c3-438a-abb2-e452c23d9da8-enHYPHENus (Agent-Ready MCP Tools overview)",
      "https://www.workday.com/en-us/ai-platform/agent-tools-mcp.html (product areas)",
      "https://blog.workday.com/en-us/custom-agents.html (400+ tools claim)",
    ],
    toolCount: 6,
  },
  tools: [
    {
      name: "getTimeOffEntries",
      wid: "386c0e439ecd100039e864720d570000",
      kind: "basic",
      operationType: "VIEW",
      productArea: "Workforce / Absence",
      description: "Returns time off entries for a worker.",
      source: "docs:Discover Available Agent-Ready MCP Tools (ASOR sample response)",
    },
    {
      name: "create_worker_preferred_name_change",
      wid: "dd10e7dabfee100013dff596533e0000",
      kind: "advanced",
      operationType: "CREATE",
      productArea: "Workforce / Personal Data",
      description: "Create Worker Preferred Name Change MCP — submits a preferred name change for a worker.",
      requiredPromptTools: [
        "list_hereditary_name_suffixes",
        "list_name_salutations",
        "list_social_name_suffixes",
        "list_name_titles",
      ],
      source: "docs:Agent-Ready MCP Prompt Tools (sample agent definition)",
    },
    {
      name: "list_hereditary_name_suffixes",
      wid: "48baf000b54310001fd487976aba0000",
      kind: "prompt",
      operationType: "VIEW",
      productArea: "Workforce / Personal Data",
      description: "List Hereditary Name Suffixes Prompt — supplies valid hereditary suffix WIDs for preferred name change.",
      source: "docs:Agent-Ready MCP Prompt Tools",
    },
    {
      name: "list_name_salutations",
      wid: "48baf000b54310001fd69cbc09a00000",
      kind: "prompt",
      operationType: "VIEW",
      productArea: "Workforce / Personal Data",
      description: "List Name Salutation — supplies valid salutation WIDs for preferred name change.",
      source: "docs:Agent-Ready MCP Prompt Tools",
    },
    {
      name: "list_social_name_suffixes",
      wid: "48baf000b54310001fd3992952fc0000",
      kind: "prompt",
      operationType: "VIEW",
      productArea: "Workforce / Personal Data",
      description: "List Social Name Suffixes Prompt — supplies valid social suffix WIDs for preferred name change.",
      source: "docs:Agent-Ready MCP Prompt Tools",
    },
    {
      name: "list_name_titles",
      wid: "48baf000b54310001fd544eae4810000",
      kind: "prompt",
      operationType: "VIEW",
      productArea: "Workforce / Personal Data",
      description: "List Name Titles — supplies valid title WIDs for preferred name change.",
      source: "docs:Agent-Ready MCP Prompt Tools",
    },
  ],
};
