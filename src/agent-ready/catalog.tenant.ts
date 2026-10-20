/**
 * TENANT-DISCOVERED Agent-Ready tools (worker-data-skill + self-service-skill) (hand-maintained, kept separate from the generated seed
 * so `scripts/sync-agent-ready-catalog.ts` regenerating catalog.generated.ts never drops them).
 *
 * Discovered 2026-10-20 by the Workday Developer Agent on dev tenant bzyvydgxsb_extdev
 * (wd119, Workday Open Developer Platform personal dev tenant), Extend app
 * peopletechHrBaseline_rjqhll, skill worker-data-skill (read-only). Mirror: extend/skills/worker-data-skill.md
 *
 * WIDs: NOT exposed in the Developer Agent UI, so every `wid` is null. Do not invent them;
 * fill from an ASOR Agent Resource Search dump (`--asor`) when available.
 * Params: only parameters stated in the discovery notes are listed. Everything else is
 * unknown and passes through to Workday MCP — discover the live schema at runtime.
 */
import type { AgentReadyParam, AgentReadyToolDefinition } from "./types.js";

export const TENANT_DISCOVERY_SOURCE = "tenant-discovered 2026-10-20 bzyvydgxsb_extdev";

export const TENANT_DISCOVERY_META = {
  tenant: "bzyvydgxsb_extdev",
  release: "wd119",
  platform: "Workday Open Developer Platform (personal dev tenant)",
  discoveredAt: "2026-10-20",
  discoveredBy: "Workday Developer Agent",
  extendApp: "peopletechHrBaseline_rjqhll",
  skill: "worker-data-skill",
} as const;

const CONTEXT_INSTANCE_ID: AgentReadyParam = {
  name: "contextInstanceId",
  type: 'WID | "me"',
  description: 'Target instance WID, or "me" for the signed-in worker.',
};

const WORKER_DATA_SKILL = "worker-data-skill";
const SELF_SERVICE_SKILL = "self-service-skill";
/** Tools used by both skills (catalogued once, from the worker-data discovery). */
const BOTH_SKILLS = [WORKER_DATA_SKILL, SELF_SERVICE_SKILL];

/** Shared fields for every tool in the worker-data-skill (read-only, WID unknown). */
const base = {
  kind: "basic",
  operationType: "VIEW",
  readOnly: true,
  wid: null, // WID not exposed by the Developer Agent UI — fill from ASOR, never invent.
  source: TENANT_DISCOVERY_SOURCE,
  skills: [WORKER_DATA_SKILL],
} as const;

