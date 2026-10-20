/**
 * RBAC for NATIVE Agent-Ready tools (Layer 1) and the composite recipes over them.
 *
 * Kept separate from TOOL_PERMISSIONS (which must match this server's own registered tools
 * 1:1). Applied by the agent/skill layer and by Layer-3 adapters before calling Workday MCP.
 * Coarse pre-filter only — Workday security on the token decides.
 *
 * Scopes:
 *   self             target must be "me" or the caller's own WID
 *   actor_self       writes only: the caller acts as themselves (feedback giver / awaiting
 *                    approver); the subject may be anyone Workday lets them act on
 *   self_and_reports self + VERIFIED team: target must be in a TeamScope from
 *                    src/rbac/team-scope.ts (direct + indirect reports, hasManagerRole, cap 5)
 *   supervisory_org  workers/orgs in the caller's supported supervisory orgs (hr_partner)
 *   pay_group        workers in the caller's pay group(s) (payroll_viewer)
 *   all              any target Workday security lets the caller see (admin; reads only)
 *
 * Writes (catalog readOnly === false): never "all"; the call must come from
 * src/safety/native-write-guard.ts after preview + explicit confirm. Self-service writes are
 * "self" for every role; manager-actions writes follow team / org scope.
 * Business-process step actions (approve/deny) additionally require the caller to be the
 * step's awaiting approver (`awaitingApproverWid`, supplied by caller code — like payslip ownership).
 * request_payroll_input additionally requires `payrollDomain: true` (Workday payroll domain).
 */
import { getByName } from "../agent-ready/registry.js";
import type { Role } from "./roles.js";
import { RbacDeniedError } from "./enforce.js";
import { isInVerifiedTeam, type TeamScope } from "./team-scope.js";
import { isOrgInScope, isValidOrgScope, isWorkerInOrgScope, type OrgScope, type WorkerOrgProof } from "./org-scope.js";

export type AgentReadyScope =
  | "self"
  | "actor_self"
  | "self_and_reports"
  | "supervisory_org"
  | "pay_group"
  | "all";
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
/** Time off reads shared with manager-actions-skill: manager also on verified team. */
const SS_TEAM_TIME_OFF: AgentReadyGrant = { ...SS_ORG_READ, manager: "self_and_reports" };
/** Payslips: payroll_viewer reads within pay group; hr_partner excluded (conservative). */
const SS_PAYSLIP: AgentReadyGrant = { worker_self: "self", manager: "self", payroll_viewer: "pay_group", admin: "all" };
/** Benefits enrollment, dependents, legal name, personal-info events: self + admin only. */
const SS_SELF_READ: AgentReadyGrant = { worker_self: "self", manager: "self", admin: "all" };
/** Writes: self only for every role that may write; hr_partner/payroll_viewer never write. */
const SS_SELF_WRITE: AgentReadyGrant = { worker_self: "self", manager: "self", admin: "self" };

// ---- manager-actions-skill ----
const MA_READ: AgentReadyGrant = { manager: "self_and_reports", hr_partner: "supervisory_org", admin: "all" };
const MA_BP_READ: AgentReadyGrant = { worker_self: "self", ...MA_READ };
const MA_PAYROLL_READ: AgentReadyGrant = { ...MA_READ, payroll_viewer: "pay_group" };
/** Approve/deny: always "awaiting approver = caller"; manager subject in team, hr_partner in org. */
const MA_BP_STEP_WRITE: AgentReadyGrant = {
  worker_self: "actor_self",
  manager: "self_and_reports",
  hr_partner: "supervisory_org",
  admin: "actor_self",
};
/** Team/org writes: admin self only (prior decision). */
const MA_TEAM_WRITE: AgentReadyGrant = { manager: "self_and_reports", hr_partner: "supervisory_org", admin: "self" };

