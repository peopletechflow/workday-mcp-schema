/**
 * Catalog entrypoint: re-exports the generated seed and helpers.
 * Runtime still calls Workday's MCP endpoint for live schemas; this layer is discovery only.
 */
import { AGENT_READY_CATALOG } from "./catalog.generated.js";
import type { AgentReadyCatalog, AgentReadyToolDefinition } from "./types.js";

export { AGENT_READY_CATALOG };

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
