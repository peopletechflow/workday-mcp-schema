/**
 * Composite READ-ONLY recipes over tenant-discovered Agent-Ready tools.
 *
 * Workday exposes no dedicated manager-chain or indirect-reports endpoint, so these recipes
 * compose native Basic tools. They are pure traversal logic over an injected adapter: the
 * adapter binds each step to a live Workday MCP call (as the end user / ASU) after the live
 * schema is discovered. Response field shapes are NOT pinned here on purpose, native tools
 * are unversioned, so field extraction lives in the adapter.
 *
 * Not registered as a Layer-3 MCP tool yet (no live adapter); RBAC for each recipe is the
 * intersection of the roles allowed on the tools it calls (see src/rbac/agent-ready.ts).
 */

export const MANAGER_CHAIN_MAX_HOPS = 10;
export const INDIRECT_REPORTS_MAX_DEPTH = 5;
export const DIVERSITY_MIN_GROUP_SIZE = 5;

export type AgentReadyRecipe = {
  name: string;
  description: string;
  readOnly: true;
  /** Native tools invoked, in order. */
  tools: readonly string[];
  steps: readonly string[];
  /** hops/depth: traversal cap; minGroupSize: k-anonymity threshold for aggregate output. */
  cap: { kind: "hops" | "depth" | "minGroupSize"; max: number };
};

export const AGENT_READY_RECIPES = {
  resolve_manager_chain: {
    name: "resolve_manager_chain",
    description:
      "Read-only. Walks a worker's management chain upward: worker -> primarySupervisoryOrganization -> org manager, repeated.",
    readOnly: true,
    tools: ["find_staffing_workers", "find_staffing_supervisory_organization"],
    steps: [
      'find_staffing_workers(contextInstanceId = start WID or "me") -> primarySupervisoryOrganization.',
      "find_staffing_supervisory_organization(org) -> manager.",
      "If the manager is the current worker (worker manages their own org), move to the superior org; the adapter decides how, otherwise stop.",
      "Append manager, repeat from step 1 with the manager as the worker.",
      `Stop on: no org, no manager, a repeated worker (cycle), or ${MANAGER_CHAIN_MAX_HOPS} hops (truncated=true).`,
    ],
    cap: { kind: "hops", max: MANAGER_CHAIN_MAX_HOPS },
  },
  list_indirect_reports: {
    name: "list_indirect_reports",
    description:
      "Read-only. Lists direct + indirect reports by recursing list_worker_direct_reports into reports where hasManagerRole is true.",
    readOnly: true,
    tools: ["list_worker_direct_reports"],
    steps: [
      "list_worker_direct_reports(manager), page through limit/offset until total is reached.",
      "For each report with hasManagerRole=true, recurse with that report as the manager.",
      `Stop at depth ${INDIRECT_REPORTS_MAX_DEPTH} (truncated=true) and never revisit a worker (cycle guard).`,
    ],
    cap: { kind: "depth", max: INDIRECT_REPORTS_MAX_DEPTH },
  },
  aggregate_diversity: {
    name: "aggregate_diversity",
    description:
      "Read-only, AGGREGATE-ONLY. Counts per ethnicity bucket for an org in the caller's verified org scope; " +
      `buckets smaller than ${DIVERSITY_MIN_GROUP_SIZE} are suppressed; never returns per-person ethnicity.`,
    readOnly: true,
    tools: ["list_organization_members", "find_worker_personal_information", "find_ethnicity_details"],
    steps: [
      "Verify the org is in the caller's org scope (hr_partner OrgScope; admin any).",
      "list_organization_members(org) -> member WIDs (paged).",
      "For each member: find_worker_personal_information -> ethnicity (kept in memory only; undisclosed -> 'Not disclosed').",
      `Count per bucket; suppress buckets with count < ${DIVERSITY_MIN_GROUP_SIZE}; hide totals that would let suppressed counts be derived.`,
      "Return counts only: no worker ids, names or per-person values.",
    ],
    cap: { kind: "minGroupSize", max: DIVERSITY_MIN_GROUP_SIZE },
  },
} as const satisfies Record<string, AgentReadyRecipe>;

export type AgentReadyRecipeName = keyof typeof AGENT_READY_RECIPES;

/** Opaque worker/org reference. `id` is a WID (or "me" for the caller at the chain start). */
export type RecipeRef = { id: string; descriptor?: string };

export type ManagerChainAdapter = {
  /** find_staffing_workers(contextInstanceId) -> primarySupervisoryOrganization. */
  getPrimarySupervisoryOrg(worker: RecipeRef): Promise<RecipeRef | null>;
  /** find_staffing_supervisory_organization(org) -> manager. */
  getOrgManager(org: RecipeRef): Promise<RecipeRef | null>;
  /** Optional: superior org when the worker manages their own primary org. */
  getSuperiorOrg?(org: RecipeRef): Promise<RecipeRef | null>;
};

export type ManagerChainResult = { chain: RecipeRef[]; truncated: boolean; stoppedBecause: string };

export async function resolveManagerChain(
  adapter: ManagerChainAdapter,
  start: RecipeRef,
  maxHops: number = MANAGER_CHAIN_MAX_HOPS,
): Promise<ManagerChainResult> {
  const cap = Math.min(Math.max(1, maxHops), MANAGER_CHAIN_MAX_HOPS);
  const chain: RecipeRef[] = [];
  const seen = new Set<string>([start.id]);
  let current = start;
  for (let hop = 0; hop < cap; hop++) {
    let org = await adapter.getPrimarySupervisoryOrg(current);
    if (!org) return { chain, truncated: false, stoppedBecause: "no primarySupervisoryOrganization" };
    let manager = await adapter.getOrgManager(org);
    // A manager's primary org is usually the one they manage: step up to the superior org once.
    if (manager && manager.id === current.id && adapter.getSuperiorOrg) {
      org = await adapter.getSuperiorOrg(org);
      manager = org ? await adapter.getOrgManager(org) : null;
    }
    if (!manager || manager.id === current.id) return { chain, truncated: false, stoppedBecause: "top of chain" };
    if (seen.has(manager.id)) return { chain, truncated: false, stoppedBecause: "cycle detected" };
    seen.add(manager.id);
    chain.push(manager);
    current = manager;
  }
  return { chain, truncated: true, stoppedBecause: `cap of ${cap} hops reached` };
}

export type DirectReport = RecipeRef & { hasManagerRole: boolean };

export type IndirectReportsAdapter = {
  /** list_worker_direct_reports(manager), already paged through limit/offset to total. */
  listDirectReports(manager: RecipeRef): Promise<DirectReport[]>;
};

export type IndirectReport = DirectReport & { depth: number; managerId: string };
export type IndirectReportsResult = { reports: IndirectReport[]; truncated: boolean };

export async function listIndirectReports(
  adapter: IndirectReportsAdapter,
  manager: RecipeRef,
  maxDepth: number = INDIRECT_REPORTS_MAX_DEPTH,
): Promise<IndirectReportsResult> {
  const cap = Math.min(Math.max(1, maxDepth), INDIRECT_REPORTS_MAX_DEPTH);
  const reports: IndirectReport[] = [];
  const seen = new Set<string>([manager.id]);
  let truncated = false;
  const walk = async (m: RecipeRef, depth: number): Promise<void> => {
    for (const r of await adapter.listDirectReports(m)) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      reports.push({ ...r, depth, managerId: m.id });
      if (!r.hasManagerRole) continue;
      if (depth >= cap) truncated = true;
      else await walk(r, depth + 1);
    }
  };
  await walk(manager, 1);
  return { reports, truncated };
}