// ---- hr-partner-skill ----
const HR_READ: AgentReadyGrant = { hr_partner: "supervisory_org", admin: "all" };
/** Org chart reads: manager limited to own team orgs (OrgScope with basis "manager"). */
const HR_ORG_CHART_READ: AgentReadyGrant = { ...HR_READ, manager: "self_and_reports" };
const HR_SELF_OR_ORG_WRITE: AgentReadyGrant = { worker_self: "self", hr_partner: "supervisory_org", admin: "self" };

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
  // shared with manager-actions-skill: manager may read verified-team time off
  find_absence_balances: SS_TEAM_TIME_OFF,
  find_worker_time_off_details: SS_TEAM_TIME_OFF,
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

  // manager-actions-skill reads (35): manager = verified team, hr_partner = org, admin = all
  ...Object.fromEntries(
    [
      "list_staffing_business_process_types",
      "find_expense_reports", "find_expense_lines",
      "find_workers_to_initiate_change_job", "find_change_job_templates", "find_job_profiles_for_change_job",
      "find_locations_for_change_job", "find_supervisory_organizations_for_change_job", "find_reasons_for_change_job",
      "find_employee_types_for_change_job",
      "find_worker_history_events",
      "list_job_requisition_supervisory_organizations", "list_job_requisition_statuses", "list_job_requisition_types",
      "find_job_requisitions", "find_in_progress_create_job_requisition_events", "find_my_candidates",
      "list_my_candidate_candidate_stages", "list_my_candidate_job_profiles", "list_my_candidate_candidate_types",
      "list_my_candidate_job_families",
      "find_performance_review", "find_worker_from_my_team_to_filter_performance_review",
      "list_workers_for_initiate_performance_review", "find_worker_performance_review_template",
      "find_worker_anytime_feedback_received",
      "list_my_teams_learning_records",
    ].map((n) => [n, MA_READ]),
  ),
  // BP event/step reads: worker_self on own items (subject or awaiting approver = me)
  find_business_process_event: MA_BP_READ,
  find_business_process_event_step: MA_BP_READ,
  find_completed_steps_for_business_process_event: MA_BP_READ,
  find_remaining_steps_for_business_process_event: MA_BP_READ,
  find_anytime_feedback_events: { ...MA_READ, worker_self: "self" },
  // payroll input lookups: payroll_viewer read-only within pay group
  list_request_payroll_input_workers: MA_PAYROLL_READ, // sensitive
  list_request_payroll_input_pay_components: MA_PAYROLL_READ,
  list_request_payroll_input_event_input_types_for_pay_component: MA_PAYROLL_READ,

  // manager-actions-skill writes (6)
  approve_business_process_event_step: MA_BP_STEP_WRITE,
  deny_business_process_event_step: MA_BP_STEP_WRITE,
  initiate_change_job: MA_TEAM_WRITE,
  initiate_performance_review_for_employee: MA_TEAM_WRITE,
  create_anytime_feedback_events: { ...MA_TEAM_WRITE, worker_self: "actor_self", admin: "actor_self" },
  request_payroll_input: MA_TEAM_WRITE, // + payrollDomain required; payroll_viewer never writes

  // hr-partner-skill reads (10): hr_partner via org-scope proof; admin all
  find_org_chart_organizations: HR_ORG_CHART_READ, // manager: own team orgs only (filterToOrgScope)
  get_org_chart_children: HR_ORG_CHART_READ,
  get_org_chart_parent: HR_ORG_CHART_READ,
  list_organization_members: HR_READ,
  list_leave_event_statuses: HR_READ,
  list_time_off_entry_statuses: HR_READ,
  list_onboarding_business_process_tasks: HR_READ,
  list_worker_history_events: HR_READ, // sensitive
  find_ethnicity: HR_READ, // special category
  find_ethnicity_details: HR_READ, // special category
  // hr-partner-skill writes (11): worker_self on self, hr_partner in org scope, admin self. Never manager.
  request_worker_leave_of_absence: HR_SELF_OR_ORG_WRITE,
  ...Object.fromEntries(
    [
      "create_passport_ids", "update_passport_ids", "create_visa_ids", "update_visa_ids", "submit_passport_and_visa_changes",
      "create_national_ids", "update_national_ids", "create_government_ids", "update_government_ids",
      "submit_government_identifier_changes",
    ].map((n) => [n, HR_SELF_OR_ORG_WRITE]),
  ),
};

