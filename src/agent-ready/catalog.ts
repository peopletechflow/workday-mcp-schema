/**
 * Catalog entrypoint: merges the generated public-docs seed with tenant-discovered tools.
 * Runtime still calls Workday's MCP endpoint for live schemas; this layer is discovery only.
 */
import { AGENT_READY_CATALOG as GENERATED_CATALOG } from "./catalog.generated.js";
import { TENANT_DISCOVERED_TOOLS, TENANT_DISCOVERY_META } from "./catalog.tenant.js";
import type { AgentReadyCatalog, AgentReadyToolDefinition } from "./types.js";

/**
 * Dedupe by exact name. Generated rows win on WID (authoritative from ASOR/Explorer);
 * tenant rows contribute readOnly/params/category and their provenance is appended.
 */
function mergeCatalog(
  seed: readonly AgentReadyToolDefinition[],
  tenant: readonly AgentReadyToolDefinition[],
): AgentReadyToolDefinition[] {
  const byName = new Map<string, AgentReadyToolDefinition>();
  for (const t of seed) byName.set(t.name, t);
  for (const t of tenant) {
    const prev = byName.get(t.name);
    if (!prev) {
      byName.set(t.name, t);
      continue;
    }
    byName.set(t.name, {
      ...t,
      ...prev,
      wid: prev.wid ?? t.wid,
      readOnly: prev.readOnly ?? t.readOnly,
      params: prev.params ?? t.params,
      inputSchemaStatus: prev.inputSchemaStatus ?? t.inputSchemaStatus,
      category: prev.category ?? t.category,
      source: [prev.source, t.source].filter(Boolean).join("+"),
    });
  }
  return [...byName.values()];
}

const tools = mergeCatalog(GENERATED_CATALOG.tools, TENANT_DISCOVERED_TOOLS);

export const AGENT_READY_CATALOG: AgentReadyCatalog = {
  meta: {
    ...GENERATED_CATALOG.meta,
    completenessNote:
      GENERATED_CATALOG.meta.completenessNote +
      ` Plus ${TENANT_DISCOVERED_TOOLS.length} tools discovered ${TENANT_DISCOVERY_META.discoveredAt} on tenant ` +
      `${TENANT_DISCOVERY_META.tenant} (${TENANT_DISCOVERY_META.release}) via Extend skill ` +
      `${TENANT_DISCOVERY_META.skill}; their WIDs were not exposed (wid: null).`,
    sources: [
      ...GENERATED_CATALOG.meta.sources,
      `tenant:${TENANT_DISCOVERY_META.tenant} Extend app ${TENANT_DISCOVERY_META.extendApp} skill ${TENANT_DISCOVERY_META.skill} (src/agent-ready/catalog.tenant.ts)`,
    ],
    toolCount: tools.length,
  },
  tools,
};

/** Snapshot of the seeded/synced catalog (immutable reference). */
export function getCatalog(): AgentReadyCatalog {
  return AGENT_READY_CATALOG;
}

export function catalogToolCount(): number {
  return AGENT_READY_CATALOG.tools.length;
}

export function allAgentReadyTools(): readonly AgentReadyToolDefinition[] {
  return AGENT_READY_CATALOG.tools;
}

/** Banner text for responses so clients never confuse catalog stubs with live Workday calls. */
export const NATIVE_TOOL_DISCLAIMER =
  "NATIVE WORKDAY AGENT-READY TOOL — documented in this catalog only. " +
  "Not implemented by workday-mcp-schema. Discover live schemas on Workday MCP " +
  "(https://{region}.agent.workday.com/{tenant}/mcp) after ASOR registration. " +
  "Catalog may be incomplete; refresh via scripts/sync-agent-ready-catalog.ts.";