export const WORKER_DATA_SKILL_TOOLS: AgentReadyToolDefinition[] = [
  {
    ...base,
    name: "find_org_chart_workers",
    productArea: "Workforce / Worker Data",
    category: "Org Chart",
    description: "Resolve a worker display name to a worker WID (org chart).",
    inputSchemaStatus: "unknown",
  },
  {
    ...base,
    name: "find_service_dates_for_worker",
    productArea: "Workforce / Worker Data",
    category: "Employment / Service Dates",
    description:
      "Service dates for a worker: hire, original hire, continuous service, benefits service, seniority, company service dates, length of service.",
    inputSchemaStatus: "unknown",
  },
  {
    ...base,
    name: "find_staffing_agent_supervisory_organization_members",
    productArea: "Workforce / Staffing",
    category: "Supervisory Organization",
    description:
      "Filled positions in a supervisory org (name, business title, job profile, job type, location, next pay period).",
    inputSchemaStatus: "unknown",
    notes: "Paginated; response carries a total. Pagination param names not captured.",
  },
  {
    ...base,
    name: "find_staffing_supervisory_organization",
    productArea: "Workforce / Staffing",
    category: "Supervisory Organization",
    description: "Supervisory org detail: name, type, location, active, manager.",
    inputSchemaStatus: "unknown",
  },
  {
    ...base,
    name: "find_staffing_workers",
    skills: BOTH_SKILLS,
    productArea: "Workforce / Staffing",
    category: "Worker",
    description:
      "Search workers (search tokens, OR semantics; or email) or fetch one by contextInstanceId: business title, location, primary managers, primarySupervisoryOrganization, work email/phone.",
    inputSchemaStatus: "partial",
    params: [
      { name: "search", type: "string", description: "Search tokens, combined with OR." },
      { name: "email", type: "string", description: "Find a worker by email address." },
      CONTEXT_INSTANCE_ID,
    ],
  },
  {
    ...base,
    name: "find_worker_personal_information",
    skills: BOTH_SKILLS,
    sensitive: true,
    productArea: "Workforce / Personal Data",
    category: "Personal Information (sensitive)",
    description: "Personal information: date of birth, gender, marital status, citizenship, nationality.",
    inputSchemaStatus: "unknown",
    securityDomains: ["Person Data: Personal Information", "Self-Service: Personal Information"],
    notes: "Sensitive. Requires either security domain above.",
  },
  {
    ...base,
    name: "list_organizations",
    productArea: "Workforce / Organizations",
    category: "Organization",
    description: "Search organizations by name prefix.",
    inputSchemaStatus: "unknown",
    notes: "Name-prefix search; parameter name not captured.",
  },
  {
    ...base,
    name: "list_staffing_jobs",
    productArea: "Workforce / Staffing",
    category: "Job / Position",
    description:
      'Job/position detail by job WID or "me": job profile, job type, supervisory org, next pay period.',
    inputSchemaStatus: "partial",
    params: [{ ...CONTEXT_INSTANCE_ID, description: 'Job WID, or "me" for the signed-in worker\'s job.' }],
  },
  {
    ...base,
    name: "list_worker_addresses",
    skills: BOTH_SKILLS,
    sensitive: true,
    productArea: "Workforce / Personal Data",
    category: "Contact (sensitive)",
    description: "Home addresses of a worker.",
    inputSchemaStatus: "unknown",
    notes: "Sensitive (home address).",
  },
  {
    ...base,
    name: "list_worker_direct_reports",
    productArea: "Workforce / Staffing",
    category: "Reporting Line",
    description: "Direct reports with hasManagerRole, reporting type, time in position.",
    inputSchemaStatus: "partial",
    params: [
      { name: "limit", type: "integer", description: "Page size." },
      { name: "offset", type: "integer", description: "Page offset." },
    ],
    notes: "limit/offset pagination; response carries a total. Worker selector param not captured.",
  },
  {
    ...base,
    name: "list_worker_email_addresses",
    skills: BOTH_SKILLS,
    productArea: "Workforce / Worker Data",
    category: "Contact",
    description: "Email addresses of a worker.",
    inputSchemaStatus: "unknown",
  },
  {
    ...base,
    name: "list_worker_organizations",
    productArea: "Workforce / Organizations",
    category: "Organization Membership",
    description:
      "All org memberships: Company, Cost Center, Supervisory Org, Region, Location Hierarchy, Company Hierarchy, Cost Center Hierarchy.",
    inputSchemaStatus: "partial",
    params: [
      { name: "organizationType", type: "string", description: "Filter by organization type." },
      { name: "subtype", type: "string", description: "Filter by organization subtype." },
    ],
  },
  {
    ...base,
    name: "list_worker_phone_numbers",
    skills: BOTH_SKILLS,
    productArea: "Workforce / Worker Data",
    category: "Contact",
    description: "Phone numbers of a worker.",
    inputSchemaStatus: "unknown",
  },
];

/** worker-data-skill sensitive tools: worker_self (self) + hr_partner + admin only, never `manager`. */
export const SENSITIVE_WORKER_DATA_TOOLS = ["find_worker_personal_information", "list_worker_addresses"] as const;

// ---------------------------------------------------------------------------
// self-service-skill (Extend app peopletechHrBaseline_rjqhll), discovered 2026-10-20.
// Scope in the skill is always "me". 34 new tools; 5 more are shared with worker-data-skill
// above (find_staffing_workers, find_worker_personal_information, list_worker_addresses,
// list_worker_email_addresses, list_worker_phone_numbers). Mirror: extend/skills/self-service-skill.md
// Known gap: the skill references update_personal_information_marital_status, which is NOT in
// its tool list — deliberately not catalogued until the tenant adds it.
// ---------------------------------------------------------------------------

export const SELF_SERVICE_DISCOVERY_SOURCE = `${TENANT_DISCOVERY_SOURCE} self-service-skill`;

const ssRead = {
  kind: "basic",
  operationType: "VIEW",
  readOnly: true,
  wid: null, // not exposed by the Developer Agent UI — never invent
  source: SELF_SERVICE_DISCOVERY_SOURCE,
  skills: [SELF_SERVICE_SKILL],
} as const;

/**
 * Writes are staged business-process steps (open event -> stage -> submit). kind "advanced";
 * operationType only where the verb makes it obvious (create_ -> CREATE, update_/edit_ -> PATCH);
 * submit_ steps leave it unset (not stated by discovery).
 */
