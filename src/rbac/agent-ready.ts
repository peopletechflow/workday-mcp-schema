/**
 * RBAC for NATIVE Agent-Ready tools (Layer 1) and the composite recipes over them.
 *
 * Kept separate from TOOL_PERMISSIONS (which must match this server's own registered tools
 * 1:1). Applied by the agent/skill layer and by Layer-3 adapters before calling Workday MCP.
 * Coarse pre-filter only — Workday security on the token decides.
 *
 * Scopes:
 *   self             target must be "me" or the caller's own WID
 *   self_and_reports self + direct/indirect reports (manager)
 *   supervisory_org  workers/orgs in the caller's supported supervisory orgs (hr_partner)
 *   pay_group        workers in the caller's pay group(s) (payroll_viewer)
 *   all              any target Workday security lets the caller see (admin; reads only)
 *
 * Writes (catalog readOnly === false): every grant is "self", the target must be self, and
 * the call must come from src/safety/native-write-guard.ts after preview + explicit confirm.
 */
import { getByName } from "../agent-ready/registry.js";
import type { Role } from "./roles.js";
import { RbacDeniedError } from "./enforce.js";

export type AgentReadyScope = "self" | "self_and_reports" | "supervisory_org" | "pay_group" | "all";
export type AgentReadyGrant = Partial<Record<Role, AgentReadyScope>>;

// ---- worker-data-skill (read-only) ----
const WD = (worker: boolean, manager: boolean): AgentReadyGrant => ({
  ...(worker ? { worker_self: "self" as const } : {}),
  ...(manager ? { manager: "self_and_reports" as const } : {}),
  hr_partner: "supervisory_org",
  admin: "all",
  // payroll_viewer: deliberately no grants on worker-data tools (conservative).
});

// ---- self-service-skill: manager is self-only (own data), never others' ----
/** Time off, inbox, learning, goals: hr_partner reads within org scope. */
const SS_ORG_READ: AgentReadyGrant = { worker_self: "self", manager: "self", hr_partner: "supervisory_org", admin: "all" };
/** Payslips: payroll_viewer reads within pay group; hr_partner excluded (conservative). */
const SS_PAYSLIP: AgentReadyGrant = { worker_self: "self", manager: "self", payroll_viewer: "pay_group", admin: "all" };
/** Benefits enrollment, dependents, legal name, personal-info events: self + admin only. */
const SS_SELF_READ: AgentReadyGrant = { worker_self: "self", manager: "self", admin: "all" };
/** Writes: self only for every role that may write; hr_partner/payroll_viewer never write. */
const SS_SELF_WRITE: AgentReadyGrant = { worker_self: "self", manager: "self", admin: "self" };

/** Tool name -> role -> scope. Unlisted tool or role = denied (fail closed). */
export const AGENT_READY_TOOL_PERMISSIONS: Readonly<Record<string, AgentReadyGrant>> = {
  // worker-data-skill: name resolution / org-wide lookups (not needed for self: "me" suffices)
  find_org_chart_workers: WD(false, true),
  find_staffing_agent_supervisory_organization_members: WD(false, true),
  list_organizations: WD(false, true),
  list_worker_direct_reports: WD(false, true),
  // worker-data-skill: worker-context reads (also used by self-service-skill with "me")
  find_service_dates_for_worker: WD(true, true),
  find_staffing_supervisory_organization: WD(true, true), // worker_self: own org(s) only
  find_staffing_workers: WD(true, true),
  list_staffing_jobs: WD(true, true),
  list_worker_email_addresses: WD(true, true),
  list_worker_organizations: WD(true, true),
  list_worker_phone_numbers: WD(true, true),
  // worker-data-skill SENSITIVE: worker_self (self) + hr_partner + admin. Never manager.
  find_worker_personal_information: WD(true, false),
  list_worker_addresses: WD(true, false),

  // self-service-skill reads
  find_absence_balances: SS_ORG_READ,
  find_worker_time_off_details: SS_ORG_READ,
  find_worker_eligible_absence_types: SS_ORG_READ,
  find_worker_valid_time_off_dates: SS_ORG_READ,
  find_business_process_tasks: SS_ORG_READ,
  find_plan_assignments: SS_ORG_READ,
  get_learning_content: SS_ORG_READ,
  find_learning_transcript: SS_ORG_READ,
  find_continue_learning: SS_ORG_READ,
  list_my_goals: SS_ORG_READ,
  find_goal_status: SS_ORG_READ,
  find_payslips: SS_PAYSLIP, // sensitive
  find_payslip_summary: SS_PAYSLIP, // sensitive
  find_payslip_details: SS_PAYSLIP, // sensitive
  find_latest_employee_enrollment_event: SS_SELF_READ,
  get_employee_enrollment_history: SS_SELF_READ,
  view_benefits_dependent: SS_SELF_READ, // sensitive
  find_worker_legal_name: SS_SELF_READ, // sensitive
  find_detailed_personal_information_change_event: SS_SELF_READ,

  // self-service-skill writes (staged BP steps; preview + confirm via native-write-guard)
  create_worker_time_off_request: SS_SELF_WRITE,
  update_worker_time_off_entry: SS_SELF_WRITE,
  create_personal_information_change_event: SS_SELF_WRITE,
  submit_personal_information_changes: SS_SELF_WRITE,
  create_worker_home_contact_change: SS_SELF_WRITE,
  create_email_address_for_home_contact_change: SS_SELF_WRITE,
  update_email_address_for_home_contact_change: SS_SELF_WRITE,
  create_phone_number_for_home_contact_change: SS_SELF_WRITE,
  update_phone_number_for_home_contact_change: SS_SELF_WRITE,
  create_address_for_home_contact_change: SS_SELF_WRITE,
  update_address_on_home_contact_change: SS_SELF_WRITE,
  submit_home_contact_change: SS_SELF_WRITE,
  create_worker_goal_events: SS_SELF_WRITE,
  edit_worker_goals: SS_SELF_WRITE,
  submit_worker_goal_events: SS_SELF_WRITE,
};

