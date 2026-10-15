/**
 * Catalog types for Workday native Agent-Ready MCP tools.
 * These are NOT implementations — they document tools that live on Workday's MCP endpoint.
 * Names/schemas change without versioning; refresh via scripts/sync-agent-ready-catalog.ts.
 */

/** Basic = read-only; Advanced = write-only; Prompt = read-only WID helpers for Advanced tools. */
export type AgentReadyKind = "basic" | "advanced" | "prompt";

/** ASOR / Explorer operation types when known. */
export type AgentReadyOperationType = "CREATE" | "PATCH" | "VIEW";

export type AgentReadyToolDefinition = {
  /** Exact tool name as exposed by Workday MCP (preserve casing from source). */
  name: string;
  /** ASOR agent_resource.id (WID). Placeholder/unknown when not yet synced. */
  wid?: string;
  kind: AgentReadyKind;
  operationType?: AgentReadyOperationType;
  /** Product line / area when known (e.g. Workforce, Financials, Talent). */
  productArea?: string;
  description: string;
  /** Prompt tool names required by an Advanced write tool. */
  requiredPromptTools?: string[];
  /**
   * Provenance for this seed/sync row.
   * e.g. "docs:Discover Available Agent-Ready MCP Tools"
   */
  source?: string;
};

export type AgentReadyCatalogMeta = {
  /** ISO date of last generation/sync. */
  generatedAt: string;
  /** Human note about completeness. */
  completenessNote: string;
  /** Upstream sources consulted for this catalog snapshot. */
  sources: string[];
  toolCount: number;
};

export type AgentReadyCatalog = {
  meta: AgentReadyCatalogMeta;
  tools: AgentReadyToolDefinition[];
};

export type AgentReadyListFilter = {
  /** Substring match on name, description, or productArea (case-insensitive). */
  search?: string;
  kind?: AgentReadyKind;
  productArea?: string;
  operationType?: AgentReadyOperationType;
};
