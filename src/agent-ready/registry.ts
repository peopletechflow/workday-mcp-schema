import { AGENT_READY_CATALOG } from "./catalog.js";
import type {
  AgentReadyKind,
  AgentReadyListFilter,
  AgentReadyOperationType,
  AgentReadyToolDefinition,
} from "./types.js";

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Exact name match (case-sensitive, as Workday exposes it). */
export function getByName(name: string): AgentReadyToolDefinition | undefined {
  return AGENT_READY_CATALOG.tools.find((t) => t.name === name);
}

/** Case-insensitive name lookup (useful when casing drifts across docs). */
export function getByNameIgnoreCase(name: string): AgentReadyToolDefinition | undefined {
  const n = norm(name);
  return AGENT_READY_CATALOG.tools.find((t) => norm(t.name) === n);
}

export function getByWid(wid: string): AgentReadyToolDefinition | undefined {
  const w = wid.trim();
  if (!w) return undefined;
  return AGENT_READY_CATALOG.tools.find((t) => t.wid === w);
}

export function listByKind(kind: AgentReadyKind): AgentReadyToolDefinition[] {
  return AGENT_READY_CATALOG.tools.filter((t) => t.kind === kind);
}

export function listByProductArea(area: string): AgentReadyToolDefinition[] {
  const a = norm(area);
  return AGENT_READY_CATALOG.tools.filter((t) => t.productArea && norm(t.productArea).includes(a));
}

export function listByOperationType(op: AgentReadyOperationType): AgentReadyToolDefinition[] {
  return AGENT_READY_CATALOG.tools.filter((t) => t.operationType === op);
}

/** Filter/list catalog entries. Empty filter returns all tools. */
export function listAgentReadyTools(filter: AgentReadyListFilter = {}): AgentReadyToolDefinition[] {
  let rows = [...AGENT_READY_CATALOG.tools];
  if (filter.kind) rows = rows.filter((t) => t.kind === filter.kind);
  if (filter.operationType) rows = rows.filter((t) => t.operationType === filter.operationType);
  if (filter.productArea) {
    const a = norm(filter.productArea);
    rows = rows.filter((t) => t.productArea && norm(t.productArea).includes(a));
  }
  if (filter.search) {
    const q = norm(filter.search);
    rows = rows.filter(
      (t) =>
        norm(t.name).includes(q) ||
        norm(t.description).includes(q) ||
        (t.productArea ? norm(t.productArea).includes(q) : false) ||
        (t.category ? norm(t.category).includes(q) : false) ||
        (t.wid ? norm(t.wid).includes(q) : false),
    );
  }
  return rows;
}

export function getAgentReadyTool(opts: {
  name?: string;
  wid?: string;
}): AgentReadyToolDefinition | undefined {
  if (opts.wid) {
    const byWid = getByWid(opts.wid);
    if (byWid) return byWid;
  }
  if (opts.name) {
    return getByName(opts.name) ?? getByNameIgnoreCase(opts.name);
  }
  return undefined;
}

/** Distinct product areas present in the catalog (sorted). */
export function listProductAreas(): string[] {
  const set = new Set<string>();
  for (const t of AGENT_READY_CATALOG.tools) {
    if (t.productArea) set.add(t.productArea);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}