/** Recipes: roles = intersection of the tools they call, minus worker_self (chains leave self). */
export const AGENT_READY_RECIPE_PERMISSIONS: Readonly<Record<string, AgentReadyGrant>> = {
  // Aggregate-only diversity (src/safety/diversity.ts): hr_partner (org proof) and admin only.
  aggregate_diversity: { hr_partner: "supervisory_org", admin: "all" },
  resolve_manager_chain: { manager: "self_and_reports", hr_partner: "supervisory_org", admin: "all" },
  list_indirect_reports: { manager: "self_and_reports", hr_partner: "supervisory_org", admin: "all" },
};

const SCOPE_RANK: Record<AgentReadyScope, number> = {
  self: 0,
  actor_self: 0,
  self_and_reports: 1,
  supervisory_org: 2,
  pay_group: 2,
  all: 3,
};

/**
 * How a tool's target is checked:
 *   worker      (default) contextInstanceId = target worker (or the owner of a payslip/event/entry)
 *   none        reference lookup (types, templates, statuses, pay components): role grant suffices
 *   caller_list list Workday scopes to the caller (my team / my candidates / eligible workers);
 *               org / pay-group scopes still need targetInScope for the requested filter
 *   org         contextInstanceId = target organization WID (needs an OrgScope containing it)
 */
export type AgentReadyTarget = "worker" | "none" | "caller_list" | "org";

const NONE_TARGET = [
  "list_organizations", "get_learning_content", "find_goal_status",
  "list_staffing_business_process_types",
  "find_change_job_templates", "find_job_profiles_for_change_job", "find_locations_for_change_job",
  "find_supervisory_organizations_for_change_job", "find_reasons_for_change_job", "find_employee_types_for_change_job",
  "list_job_requisition_supervisory_organizations", "list_job_requisition_statuses", "list_job_requisition_types",
  "list_my_candidate_candidate_stages", "list_my_candidate_job_profiles", "list_my_candidate_candidate_types",
  "list_my_candidate_job_families", "find_worker_performance_review_template",
  "list_request_payroll_input_pay_components", "list_request_payroll_input_event_input_types_for_pay_component",
  "list_leave_event_statuses", "list_time_off_entry_statuses", "find_ethnicity", "find_ethnicity_details",
];
const ORG_TARGET = ["get_org_chart_children", "get_org_chart_parent", "list_organization_members", "aggregate_diversity"];
const CALLER_LIST_TARGET = [
  "find_workers_to_initiate_change_job", "find_worker_from_my_team_to_filter_performance_review",
  "list_workers_for_initiate_performance_review", "list_my_teams_learning_records", "list_request_payroll_input_workers",
  "find_job_requisitions", "find_in_progress_create_job_requisition_events", "find_my_candidates",
  "find_org_chart_organizations",
];
export const AGENT_READY_TOOL_TARGETS: Readonly<Record<string, AgentReadyTarget>> = {
  ...Object.fromEntries(NONE_TARGET.map((n) => [n, "none" as const])),
  ...Object.fromEntries(CALLER_LIST_TARGET.map((n) => [n, "caller_list" as const])),
  ...Object.fromEntries(ORG_TARGET.map((n) => [n, "org" as const])),
};

/**
 * hr-partner-skill tools (and aggregate_diversity): org / team-org scope must be PROVEN with
 * src/rbac/org-scope.ts (OrgScope / WorkerOrgProof). A bare `targetInScope: true` is refused.
 */