const ssWrite = {
  kind: "advanced",
  readOnly: false,
  wid: null, // not exposed by the Developer Agent UI — never invent
  source: SELF_SERVICE_DISCOVERY_SOURCE,
  skills: [SELF_SERVICE_SKILL],
} as const;

const p = (name: string, type: string, description: string): AgentReadyParam => ({ name, type, description });
const ABSENCE = "Workforce / Absence";
const PAYROLL = "Payroll";
const BENEFITS = "Benefits";
const LEARNING = "Talent / Learning";
const GOALS = "Talent / Performance";
const PERSONAL = "Workforce / Personal Data";
const CONTACT = "Workforce / Worker Data";
const INBOX = "Business Process / Inbox";

export const SELF_SERVICE_SKILL_TOOLS: AgentReadyToolDefinition[] = [
  // ---- reads: time off ----
  {
    ...ssRead, name: "find_absence_balances", productArea: ABSENCE, category: "Time Off Balances",
    description: "Time-off balances per absence plan for a worker.",
    inputSchemaStatus: "partial", params: [p("effective", "date YYYY-MM-DD", "Balance as-of date (optional).")],
    notes: "Takes the worker WID (param name not captured).",
  },
  {
    ...ssRead, name: "find_worker_time_off_details", productArea: ABSENCE, category: "Time Off Requests",
    description: "Time-off entries/requests history for a worker.",
    inputSchemaStatus: "partial",
    params: [
      p("from", "date yyyy-mm-dd", "Range start."),
      p("to", "date yyyy-mm-dd", "Range end."),
      p("timeOffType", "WID", "Filter by time-off type."),
      p("status", "WID", "Filter by status."),
    ],
    notes: "Takes the worker WID (param name not captured).",
  },
  {
    ...ssRead, name: "find_worker_eligible_absence_types", productArea: ABSENCE, category: "Time Off Types",
    description: "Absence/time-off types the worker can request.",
    inputSchemaStatus: "unknown", notes: "Takes the worker WID (param name not captured).",
  },
  {
    ...ssRead, name: "find_worker_valid_time_off_dates", productArea: ABSENCE, category: "Time Off Validation",
    description: "Validates proposed time-off dates for a worker.",
    inputSchemaStatus: "unknown", notes: "Takes the worker WID and proposed dates (param names not captured).",
  },
  // ---- reads: payroll (sensitive) ----
  {
    ...ssRead, name: "find_payslips", productArea: PAYROLL, category: "Payslips (sensitive)", sensitive: true,
    description: "Lists the signed-in worker's payslips.",
    inputSchemaStatus: "partial",
    params: [
      p("startDate", "date", "Range start."),
      p("endDate", "date", "Range end."),
      p("numberOfPayslips", "integer", "How many payslips to return."),
      p("mostRecent", "boolean", "Only the most recent payslip."),
    ],
  },
  {
    ...ssRead, name: "find_payslip_summary", productArea: PAYROLL, category: "Payslips (sensitive)", sensitive: true,
    description: "Payslip summary (payment date, period, gross, net, YTD).",
    inputSchemaStatus: "unknown", notes: "Takes a payslip WID (param name not captured).",
  },
  {
    ...ssRead, name: "find_payslip_details", productArea: PAYROLL, category: "Payslips (sensitive)", sensitive: true,
    description: "Payslip details: earnings, taxes, deductions, employer-paid benefits.",
    inputSchemaStatus: "unknown", notes: "Takes a payslip WID (param name not captured).",
  },
  // ---- reads: benefits ----
  {
    ...ssRead, name: "find_latest_employee_enrollment_event", productArea: BENEFITS, category: "Benefit Enrollment",
    description: "Current benefit enrollment (latest enrollment event).", inputSchemaStatus: "unknown",
  },
  {
    ...ssRead, name: "get_employee_enrollment_history", productArea: BENEFITS, category: "Benefit Enrollment",
    description: "Benefit enrollment history.", inputSchemaStatus: "unknown",
  },
  {
    ...ssRead, name: "view_benefits_dependent", productArea: BENEFITS, category: "Dependents (sensitive)", sensitive: true,
    description: "Benefit dependents: name, relationship, date of birth.", inputSchemaStatus: "unknown",
  },
  // ---- reads: inbox ----
  {
    ...ssRead, name: "find_business_process_tasks", productArea: INBOX, category: "Inbox Tasks",
    description: "Inbox tasks (business-process steps awaiting action); defaults to the last 30 days.",
    inputSchemaStatus: "partial",
    params: [
      p("startDate", "date", "Range start (default: 30 days ago)."),
      p("endDate", "date", "Range end."),
      p("contextInstanceId", "WID", "Task WID to fetch a single task."),
    ],
  },
  // ---- reads: learning ----
  {
    ...ssRead, name: "find_plan_assignments", productArea: LEARNING, category: "Learning Assignments",
    description: "Learning assignments for the worker.", inputSchemaStatus: "unknown",
  },
  {
    ...ssRead, name: "get_learning_content", productArea: LEARNING, category: "Learning Catalog",
    description: "Browse/search learning content (courses).", inputSchemaStatus: "unknown",
  },
  {
    ...ssRead, name: "find_learning_transcript", productArea: LEARNING, category: "Learning Transcript",
    description: "Learning transcript record.", inputSchemaStatus: "unknown",
    notes: "Takes a learning record WID (param name not captured).",
  },
  {
    ...ssRead, name: "find_continue_learning", productArea: LEARNING, category: "Learning In Progress",
    description: "In-progress learning to continue.", inputSchemaStatus: "unknown",
    notes: "Takes a learning record WID (param name not captured).",
  },
  // ---- reads: goals ----
  {
    ...ssRead, name: "list_my_goals", productArea: GOALS, category: "Goals",
    description: "The worker's goals (name, status, percent complete, due date, weight, category).",
    inputSchemaStatus: "partial", params: [p("status", "WID", "Goal status WID (resolve via find_goal_status, never a label).")],
  },
  {
    ...ssRead, name: "find_goal_status", productArea: GOALS, category: "Goals (prompt-like lookup)",
    description: "Resolves goal status WIDs.", inputSchemaStatus: "unknown",
  },
  // ---- reads: personal data ----
  {
    ...ssRead, name: "find_worker_legal_name", productArea: PERSONAL, category: "Legal Name (sensitive)", sensitive: true,
    description: "The worker's legal name.", inputSchemaStatus: "unknown", notes: 'Used with "me".',
  },
  {
    ...ssRead, name: "find_detailed_personal_information_change_event", productArea: PERSONAL, category: "Personal Information Change",
    description: "Reads a personal-information change event to get the personal information record WID to stage changes on.",
    inputSchemaStatus: "unknown", notes: "Takes an event WID (param name not captured). Read step inside personal_information_change.",
  },

  // ---- writes: time off (single-step BP submits) ----
  {
    ...ssWrite, name: "create_worker_time_off_request", operationType: "CREATE", productArea: ABSENCE, category: "Time Off Requests",
    description: "Submits a time-off request (worker WID, time-off type WID, dates).",
    businessProcess: { flow: "request_time_off", step: "submit" },
    inputSchemaStatus: "unknown", notes: "Takes worker WID, type WID, dates (param names not captured).",
  },
  {
    ...ssWrite, name: "update_worker_time_off_entry", operationType: "PATCH", productArea: ABSENCE, category: "Time Off Requests",
    description: "Updates a time-off entry; delete:true cancels it.",
    businessProcess: { flow: "cancel_time_off", step: "submit" },
    inputSchemaStatus: "partial", params: [p("delete", "boolean", "true = cancel the entry.")],
    notes: "Takes the entry WID (param name not captured).",
  },
  // ---- writes: personal information change ----
  {
    ...ssWrite, name: "create_personal_information_change_event", operationType: "CREATE", productArea: PERSONAL, category: "Personal Information Change",
    description: "Opens a personal-information change event for a worker; returns the event WID.",
    businessProcess: { flow: "personal_information_change", step: "open" },
    inputSchemaStatus: "unknown", notes: "Takes the worker WID (param name not captured).",
  },
  {
    ...ssWrite, name: "submit_personal_information_changes", productArea: PERSONAL, category: "Personal Information Change",
    description: "Submits the staged personal-information change event.",
    businessProcess: { flow: "personal_information_change", step: "submit" },
    inputSchemaStatus: "unknown", notes: "Takes the event WID (param name not captured).",
  },
  // ---- writes: home contact change ----
  {
    ...ssWrite, name: "create_worker_home_contact_change", operationType: "CREATE", productArea: CONTACT, category: "Home Contact Change",
    description: 'Opens a home contact change event for "me"; returns the event WID.',
    businessProcess: { flow: "home_contact_change", step: "open" }, inputSchemaStatus: "unknown",
  },
  {
    ...ssWrite, name: "create_email_address_for_home_contact_change", operationType: "CREATE", productArea: CONTACT, category: "Home Contact Change",
    description: "Stages a new email address on a home contact change event.",
    businessProcess: { flow: "home_contact_change", step: "stage" },
    inputSchemaStatus: "unknown", notes: "Takes event WID and email WID (param names not captured).",
  },
  {
    ...ssWrite, name: "update_email_address_for_home_contact_change", operationType: "PATCH", productArea: CONTACT, category: "Home Contact Change",
    description: "Stages an email address update on a home contact change event.",
    businessProcess: { flow: "home_contact_change", step: "stage" },
    inputSchemaStatus: "unknown", notes: "Takes event WID and email WID (param names not captured).",
  },
  {
    ...ssWrite, name: "create_phone_number_for_home_contact_change", operationType: "CREATE", productArea: CONTACT, category: "Home Contact Change",
    description: "Stages a new phone number on a home contact change event.",
    businessProcess: { flow: "home_contact_change", step: "stage" },
    inputSchemaStatus: "unknown", notes: "Takes event WID and phone WID (param names not captured).",
  },
  {
    ...ssWrite, name: "update_phone_number_for_home_contact_change", operationType: "PATCH", productArea: CONTACT, category: "Home Contact Change",
    description: "Stages a phone number update on a home contact change event.",
    businessProcess: { flow: "home_contact_change", step: "stage" },
    inputSchemaStatus: "unknown", notes: "Takes event WID and phone WID (param names not captured).",
  },
  {
    ...ssWrite, name: "create_address_for_home_contact_change", operationType: "CREATE", productArea: CONTACT, category: "Home Contact Change",
    description: "Stages a new address on a home contact change event.",
    businessProcess: { flow: "home_contact_change", step: "stage" },
    inputSchemaStatus: "unknown", notes: "Takes event WID and address WID (param names not captured).",
  },
  {
    ...ssWrite, name: "update_address_on_home_contact_change", operationType: "PATCH", productArea: CONTACT, category: "Home Contact Change",
    description: "Stages an address update on a home contact change event.",
    businessProcess: { flow: "home_contact_change", step: "stage" },
    inputSchemaStatus: "unknown", notes: "Takes event WID and address WID (param names not captured).",
  },
  {
    ...ssWrite, name: "submit_home_contact_change", productArea: CONTACT, category: "Home Contact Change",
    description: "Submits the staged home contact change event.",
    businessProcess: { flow: "home_contact_change", step: "submit" },
    inputSchemaStatus: "unknown", notes: "Takes the event WID (param name not captured).",
  },
  // ---- writes: goals ----
  {
    ...ssWrite, name: "create_worker_goal_events", operationType: "CREATE", productArea: GOALS, category: "Goal Update",
    description: "Opens a worker goal event; returns the goal event WID.",
    businessProcess: { flow: "goal_progress", step: "open" }, inputSchemaStatus: "unknown",
  },
  {
    ...ssWrite, name: "edit_worker_goals", operationType: "PATCH", productArea: GOALS, category: "Goal Update",
    description: "Stages goal field edits on a goal event.",
    businessProcess: { flow: "goal_progress", step: "stage" },
    inputSchemaStatus: "unknown", notes: "Takes event WID, goal WID and the fields to change (names not captured).",
  },
  {
    ...ssWrite, name: "submit_worker_goal_events", productArea: GOALS, category: "Goal Update",
    description: "Submits the staged goal event.",
    businessProcess: { flow: "goal_progress", step: "submit" },
    inputSchemaStatus: "unknown", notes: "Takes the event WID (param name not captured).",
  },
];