/** Recipes: roles = intersection of the tools they call, minus worker_self (chains leave self). */
export const AGENT_READY_RECIPE_PERMISSIONS: Readonly<Record<string, AgentReadyGrant>> = {
  resolve_manager_chain: { manager: "self_and_reports", hr_partner: "supervisory_org", admin: "all" },
  list_indirect_reports: { manager: "self_and_reports", hr_partner: "supervisory_org", admin: "all" },
};

const SCOPE_RANK: Record<AgentReadyScope, number> = {
  self: 0,
  self_and_reports: 1,
  supervisory_org: 2,
  pay_group: 2,
  all: 3,
};

/** Write-specific denial (non-self target, or missing preview + confirmation). */
export class AgentReadyWriteDeniedError extends RbacDeniedError {
  constructor(toolName: string, held: readonly Role[], reason: string) {
    super(toolName, [], held);
    this.message = `Access denied: '${toolName}' ${reason}`;
    this.name = "AgentReadyWriteDeniedError";
  }
}

export type AgentReadyCallContext = {
  /**
   * Worker the call targets: "me", a worker WID, or undefined when the tool has no worker
   * target. For tools keyed by another WID (payslip, event, entry, task), pass the OWNING
   * worker here — the adapter must resolve ownership before calling.
   */
  contextInstanceId?: string;
  /** Caller's own worker WID, when resolved. */
  callerWid?: string;
  /**
   * Result of the runtime scope check for non-self targets (is the target a report / in the
   * caller's supervisory orgs / pay group?). undefined = not checked -> non-self denied.
   */
  targetInScope?: boolean;
  /** Set only by src/safety/native-write-guard.ts after a consumed preview + userConfirmed. */
  previewConfirmed?: boolean;
};

export function grantsFor(name: string): AgentReadyGrant | undefined {
  return AGENT_READY_TOOL_PERMISSIONS[name] ?? AGENT_READY_RECIPE_PERMISSIONS[name];
}

/** True when the catalog marks the native tool as a write (readOnly === false). */
export function isAgentReadyWrite(name: string): boolean {
  return getByName(name)?.readOnly === false;
}

export function isSelfTarget(ctx: AgentReadyCallContext): boolean {
  const id = ctx.contextInstanceId?.trim();
  return id === "me" || (!!id && !!ctx.callerWid && id === ctx.callerWid);
}

/**
 * Role/scope check without the write-confirmation gate (used by the guard at preview time).
 * Returns the widest scope held, or throws RbacDeniedError.
 */
export function assertAgentReadyScope(
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
  if (isAgentReadyWrite(name)) {
    // Defense in depth: writes are self-only for everyone, whatever the grant says.
    if (!isSelfTarget(ctx)) {
      throw new AgentReadyWriteDeniedError(name, userRoles, 'is a write: target must be "me" or your own WID.');
    }
    return "self";
  }
  if (best === "all" || isSelfTarget(ctx)) return best;
  if (best === "self") {
    throw new RbacDeniedError(name, allowedRoles.filter((r) => grant[r] !== "self"), userRoles);
  }
  if (ctx.targetInScope !== true) {
    throw new RbacDeniedError(name, allowedRoles.filter((r) => grant[r] === "all"), userRoles);
  }
  return best;
}

/**
 * Call-time check. Reads: role/scope. Writes: additionally require previewConfirmed (only the
 * native write guard sets it), so no write can run without preview + explicit confirmation.
 */
export function assertAgentReadyCallAllowed(
  userRoles: readonly Role[],
  name: string,
  ctx: AgentReadyCallContext = {},
): AgentReadyScope {
  const scope = assertAgentReadyScope(userRoles, name, ctx);
  if (isAgentReadyWrite(name) && ctx.previewConfirmed !== true) {
    throw new AgentReadyWriteDeniedError(
      name,
      userRoles,
      "is a write: run it through the native write guard (preview, then explicit confirmation).",
    );
  }
  return scope;
}
