/**
 * Atomic permission ids for enterprise Layer-3 custom MCP.
 * One permission id per tool name (Layer-3 registered tools + Agent-Ready / recipe tools).
 * Format: `tool:<toolName>`.
 */
import { TOOL_PERMISSIONS } from "./permissions.js";
import { AGENT_READY_RECIPE_PERMISSIONS, AGENT_READY_TOOL_PERMISSIONS } from "./agent-ready.js";

export type PermissionId = `tool:${string}`;

export function permissionIdForTool(toolName: string): PermissionId {
  return `tool:${toolName}`;
}

export function toolNameFromPermissionId(id: string): string | undefined {
  if (!id.startsWith("tool:")) return undefined;
  const name = id.slice("tool:".length).trim();
  return name || undefined;
}

export type PermissionCatalogEntry = {
  permissionId: PermissionId;
  toolName: string;
  /** layer3 = this server's registered tools; agent_ready = native; recipe = composite recipes */
  source: "layer3" | "agent_ready" | "recipe";
};

/** Build the full permission catalog from existing role→tool maps (only mapped tools). */
export function buildPermissionCatalog(): readonly PermissionCatalogEntry[] {
  const out: PermissionCatalogEntry[] = [];
  const seen = new Set<string>();

  const push = (toolName: string, source: PermissionCatalogEntry["source"]) => {
    const permissionId = permissionIdForTool(toolName);
    if (seen.has(permissionId)) return;
    seen.add(permissionId);
    out.push({ permissionId, toolName, source });
  };

  for (const toolName of Object.keys(TOOL_PERMISSIONS)) push(toolName, "layer3");
  for (const toolName of Object.keys(AGENT_READY_TOOL_PERMISSIONS)) push(toolName, "agent_ready");
  for (const toolName of Object.keys(AGENT_READY_RECIPE_PERMISSIONS)) push(toolName, "recipe");

  return out.sort((a, b) => a.permissionId.localeCompare(b.permissionId));
}

/** True when the id is a known mapped tool permission (unknown ids fail closed). */
export function isKnownPermissionId(id: string): boolean {
  const toolName = toolNameFromPermissionId(id);
  if (!toolName) return false;
  return (
    toolName in TOOL_PERMISSIONS ||
    toolName in AGENT_READY_TOOL_PERMISSIONS ||
    toolName in AGENT_READY_RECIPE_PERMISSIONS
  );
}

export function listPermissionIds(): readonly PermissionId[] {
  return buildPermissionCatalog().map((e) => e.permissionId);
}