// ---------------------------------------------------------------------------
// manager-actions-skill (Extend app peopletechHrBaseline_rjqhll), discovered 2026-10-20.
// 52 tools: 11 already catalogued above (tagged below), 41 new (35 reads, 6 writes).
// Mirror: extend/skills/manager-actions-skill.md
// ---------------------------------------------------------------------------

const MANAGER_ACTIONS_SKILL = "manager-actions-skill";
export const MANAGER_ACTIONS_DISCOVERY_SOURCE = `${TENANT_DISCOVERY_SOURCE} manager-actions-skill`;

/** Already-catalogued tools the manager-actions-skill also uses (tagged with the skill). */
export const MANAGER_ACTIONS_SHARED_TOOLS = [
  "find_absence_balances",
  "find_business_process_tasks",
  "find_service_dates_for_worker",
  "find_staffing_agent_supervisory_organization_members",
  "find_staffing_supervisory_organization",
  "find_staffing_workers",
  "find_worker_time_off_details",
  "list_organizations",
  "list_staffing_jobs",
  "list_worker_direct_reports",
  "list_worker_organizations",
] as const;

const tagShared = (tools: AgentReadyToolDefinition[]): AgentReadyToolDefinition[] =>
  tools.map((t) =>
    (MANAGER_ACTIONS_SHARED_TOOLS as readonly string[]).includes(t.name)
      ? { ...t, skills: [...(t.skills ?? []), MANAGER_ACTIONS_SKILL] }
      : t,
  );