export const ORG_PROOF_REQUIRED: ReadonlySet<string> = new Set([
  "find_org_chart_organizations", "get_org_chart_children", "get_org_chart_parent", "list_organization_members",
  "list_leave_event_statuses", "list_time_off_entry_statuses", "list_onboarding_business_process_tasks",
  "list_worker_history_events", "find_ethnicity", "find_ethnicity_details",
  "request_worker_leave_of_absence",
  "create_passport_ids", "update_passport_ids", "create_visa_ids", "update_visa_ids", "submit_passport_and_visa_changes",
  "create_national_ids", "update_national_ids", "create_government_ids", "update_government_ids",
  "submit_government_identifier_changes",
  "aggregate_diversity",
]);

/** BP tools where "awaiting approver = caller" counts as an own item. */
export const BP_STEP_TOOLS: ReadonlySet<string> = new Set([
  "find_business_process_tasks",
  "find_business_process_event",
  "find_business_process_event_step",
  "find_completed_steps_for_business_process_event",
  "find_remaining_steps_for_business_process_event",
  "approve_business_process_event_step",
  "deny_business_process_event_step",
]);
/** Step actions: the caller MUST be the awaiting approver, whatever the role. */
export const BP_STEP_ACTIONS: ReadonlySet<string> = new Set([
  "approve_business_process_event_step",
  "deny_business_process_event_step",
]);
/** Requires the Workday payroll domain capability in addition to the role grant. */
export const REQUIRES_PAYROLL_DOMAIN: ReadonlySet<string> = new Set(["request_payroll_input"]);

/** Denial with a specific reason (team scope, approver, payroll domain, write gate). */
export class AgentReadyDeniedError extends RbacDeniedError {
  constructor(toolName: string, held: readonly Role[], reason: string) {
    super(toolName, [], held);
    this.message = `Access denied: '${toolName}' ${reason}`;
    this.name = "AgentReadyDeniedError";
  }
}
/** Write-specific denial (missing preview + confirmation, non-self target). */
export class AgentReadyWriteDeniedError extends AgentReadyDeniedError {
  constructor(toolName: string, held: readonly Role[], reason: string) {
    super(toolName, held, reason);
    this.name = "AgentReadyWriteDeniedError";
  }
}

export type AgentReadyCallContext = {
  /**
   * Worker the call targets: "me", a worker WID, or undefined when the tool has no worker
   * target. For tools keyed by another WID (payslip, event, step, entry, task), pass the OWNING
   * / SUBJECT worker here — caller code must resolve ownership before calling.
   */
  contextInstanceId?: string;
  /** Caller's own worker WID, when resolved. Required for verified-team access. */
  callerWid?: string;
  /**
   * Result of the runtime scope check for non-self targets for org / pay-group scopes
   * (hr_partner, payroll_viewer). undefined = not checked -> non-self denied.
   * NOT accepted for manager scope: managers need `teamScope`.
   */
  targetInScope?: boolean;
  /** Verified team (src/rbac/team-scope.ts verifyTeamScope) for manager self_and_reports access. */
  teamScope?: TeamScope;
  /** Verified org scope (src/rbac/org-scope.ts verifyOrgScope): hr_partner orgs, or a manager's team orgs. */
  orgScope?: OrgScope;
  /** Per-worker org proof (verifyWorkerInOrgScope) for hr_partner actions on a worker. */
  workerOrgProof?: WorkerOrgProof;
  /** BP step tools: the worker the step is awaiting (from find_business_process_event_step / tasks). */
  awaitingApproverWid?: string;
  /** Caller holds the Workday payroll domain (required for request_payroll_input). */
  payrollDomain?: boolean;
  /** Set only by src/safety/native-write-guard.ts after a consumed preview + userConfirmed. */
  previewConfirmed?: boolean;
};

export function grantsFor(name: string): AgentReadyGrant | undefined {
  return AGENT_READY_TOOL_PERMISSIONS[name] ?? AGENT_READY_RECIPE_PERMISSIONS[name];
}

export function targetKindFor(name: string): AgentReadyTarget {
  return AGENT_READY_TOOL_TARGETS[name] ?? "worker";
}

/** True when the catalog marks the native tool as a write (readOnly === false). */
export function isAgentReadyWrite(name: string): boolean {
  return getByName(name)?.readOnly === false;
}

