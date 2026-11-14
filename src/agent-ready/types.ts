/**
 * Catalog types for Workday native Agent-Ready MCP tools.
 * These are NOT implementations, they document tools that live on Workday's MCP endpoint.
 * Names/schemas change without versioning; refresh via scripts/sync-agent-ready-catalog.ts.
 */

/** Basic = read-only; Advanced = write-only; Prompt = read-only WID helpers for Advanced tools. */
export type AgentReadyKind = "basic" | "advanced" | "prompt";

/** ASOR / Explorer operation types when known. */
export type AgentReadyOperationType = "CREATE" | "PATCH" | "VIEW";

export type AgentReadyToolDefinition = {
  /** Exact tool name as exposed by Workday MCP (preserve casing from source). */
  name: string;
  /**
   * ASOR agent_resource.id (WID). Placeholder/unknown when not yet synced.
   * `null` = explicitly unknown (e.g. tenant-discovered tools whose WIDs the UI did not expose).
   * Never invent a WID.
   */
  wid?: string | null | undefined;
  kind: AgentReadyKind;
  operationType?: AgentReadyOperationType | undefined;
  /** Product line / area when known (e.g. Workforce, Financials, Talent). */
  productArea?: string | undefined;
  description: string;
  /** Finer-grained category inside the product area (e.g. "Worker / Contact"). */
  category?: string | undefined;
  /** True when the tool is known to be read-only (Basic/Prompt, or a read-only Extend skill). */
  readOnly?: boolean | undefined;
  /**
   * Input parameters known from discovery notes. Only parameters actually observed are listed;
   * anything else is passed through to Workday MCP unvalidated (see `inputSchemaStatus`).
   */
  params?: AgentReadyParam[] | undefined;
  /**
   * "partial" = some params known, the rest pass through; "unknown" = no params captured,
   * discover the live schema on Workday MCP before calling.
   */
  inputSchemaStatus?: "partial" | "unknown" | undefined;
  /** Workday security domain(s) the tool needs, when stated by the discovery source. */
  securityDomains?: string[] | undefined;
  /** Exposes sensitive personal / pay / dependent data (stricter RBAC, see src/rbac/agent-ready.ts). */
  sensitive?: boolean | undefined;
  /**
   * Special-category / highly sensitive PII (GDPR Art. 9 data such as ethnicity; passport, visa,
   * national and government IDs). Implies `sensitive`. Never returned per person to roles other
   * than self / hr_partner / admin; diversity is aggregate-only (src/safety/diversity.ts).
   */
  specialCategory?: boolean | undefined;
  /** Extend skills that use this tool (tenant-discovered rows). */
  skills?: readonly string[] | undefined;
  /**
   * Write tools only: the staged business-process flow and step this tool performs
   * (open event -> stage -> submit). Executed only via src/safety/native-write-guard.ts.
   */
  businessProcess?: { flow: string; step: "open" | "stage" | "submit" } | undefined;
  /** Free-form discovery notes (pagination, response fields seen, etc.). */
  notes?: string | undefined;
  /** Prompt tool names required by an Advanced write tool. */
  requiredPromptTools?: string[] | undefined;
  /**
   * Provenance for this seed/sync row.
   * e.g. "docs:Discover Available Agent-Ready MCP Tools"
   */
  source?: string | undefined;
};

/** A parameter observed during discovery. Type is a human description, not a JSON Schema. */
export type AgentReadyParam = {
  name: string;
  /** e.g. 'WID | "me"', 'string', 'integer'. */
  type: string;
  description: string;
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