const maRead = {
  kind: "basic",
  operationType: "VIEW",
  readOnly: true,
  wid: null, // not exposed by the Developer Agent UI — never invent
  source: MANAGER_ACTIONS_DISCOVERY_SOURCE,
  skills: [MANAGER_ACTIONS_SKILL],
} as const;
const maWrite = {
  kind: "advanced",
  readOnly: false,
  wid: null, // not exposed by the Developer Agent UI — never invent
  source: MANAGER_ACTIONS_DISCOVERY_SOURCE,
  skills: [MANAGER_ACTIONS_SKILL],
} as const;

const BP = "Business Process";
const EXPENSES = "Spend / Expenses";
const STAFFING = "Workforce / Staffing";
const RECRUITING = "Talent / Recruiting";
const PERF = "Talent / Performance";
const PAYROLL_INPUT = "Payroll / Payroll Input";
/** Reference lookup shorthand: no params captured. */
const lookup = (name: string, productArea: string, category: string, description: string): AgentReadyToolDefinition => ({
  ...maRead, name, productArea, category, description, inputSchemaStatus: "unknown",
});

export const MANAGER_ACTIONS_SKILL_TOOLS: AgentReadyToolDefinition[] = [
  // ---- reads: business process (5) ----
  { ...maRead, name: "find_business_process_event", productArea: BP, category: "Business Process Event",
    description: "Business process event detail.", inputSchemaStatus: "unknown" },
  { ...maRead, name: "find_business_process_event_step", productArea: BP, category: "Business Process Step",
    description: "A business process event step (incl. who it awaits).", inputSchemaStatus: "unknown",
    notes: "Takes an event WID (param name not captured)." },
  { ...maRead, name: "find_completed_steps_for_business_process_event", productArea: BP, category: "Business Process Step",
    description: "Completed steps of a business process event.", inputSchemaStatus: "unknown" },
  { ...maRead, name: "find_remaining_steps_for_business_process_event", productArea: BP, category: "Business Process Step",
    description: "Remaining steps of a business process event (approver chain).", inputSchemaStatus: "unknown",
    notes: "Source of the approvers shown in write previews." },
  lookup("list_staffing_business_process_types", BP, "Business Process Types", "Staffing business process types."),
  // ---- reads: expenses (2) ----
  { ...maRead, name: "find_expense_reports", productArea: EXPENSES, category: "Expense Reports",
    description: "Expense reports for a worker, filtered by status and date range.", inputSchemaStatus: "unknown",
    notes: "Filters: worker, status, date range (param names not captured)." },
  { ...maRead, name: "find_expense_lines", productArea: EXPENSES, category: "Expense Lines (sensitive)", sensitive: true,
    description: "Expense report lines.", inputSchemaStatus: "unknown" },
  // ---- reads: change job lookups (7) ----
  { ...maRead, name: "find_workers_to_initiate_change_job", productArea: STAFFING, category: "Change Job",
    description: "Workers the caller can initiate a change job for.", inputSchemaStatus: "unknown" },
  lookup("find_change_job_templates", STAFFING, "Change Job", "Change job templates."),
  lookup("find_job_profiles_for_change_job", STAFFING, "Change Job", "Job profiles valid for a change job."),
  lookup("find_locations_for_change_job", STAFFING, "Change Job", "Locations valid for a change job."),
  lookup("find_supervisory_organizations_for_change_job", STAFFING, "Change Job", "Supervisory orgs valid for a change job."),
  lookup("find_reasons_for_change_job", STAFFING, "Change Job", "Change job reasons."),
  lookup("find_employee_types_for_change_job", STAFFING, "Change Job", "Employee types valid for a change job."),
  // ---- reads: worker history (1) ----
  { ...maRead, name: "find_worker_history_events", productArea: STAFFING, category: "Worker History (sensitive)", sensitive: true,
    description: "Worker history events.", inputSchemaStatus: "unknown" },
  // ---- reads: recruiting (10) ----
  lookup("list_job_requisition_supervisory_organizations", RECRUITING, "Job Requisitions", "Supervisory orgs usable on job requisitions."),
  lookup("list_job_requisition_statuses", RECRUITING, "Job Requisitions", "Job requisition statuses."),
  lookup("list_job_requisition_types", RECRUITING, "Job Requisitions", "Job requisition types."),
  { ...maRead, name: "find_job_requisitions", productArea: RECRUITING, category: "Job Requisitions",
    description: "Job requisitions, filtered by supervisory organization and status.", inputSchemaStatus: "partial",
    params: [
      p("supervisoryOrganization", "WID", "Filter by supervisory organization."),
      p("status", "WID", "Filter by requisition status."),
    ] },
  { ...maRead, name: "find_in_progress_create_job_requisition_events", productArea: RECRUITING, category: "Job Requisitions",
    description: "In-progress create-job-requisition events.", inputSchemaStatus: "unknown" },
  { ...maRead, name: "find_my_candidates", productArea: RECRUITING, category: "Candidates",
    description: "The caller's candidates (or one by candidate ID).", inputSchemaStatus: "unknown",
    notes: "Accepts a candidate ID (param name not captured)." },
  lookup("list_my_candidate_candidate_stages", RECRUITING, "Candidates", "Candidate stages."),
  lookup("list_my_candidate_job_profiles", RECRUITING, "Candidates", "Candidate job profiles."),
  lookup("list_my_candidate_candidate_types", RECRUITING, "Candidates", "Candidate types."),
  lookup("list_my_candidate_job_families", RECRUITING, "Candidates", "Candidate job families."),
  // ---- reads: performance (4) ----
  { ...maRead, name: "find_performance_review", productArea: PERF, category: "Performance Review",
    description: "Performance reviews for a worker within a date range.", inputSchemaStatus: "unknown",
    notes: "Takes worker WID and date range (param names not captured)." },
  { ...maRead, name: "find_worker_from_my_team_to_filter_performance_review", productArea: PERF, category: "Performance Review",
    description: "Team workers to filter performance reviews by.", inputSchemaStatus: "unknown" },
  { ...maRead, name: "list_workers_for_initiate_performance_review", productArea: PERF, category: "Performance Review",
    description: "Workers (hierarchical orgs) a performance review can be initiated for.", inputSchemaStatus: "unknown" },
  { ...maRead, name: "find_worker_performance_review_template", productArea: PERF, category: "Performance Review",
    description: "Performance review templates for a review type.", inputSchemaStatus: "partial",
    params: [p("promptContext", "string", "Review type id.")] },
  // ---- reads: feedback (2) ----
  { ...maRead, name: "find_anytime_feedback_events", productArea: PERF, category: "Anytime Feedback",
    description: "Anytime feedback events.", inputSchemaStatus: "unknown" },
  { ...maRead, name: "find_worker_anytime_feedback_received", productArea: PERF, category: "Anytime Feedback (sensitive)", sensitive: true,
    description: "Anytime feedback a worker received.", inputSchemaStatus: "partial",
    params: [p("fromDate", "date", "Range start."), p("toDate", "date", "Range end.")],
    notes: "Also takes the worker WID (param name not captured)." },
  // ---- reads: learning (1) ----
  { ...maRead, name: "list_my_teams_learning_records", productArea: "Talent / Learning", category: "Team Learning",
    description: "Learning records of the caller's team.", inputSchemaStatus: "unknown" },
  // ---- reads: payroll input lookups (3) ----
  { ...maRead, name: "list_request_payroll_input_workers", productArea: PAYROLL_INPUT, category: "Payroll Input (sensitive)", sensitive: true,
    description: "Workers eligible for payroll input, with next pay period start.", inputSchemaStatus: "unknown" },
  { ...maRead, name: "list_request_payroll_input_pay_components", productArea: PAYROLL_INPUT, category: "Payroll Input",
    description: "Pay components valid for payroll input.", inputSchemaStatus: "partial",
    params: [p("effectiveDate", "date", "As-of date.")] },
  { ...maRead, name: "list_request_payroll_input_event_input_types_for_pay_component", productArea: PAYROLL_INPUT, category: "Payroll Input",
    description: "Input types for a pay component.", inputSchemaStatus: "partial",
    params: [p("payComponent", "WID", "Pay component.")] },

  // ---- writes (6) ----
  { ...maWrite, name: "approve_business_process_event_step", productArea: BP, category: "Approvals",
    description: "Approves a business process step awaiting the caller.",
    businessProcess: { flow: "approve_step", step: "submit" }, inputSchemaStatus: "partial",
    params: [p("comment", "string", "Optional comment.")], notes: "Takes the step WID (param name not captured)." },
  { ...maWrite, name: "deny_business_process_event_step", productArea: BP, category: "Approvals",
    description: "Denies a business process step awaiting the caller (comment required, max 256 chars).",
    businessProcess: { flow: "deny_step", step: "submit" }, inputSchemaStatus: "partial",
    params: [p("comment", "string (required, ≤256)", "Reason for denial.")], notes: "Takes the step WID (param name not captured)." },
  { ...maWrite, name: "initiate_change_job", operationType: "CREATE", productArea: STAFFING, category: "Change Job",
    description: "Initiates a change job for a worker; returns a job change ID and routes for approval.",
    businessProcess: { flow: "change_job", step: "submit" }, inputSchemaStatus: "unknown",
    notes: "Takes the worker WID (param name not captured). No PATCH field staging afterwards in this tenant." },
  { ...maWrite, name: "initiate_performance_review_for_employee", operationType: "CREATE", productArea: PERF, category: "Performance Review",
    description: "Initiates a performance review for an employee.",
    businessProcess: { flow: "performance_review", step: "submit" }, inputSchemaStatus: "partial",
    params: [
      p("reviewAboutWorker", "WID", "Worker the review is about."),
      p("reviewTemplate", "WID", "Review template."),
      p("startDate", "date", "Review period start."),
      p("endDate", "date", "Review period end."),
    ] },
  { ...maWrite, name: "create_anytime_feedback_events", operationType: "CREATE", productArea: PERF, category: "Anytime Feedback",
    description: "Gives anytime feedback to a worker (message, optional badge, competencies/goals, notify-manager flag).",
    businessProcess: { flow: "anytime_feedback", step: "submit" }, inputSchemaStatus: "unknown",
    notes: "Fields: target worker, message, optional badge, competencies/goals, notify manager flag (exact param names not captured)." },
  { ...maWrite, name: "request_payroll_input", operationType: "CREATE", productArea: PAYROLL_INPUT, category: "Payroll Input (sensitive, highest risk)", sensitive: true,
    description: "Requests a payroll input (one-time or ongoing) for a worker and pay component.",
    businessProcess: { flow: "payroll_input", step: "submit" }, inputSchemaStatus: "partial",
    securityDomains: ["Payroll (domain; 403 without it)"],
    params: [
      p("payrollInput.worker", "WID", "Worker."),
      p("payrollInput.payComponent", "WID", "Pay component."),
      p("payrollInput.startDate", "date YYYY-MM-DD", "Start/effective date."),
      p("payrollInput.ongoing", "boolean", "Ongoing input."),
      p("payrollInput.endDate", "date YYYY-MM-DD", "Required when ongoing=false."),
      p("payrollInput.inputDetails[].type", "WID", "Input type."),
      p("payrollInput.inputDetails[].value", "number", "Input value."),
      p("businessProcessParameters.action", "WID", "Business process action."),
    ],
    notes: "Admin/payroll-domain level; 403 if the caller lacks the payroll domain." },
];

/**
 * Every tenant-discovered tool: worker-data-skill 13 + self-service-skill 34 new +
 * manager-actions-skill 41 new = 88 (shared tools appear once, tagged with every skill).
 */
export const TENANT_DISCOVERED_TOOLS: AgentReadyToolDefinition[] = [
  ...tagShared(WORKER_DATA_SKILL_TOOLS),
  ...tagShared(SELF_SERVICE_SKILL_TOOLS),
  ...MANAGER_ACTIONS_SKILL_TOOLS,
];

/**
 * All tenant tools flagged sensitive: personal info, home address, payslips, dependents, legal name,
 * worker history, expense lines, feedback received, payroll input (request + eligible workers).
 */
export const SENSITIVE_TENANT_TOOLS: readonly string[] = TENANT_DISCOVERED_TOOLS.filter((t) => t.sensitive).map((t) => t.name);

/** Skill text references this tool, but it is not in the skill's tool list (known gap). */
export const KNOWN_TOOL_GAPS = [
  {
    skill: SELF_SERVICE_SKILL,
    tool: "update_personal_information_marital_status",
    note: "Referenced as the stage step of personal_information_change but missing from the skill's tool list; add it in the Developer Agent, then catalogue it.",
  },
] as const;
