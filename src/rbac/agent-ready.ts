/**
 * RBAC for NATIVE Agent-Ready tools (Layer 1) and the composite recipes over them.
 *
 * Kept separate from TOOL_PERMISSIONS (which must match this server's own registered tools
 * 1:1). These are applied by the agent/skill layer and by any Layer-3 recipe adapter before
 * calling Workday MCP. Coarse pre-filter only — Workday security on the token decides.
 *
 * Scopes:
 *   self             contextInstanceId must be "me" or the caller's own WID
 *   self_and_reports self + direct/indirect reports (manager)
 *   supervisory_org  workers/orgs inside the caller's supported supervisory orgs (hr_partner)
 *   all              any target Workday security lets the caller see (admin)
 */
import type { Role } from "./roles.js";
import { RbacDeniedError } from "./enforce.js";

export type AgentReadyScope = "self" | "self_and_reports" | "supervisory_org" | "all";
export type AgentReadyGrant = Partial<Record<Role, AgentReadyScope>>;

const ALL = (worker: boolean, manager: boolean): AgentReadyGrant => ({
  ...(worker ? { worker_self: "self" as const } : {}),
  ...(manager ? { manager: "self_and_reports" as const } : {}),
  hr_partner: "supervisory_org",
  admin: "all",
  // payroll_viewer: deliberately no grants on worker-data tools (conservative).
});

/** Tool name -> role -> scope. Unlisted tool or role = denied (fail closed). */
export const AGENT_READY_TOOL_PERMISSIONS: Readonly<Record<string, AgentReadyGrant>> = {
  // name resolution / org-wide lookups: not needed for self ("me" suffices)
  find_org_chart_workers: ALL(false, true),
  find_staffing_agent_supervisory_organization_members: ALL(false, true),
  list_organizations: ALL(false, true),
  list_worker_direct_reports: ALL(false, true),
  // worker-context reads: self for workers, team for managers
  find_service_dates_for_worker: ALL(true, true),
  find_staffing_supervisory_organization: ALL(true, true), // worker_self: own org(s) only
  find_staffing_workers: ALL(true, true),
  list_staffing_jobs: ALL(true, true),
  list_worker_email_addresses: ALL(true, true),
  list_worker_organizations: ALL(true, true),
  list_worker_phone_numbers: ALL(true, true),
  // SENSITIVE: worker_self (self) + hr_partner (+ admin). Never manager.
  find_worker_personal_information: ALL(true, false),
  list_worker_addresses: ALL(true, false),
};

/** Recipes: roles = intersection of the tools they call, minus worker_self (chains leave self). */
export const AGENT_READY_RECIPE_PERMISSIONS: Readonly<Record<string, AgentReadyGrant>> = {
  resolve_manager_chain: { manager: "self_and_reports", hr_partner: "supervisory_org", admin: "all" },
  list_indirect_reports: { manager: "self_and_reports", hr_partner: "supervisory_org", admin: "all" },
};

const SCOPE_RANK: Record<AgentReadyScope, number> = { self: 0, self_and_reports: 1, supervisory_org: 2, all: 3 };

export type AgentReadyCallContext = {
  /** Target instance passed to the native tool ("me", a WID, or undefined when the tool has none). */
  contextInstanceId?: string;
  /** Caller's own worker WID, when resolved. */
  callerWid?: string;
  /**
   * Result of the runtime scope check for non-self targets (is the target a report / in the
   * caller's supervisory orgs?). undefined = not checked -> non-self access is denied.
   */
  targetInScope?: boolean;
};

export function grantsFor(name: string): AgentReadyGrant | undefined {
  return AGENT_READY_TOOL_PERMISSIONS[name] ?? AGENT_READY_RECIPE_PERMISSIONS[name];
}

export function isSelfTarget(ctx: AgentReadyCallContext): boolean {
  const id = ctx.contextInstanceId?.trim();
  return id === "me" || (!!id && !!ctx.callerWid && id === ctx.callerWid);
}

/**
 * Returns the widest scope the caller holds for `name`, or throws RbacDeniedError.
 * Enforces: worker_self only on "me"/own WID; non-self targets need targetInScope=true
 * (admin: Workday security decides).
 */
export function assertAgentReadyCallAllowed(
  userRoles: readonly Role[],
  name: string,
  ctx: AgentReadyCallContext = {},
): AgentReadyScope {
  const grant = grantsFor(name) ?? {};
  const allowedRoles = Object.keys(grant) as Role[];
  const held = userRoles
    .map((r) => grant[r])
    .filter((s): s is AgentReadyScope => !!s)
    .sort((a, b) => SCOPE_RANK[b] - SCOPE_RANK[a]);
  const best = held[0];
  if (!best) throw new RbacDeniedError(name, allowedRoles, userRoles);
  if (best === "all" || isSelfTarget(ctx)) return best;
  if (best === "self") {
    throw new RbacDeniedError(name, allowedRoles.filter((r) => grant[r] !== "self"), userRoles);
  }
  if (ctx.targetInScope !== true) {
    throw new RbacDeniedError(name, allowedRoles.filter((r) => grant[r] === "all"), userRoles);
  }
  return best;
}