function isSelfId(id: string | undefined, callerWid: string | undefined): boolean {
  const v = id?.trim();
  return v === "me" || (!!v && !!callerWid && v === callerWid);
}

export function isSelfTarget(ctx: AgentReadyCallContext): boolean {
  return isSelfId(ctx.contextInstanceId, ctx.callerWid);
}

function permits(scope: AgentReadyScope, name: string, write: boolean, ctx: AgentReadyCallContext): boolean {
  if (write && scope === "all") return false; // admin full READ only
  const kind = targetKindFor(name);
  const proof = ORG_PROOF_REQUIRED.has(name);
  const basis = scope === "supervisory_org" ? "hr_partner" : scope === "self_and_reports" ? "manager" : undefined;
  if (kind === "none") {
    if (write) return false;
    // Org-gated lookups still need a verified org scope for hr_partner.
    if (proof && scope === "supervisory_org") return isValidOrgScope(ctx.orgScope, "hr_partner", ctx.callerWid);
    return true;
  }
  if (kind === "org") {
    if (write) return false;
    if (scope === "all") return true;
    if (!basis) return false;
    return isOrgInScope(ctx.orgScope, ctx.contextInstanceId, basis, ctx.callerWid);
  }
  if (kind === "caller_list") {
    if (write) return false;
    if (proof) {
      if (scope === "all") return true;
      // Caller must hold a verified org scope and filter results with filterToOrgScope().
      return !!basis && isValidOrgScope(ctx.orgScope, basis, ctx.callerWid);
    }
    if (scope === "supervisory_org" || scope === "pay_group") return ctx.targetInScope === true;
    return scope !== "actor_self";
  }
  const self =
    isSelfTarget(ctx) || (BP_STEP_TOOLS.has(name) && !BP_STEP_ACTIONS.has(name) && isSelfId(ctx.awaitingApproverWid, ctx.callerWid));
  switch (scope) {
    case "all":
      return true;
    case "actor_self":
      return write; // actor (giver / approver) is the caller; approver rule enforced separately
    case "self":
      return self;
    case "self_and_reports":
      return self || (!!ctx.callerWid && isInVerifiedTeam(ctx.teamScope, ctx.contextInstanceId, ctx.callerWid));
    case "supervisory_org": {
      if (self) return true;
      const proven = isWorkerInOrgScope(ctx.workerOrgProof, ctx.contextInstanceId, "hr_partner", ctx.callerWid);
      return proof ? proven : proven || ctx.targetInScope === true;
    }
    case "pay_group":
      return self || ctx.targetInScope === true;
  }
}

/**
 * Role/scope check without the write-confirmation gate (used by the guard at preview time).
 * Returns the widest permitting scope, or throws RbacDeniedError.
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
  if (!held.length) throw new RbacDeniedError(name, allowedRoles, userRoles);
  const write = isAgentReadyWrite(name);
  if (REQUIRES_PAYROLL_DOMAIN.has(name) && ctx.payrollDomain !== true) {
    throw new AgentReadyDeniedError(name, userRoles, "requires the Workday payroll domain capability (payrollDomain).");
  }
  if (BP_STEP_ACTIONS.has(name) && !isSelfId(ctx.awaitingApproverWid, ctx.callerWid)) {
    throw new AgentReadyDeniedError(name, userRoles, "is only allowed on steps where you are the awaiting approver.");
  }
  const ok = held.find((s) => permits(s, name, write, ctx));
  if (ok) return ok;
  if (held.includes("self_and_reports") && !held.some((s) => s === "supervisory_org" || s === "all")) {
    throw new AgentReadyDeniedError(
      name,
      userRoles,
      "target is not in your verified team (direct + indirect reports via hasManagerRole, depth <= 5).",
    );
  }
  if (write && held.every((s) => s === "self")) {
    throw new AgentReadyWriteDeniedError(name, userRoles, 'is a write: target must be "me" or your own WID.');
  }
  throw new RbacDeniedError(name, allowedRoles, userRoles);
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
