/**
 * TENANT-DISCOVERED Agent-Ready tools (worker-data, self-service, manager-actions, hr-partner, payroll-viewer, admin skills) (hand-maintained, kept separate from the generated seed
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
    notes: "Pass the payslip owner as contextInstanceId. Native tool is self-service server-side: the tenant returns only the caller's own payslips until a payroll-admin data source / Custom Agent Action exists.",
  },
  {
    ...ssRead, name: "find_payslip_summary", productArea: PAYROLL, category: "Payslips (sensitive)", sensitive: true,
    description: "Payslip summary (payment date, period, gross, net, YTD).",
    inputSchemaStatus: "unknown", notes: "Takes a payslip WID (param name not captured); pass the owner as contextInstanceId. Native tool is self-service server-side: the tenant returns only the caller's own payslips until a payroll-admin data source / Custom Agent Action exists.",
  },
  {
    ...ssRead, name: "find_payslip_details", productArea: PAYROLL, category: "Payslips (sensitive)", sensitive: true,
    description: "Payslip details: earnings, taxes, deductions, employer-paid benefits.",
    inputSchemaStatus: "unknown", notes: "Takes a payslip WID (param name not captured); pass the owner as contextInstanceId. Native tool is self-service server-side: the tenant returns only the caller's own payslips until a payroll-admin data source / Custom Agent Action exists.",
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

// ---------------------------------------------------------------------------
// hr-partner-skill (Extend app peopletechHrBaseline_rjqhll), discovered 2026-10-20.
// 49 tools: 28 already catalogued (the notes do not list which, so they are NOT tagged with
// this skill), 21 new (10 reads, 11 writes). Mirror: extend/skills/hr-partner-skill.md
// Gap: passport/visa and government-identifier writes run "within an open change event", but
// no tool to OPEN such an event is exposed — the guard requires an externally supplied event WID.
// ---------------------------------------------------------------------------

const HR_PARTNER_SKILL = "hr-partner-skill";
export const HR_PARTNER_DISCOVERY_SOURCE = `${TENANT_DISCOVERY_SOURCE} hr-partner-skill`;

const hrRead = {
  kind: "basic",
  operationType: "VIEW",
  readOnly: true,
  wid: null, // not exposed by the Developer Agent UI — never invent
  source: HR_PARTNER_DISCOVERY_SOURCE,
  skills: [HR_PARTNER_SKILL],
} as const;
const hrWrite = {
  kind: "advanced",
  readOnly: false,
  wid: null, // not exposed by the Developer Agent UI — never invent
  source: HR_PARTNER_DISCOVERY_SOURCE,
  skills: [HR_PARTNER_SKILL],
} as const;
const ORGS = "Workforce / Organizations";
const IDS = "Workforce / Personal Data / Identifiers";
const ID_GAP_NOTE = "Runs within an open change event; no open-event tool is exposed (gap) — event WID must be supplied.";
const idWrite = (
  name: string,
  operationType: "CREATE" | "PATCH",
  flow: "passport_visa_change" | "government_id_change",
  description: string,
): AgentReadyToolDefinition => ({
  ...hrWrite, name, operationType, productArea: IDS, category: "Identifiers (special category)",
  sensitive: true, specialCategory: true, description,
  businessProcess: { flow, step: "stage" }, inputSchemaStatus: "unknown", notes: ID_GAP_NOTE,
});

export const HR_PARTNER_SKILL_TOOLS: AgentReadyToolDefinition[] = [
  // ---- reads (10) ----
  { ...hrRead, name: "find_org_chart_organizations", productArea: ORGS, category: "Org Chart",
    description: "Search organizations by name (org chart).", inputSchemaStatus: "unknown" },
  { ...hrRead, name: "get_org_chart_children", productArea: ORGS, category: "Org Chart",
    description: "Sub-organizations of an organization.", inputSchemaStatus: "unknown" },
  { ...hrRead, name: "get_org_chart_parent", productArea: ORGS, category: "Org Chart",
    description: "Parent organization of an organization.", inputSchemaStatus: "unknown" },
  { ...hrRead, name: "list_organization_members", productArea: ORGS, category: "Organization Members",
    description: "Members of any organization type (cost centers, supervisory orgs, etc.).", inputSchemaStatus: "unknown" },
  { ...hrRead, name: "list_leave_event_statuses", productArea: "Workforce / Absence", category: "Leave of Absence",
    description: "Leave event status WIDs (e.g. In Progress).", inputSchemaStatus: "unknown" },
  { ...hrRead, name: "list_time_off_entry_statuses", productArea: "Workforce / Absence", category: "Time Off",
    description: "Time-off entry status WIDs.", inputSchemaStatus: "unknown" },
  { ...hrRead, name: "list_onboarding_business_process_tasks", productArea: "Business Process / Onboarding", category: "Onboarding",
    description: "Onboarding tasks for the signed-in user or a new hire.", inputSchemaStatus: "unknown" },
  { ...hrRead, name: "list_worker_history_events", productArea: "Workforce / Staffing", category: "Worker History (sensitive)", sensitive: true,
    description: "Business-process history of a worker, filterable by BP type (distinct from find_worker_history_events).",
    inputSchemaStatus: "unknown" },
  { ...hrRead, name: "find_ethnicity", productArea: "Workforce / Personal Data", category: "Ethnicity (special category)",
    sensitive: true, specialCategory: true, description: "Ethnicity lookup values.", inputSchemaStatus: "unknown",
    notes: "GDPR Art. 9 special-category data; diversity output is aggregate-only." },
  { ...hrRead, name: "find_ethnicity_details", productArea: "Workforce / Personal Data", category: "Ethnicity (special category)",
    sensitive: true, specialCategory: true, description: "Ethnicity lookup value details.", inputSchemaStatus: "unknown",
    notes: "GDPR Art. 9 special-category data; diversity output is aggregate-only." },
  // ---- writes (11) ----
  { ...hrWrite, name: "request_worker_leave_of_absence", operationType: "CREATE", productArea: "Workforce / Absence", category: "Leave of Absence",
    description: "Requests a leave of absence for a worker (leave type from find_worker_eligible_absence_types, start, end, reason).",
    businessProcess: { flow: "leave_of_absence", step: "submit" }, inputSchemaStatus: "unknown",
    notes: "Fields: worker, leave type, start, end, reason (exact param names not captured)." },
  idWrite("create_passport_ids", "CREATE", "passport_visa_change", "Stages a new passport ID on an open change event."),
  idWrite("update_passport_ids", "PATCH", "passport_visa_change", "Stages a passport ID update on an open change event."),
  idWrite("create_visa_ids", "CREATE", "passport_visa_change", "Stages a new visa ID on an open change event."),
  idWrite("update_visa_ids", "PATCH", "passport_visa_change", "Stages a visa ID update on an open change event."),
  { ...hrWrite, name: "submit_passport_and_visa_changes", productArea: IDS, category: "Identifiers (special category)",
    sensitive: true, specialCategory: true, description: "Submits staged passport and visa changes.",
    businessProcess: { flow: "passport_visa_change", step: "submit" }, inputSchemaStatus: "unknown", notes: ID_GAP_NOTE },
  idWrite("create_national_ids", "CREATE", "government_id_change", "Stages a new national ID on an open change event."),
  idWrite("update_national_ids", "PATCH", "government_id_change", "Stages a national ID update on an open change event."),
  idWrite("create_government_ids", "CREATE", "government_id_change", "Stages a new government ID on an open change event."),
  idWrite("update_government_ids", "PATCH", "government_id_change", "Stages a government ID update on an open change event."),
  { ...hrWrite, name: "submit_government_identifier_changes", productArea: IDS, category: "Identifiers (special category)",
    sensitive: true, specialCategory: true, description: "Submits staged national/government identifier changes.",
    businessProcess: { flow: "government_id_change", step: "submit" }, inputSchemaStatus: "unknown", notes: ID_GAP_NOTE },
];

// ---------------------------------------------------------------------------
// payroll-viewer-skill (Extend app peopletechHrBaseline_rjqhll), discovered 2026-10-20.
// 26 tools, all reads: 4 already catalogued (tagged below), 22 new. Mirror (verbatim skill
// text): extend/skills/payroll-viewer-skill.md. The skill is read-only: it never grants
// request_payroll_input or any other payroll write.
// ---------------------------------------------------------------------------

export const PAYROLL_VIEWER_SKILL = "payroll-viewer-skill";
export const PAYROLL_VIEWER_DISCOVERY_SOURCE = `${TENANT_DISCOVERY_SOURCE} payroll-viewer-skill`;

/** Already-catalogued tools the payroll-viewer-skill also uses (tagged with the skill). */
export const PAYROLL_VIEWER_SHARED_TOOLS = [
  "find_payslips", // self-service-skill
  "find_payslip_summary", // self-service-skill
  "list_request_payroll_input_workers", // manager-actions-skill
  "list_request_payroll_input_pay_components", // manager-actions-skill
] as const;

/** Writes the skill text explicitly puts out of scope. Never granted through this skill. */
export const PAYROLL_VIEWER_DECLINED_WRITES = [
  "request_payroll_input",
  "create_payroll_inputs", // named in the skill text, not catalogued
  "edit_payroll_inputs", // named in the skill text, not catalogued
] as const;

const tagPayrollViewer = (tools: AgentReadyToolDefinition[]): AgentReadyToolDefinition[] =>
  tools.map((t) =>
    (PAYROLL_VIEWER_SHARED_TOOLS as readonly string[]).includes(t.name)
      ? { ...t, skills: [...(t.skills ?? []), PAYROLL_VIEWER_SKILL] }
      : t,
  );

const pvRead = {
  kind: "basic",
  operationType: "VIEW",
  readOnly: true,
  wid: null, // not exposed by the Developer Agent UI — never invent
  source: PAYROLL_VIEWER_DISCOVERY_SOURCE,
  skills: [PAYROLL_VIEWER_SKILL],
  inputSchemaStatus: "unknown",
} as const;
const PAY_GROUPS = "Payroll / Pay Groups";
const PAY_RESULTS = "Payroll / Pay Results";
const RETRO = "Payroll / Retro";
const YEAR_END = "Payroll / Year-End Tax";
const SELF_NOTE = "Self-service: signed-in worker only (pass \"me\"); any other worker id is refused before the call.";
const PG_NOTE = "Pay group / pay group detail IDs must come from an earlier find_pay_groups / find_pay_group_details call (src/rbac/pay-group-scope.ts).";

export const PAYROLL_VIEWER_SKILL_TOOLS: AgentReadyToolDefinition[] = [
  // ---- pay groups (scope: accessible pay groups) ----
  { ...pvRead, name: "find_pay_groups", productArea: PAY_GROUPS, category: "Pay Groups",
    description: "Pay groups visible to the caller (Set Up: Payroll - Pay Group Specific); one pay group by contextInstanceId.",
    inputSchemaStatus: "partial", securityDomains: ["Set Up: Payroll - Pay Group Specific"],
    params: [
      p("contextInstanceId", "WID", "Pay group WID (omit to list all visible pay groups)."),
      p("country", "WID", "Filter by country."),
    ],
    notes: "Omit contextInstanceId to list; a supplied ID must have been listed earlier. " + PG_NOTE },
  { ...pvRead, name: "find_pay_group_details", productArea: PAY_GROUPS, category: "Pay Group Details",
    description: "Pay group detail: run category, period schedule (periodSchedule), processing periods (processingPeriods), pay run groups.",
    inputSchemaStatus: "partial", securityDomains: ["Set Up: Payroll - Pay Group Specific"],
    params: [p("runCategories", "WID[]", "Filter by run category (resolve via payroll_run_categories_prompt).")],
    notes: "Takes the pay group detail WID (param name not captured). Doubles as the payroll calendar. " + PG_NOTE },
  { ...pvRead, name: "payroll_run_categories_prompt", productArea: PAY_GROUPS, category: "Run Categories (prompt-like lookup)",
    description: "Resolves run category WIDs (filter for find_pay_group_details)." },
  { ...pvRead, name: "payroll_run_payroll_calculation_pay_run_group_selections_prompt", productArea: PAY_GROUPS, category: "Pay Run Groups (prompt-like lookup)",
    description: "Active pay run group selections eligible for a regular (on-cycle) payroll calculation run." },
  { ...pvRead, name: "payroll_off_cycle_pay_pay_run_group_selections_prompt", productArea: PAY_GROUPS, category: "Off-Cycle (prompt-like lookup)",
    description: "Pay run group selections eligible for off-cycle pay." },
  { ...pvRead, name: "payroll_off_cycle_pay_calculation_periods_prompt", productArea: PAY_GROUPS, category: "Off-Cycle (prompt-like lookup)",
    description: "Valid off-cycle calculation periods for the selected pay run group.",
    notes: "Takes the selected pay run group (param name not captured)." },
  // ---- pay results by group and period ----
  { ...pvRead, name: "payroll_payroll_results_for_pay_group_detail_and_period_prompt", productArea: PAY_RESULTS, category: "Pay Results (sensitive)",
    sensitive: true,
    description: "Payroll results for a pay group detail and period (primary result-browsing tool).",
    notes: "Takes pay group detail + period (param names not captured). Response is shaped by src/safety/pay-results.ts: " +
      "summary (count + statuses) unless a payroll_viewer or admin explicitly asks for worker-level lines. " + PG_NOTE },
  { ...pvRead, name: "payroll_result_calculation_statuses_prompt", productArea: PAY_RESULTS, category: "Calculation Statuses (prompt-like lookup)",
    description: "Payroll result calculation statuses (off-cycle contexts)." },
  { ...pvRead, name: "payroll_result_calculation_statuses_all_statuses_prompt", productArea: PAY_RESULTS, category: "Calculation Statuses (prompt-like lookup)",
    description: "Payroll result calculation statuses (all contexts)." },
  // ---- payroll input records (read) ----
  { ...pvRead, name: "find_payroll_inputs", productArea: PAYROLL_INPUT, category: "Payroll Input (sensitive)", sensitive: true,
    description: "Reads a payroll input instance: worker, pay component, start/end date, input type, value, status.",
    notes: "Takes the payroll input WID (param name not captured); pass the input's worker as contextInstanceId. Read-only." },
  { ...pvRead, name: "payroll_input_types_prompt", productArea: PAYROLL_INPUT, category: "Payroll Input (prompt-like lookup)",
    description: "Valid input types for a selected pay component.",
    inputSchemaStatus: "partial", params: [p("payComponent", "WID", "Pay component (param name not captured; the skill says 'with the pay component WID').")],
    notes: "Overlaps list_request_payroll_input_event_input_types_for_pay_component (manager-actions-skill); different tool name, catalogued separately." },
  // ---- retro (read-only browsing; never launches a retro calculation) ----
  { ...pvRead, name: "list_retro_results_pay_run_group_selections", productArea: RETRO, category: "Retro Results",
    description: "Pay run group selections the caller can access for retro worker result review (WID = payRunGroupSelectionId)." },
  { ...pvRead, name: "list_retro_calc_pay_run_group_selections", productArea: RETRO, category: "Retro Calculation",
    description: "Pay run groups eligible for a retro calculation (payroll admin context; browse only)." },
  { ...pvRead, name: "list_retro_event_categories", productArea: RETRO, category: "Retro Calculation",
    description: "Retro event categories for a pay run group.",
    inputSchemaStatus: "partial", params: [p("payRunGroupSelectionParm", "WID", "From list_retro_calc_pay_run_group_selections.")] },
  { ...pvRead, name: "list_retro_calculation_statuses", productArea: RETRO, category: "Retro Calculation",
    description: "Calculation statuses for a pay run group selection.",
    inputSchemaStatus: "partial", params: [p("payRunGroupSelectionParm", "WID", "From list_retro_calc_pay_run_group_selections.")] },
  // ---- self-service (signed-in worker only) ----
  { ...pvRead, name: "find_worker_next_payroll_payment_date", productArea: PAYROLL, category: "Next Payment Date",
    description: "The signed-in worker's next on-cycle payroll payment date.", notes: SELF_NOTE },
  { ...pvRead, name: "list_countries_for_worker_pay_group", productArea: PAYROLL, category: "Worker Pay Group Context",
    description: "Countries of the signed-in worker's pay group(s).", notes: SELF_NOTE },
  { ...pvRead, name: "list_companies_for_worker", productArea: PAYROLL, category: "Worker Pay Group Context",
    description: "Companies in scope for the signed-in worker's pay.", notes: SELF_NOTE },
  { ...pvRead, name: "list_countries_for_worker_year_end_tax_documents", productArea: YEAR_END, category: "Year-End Tax Documents",
    description: "Countries with year-end tax documents for the signed-in worker.", notes: SELF_NOTE },
  { ...pvRead, name: "list_report_types_for_worker_year_end_tax_documents", productArea: YEAR_END, category: "Year-End Tax Documents",
    description: "Year-end tax form types available to the signed-in worker (e.g. W-2, T4, P60).", notes: SELF_NOTE },
  { ...pvRead, name: "list_companies_for_worker_year_end_tax_documents", productArea: YEAR_END, category: "Year-End Tax Documents",
    description: "Companies on the signed-in worker's year-end tax documents.", notes: SELF_NOTE },
  { ...pvRead, name: "find_tax_form_box_details", productArea: YEAR_END, category: "Tax Form Boxes (sensitive)", sensitive: true,
    description: "The signed-in worker's tax form box amounts (tax year, form type, company, payroll tax authority, boxes).",
    inputSchemaStatus: "partial",
    params: [
      p("country", "WID", "Filter by country."),
      p("reportType", "WID", "Filter by form type."),
      p("startDate", "date", "Filter by start date."),
      p("company", "WID", "Filter by company."),
    ],
    notes: SELF_NOTE },
];

/**
 * Payslip reads (find_payslip_details is self-service-skill only): every role reads its own;
 * payroll_viewer also reads workers in its pay group(s); admin reads all. NOTE: Workday's native
 * tools are self-service server-side, so the tenant still returns only the caller's own payslips
 * until a payroll-admin data source or Custom Agent Action exists.
 */
export const PAYSLIP_TOOLS = ["find_payslips", "find_payslip_summary", "find_payslip_details"] as const;

/** payroll-viewer-skill tools that are self-only for EVERY role (incl. admin): caller's own record. */
export const PAYROLL_SELF_ONLY_TOOLS = [
  "find_worker_next_payroll_payment_date",
  "find_tax_form_box_details",
  "list_countries_for_worker_year_end_tax_documents",
  "list_report_types_for_worker_year_end_tax_documents",
  "list_companies_for_worker_year_end_tax_documents",
  "list_countries_for_worker_pay_group",
  "list_companies_for_worker",
] as const;

/** payroll-viewer-skill pay group tools: payroll_viewer (pay-group proof) + admin. */
export const PAY_GROUP_TOOLS = [
  "find_pay_groups",
  "find_pay_group_details",
  "payroll_run_categories_prompt",
  "payroll_run_payroll_calculation_pay_run_group_selections_prompt",
  "payroll_off_cycle_pay_pay_run_group_selections_prompt",
  "payroll_off_cycle_pay_calculation_periods_prompt",
  "payroll_payroll_results_for_pay_group_detail_and_period_prompt",
  "payroll_result_calculation_statuses_prompt",
  "payroll_result_calculation_statuses_all_statuses_prompt",
  "list_retro_results_pay_run_group_selections",
  "list_retro_calc_pay_run_group_selections",
  "list_retro_event_categories",
  "list_retro_calculation_statuses",
] as const;

/** payroll-viewer-skill payroll input reads (payroll_viewer + admin for the new ones). */
export const PAYROLL_INPUT_VIEW_TOOLS = [
  "find_payroll_inputs",
  "list_request_payroll_input_workers",
  "list_request_payroll_input_pay_components",
  "payroll_input_types_prompt",
] as const;

// ---------------------------------------------------------------------------
// admin-skill (Extend app peopletechHrBaseline_rjqhll), discovered 2026-10-20.
// 92 tools from a scrolled screenshot (rows above the first visible one may be missing):
// 80 reads + 12 writes. 71 already catalogued (all tagged below, incl. the 12 self-service
// writes), 21 new (all reads). Mirror (verbatim skill text): extend/skills/admin-skill.md
// Admin: full tenant-wide read; writes self-only through src/safety/native-write-guard.ts.
// ---------------------------------------------------------------------------

export const ADMIN_SKILL = "admin-skill";
export const ADMIN_DISCOVERY_SOURCE = `${TENANT_DISCOVERY_SOURCE} admin-skill`;

/** Already-catalogued tools the admin-skill also uses (tagged with the skill). */
export const ADMIN_SHARED_TOOLS = [
  // writes (12): self-service staged writes, self-only
  "create_address_for_home_contact_change", "create_email_address_for_home_contact_change",
  "create_personal_information_change_event", "create_phone_number_for_home_contact_change",
  "create_worker_home_contact_change", "create_worker_time_off_request", "submit_home_contact_change",
  "submit_personal_information_changes", "update_address_on_home_contact_change",
  "update_email_address_for_home_contact_change", "update_phone_number_for_home_contact_change",
  "update_worker_time_off_entry",
  // reads (59)
  "find_absence_balances", "find_anytime_feedback_events", "find_business_process_event", "find_business_process_event_step",
  "find_business_process_tasks", "find_completed_steps_for_business_process_event", "find_continue_learning",
  "find_detailed_personal_information_change_event", "find_ethnicity", "find_ethnicity_details", "find_goal_status",
  "find_in_progress_create_job_requisition_events", "find_job_requisitions", "find_learning_transcript", "find_my_candidates",
  "find_org_chart_organizations", "find_org_chart_workers", "find_payslip_details", "find_payslip_summary", "find_payslips",
  "find_performance_review", "find_plan_assignments", "find_remaining_steps_for_business_process_event",
  "find_service_dates_for_worker", "find_staffing_agent_supervisory_organization_members",
  "find_staffing_supervisory_organization", "find_staffing_workers", "find_tax_form_box_details",
  "find_worker_anytime_feedback_received", "find_worker_eligible_absence_types", "find_worker_legal_name",
  "find_worker_next_payroll_payment_date", "find_worker_personal_information", "find_worker_time_off_details",
  "find_worker_valid_time_off_dates", "get_learning_content", "get_org_chart_children", "get_org_chart_parent",
  "list_job_requisition_statuses", "list_job_requisition_supervisory_organizations", "list_leave_event_statuses",
  "list_my_candidate_candidate_stages", "list_my_candidate_candidate_types", "list_my_candidate_job_families",
  "list_my_candidate_job_profiles", "list_my_goals", "list_my_teams_learning_records", "list_onboarding_business_process_tasks",
  "list_organization_members", "list_organizations", "list_staffing_business_process_types", "list_staffing_jobs",
  "list_time_off_entry_statuses", "list_worker_addresses", "list_worker_direct_reports", "list_worker_email_addresses",
  "list_worker_history_events", "list_worker_organizations", "list_worker_phone_numbers",
] as const;

/**
 * Hard refusals (admin-skill Rule 4): admin never gets these writes through this skill.
 * Matched against write tool names; any catalogued write that matches is never granted to
 * admin beyond "self" and is not tagged with the admin-skill.
 */
export const ADMIN_HARD_REFUSALS = [
  { category: "compensation", pattern: /compensation|grade|salary|bonus|merit|stipend|allowance/ },
  { category: "termination", pattern: /terminat|rehire|separation|retire/ },
  { category: "hire", pattern: /hire|pre_hire|prehire|onboard|applicant_to_worker/ },
  { category: "org change", pattern: /organization|supervisory_org|reorg|cost_center|company/ },
  { category: "security change", pattern: /security|role|domain|permission|user_account/ },
  { category: "job change for another worker", pattern: /change_job|job|position|transfer|promot|demot/ },
] as const;

const adminRead = {
  kind: "basic",
  operationType: "VIEW",
  readOnly: true,
  wid: null, // not exposed by the Developer Agent UI — never invent
  source: ADMIN_DISCOVERY_SOURCE,
  skills: [ADMIN_SKILL],
  inputSchemaStatus: "unknown",
} as const;
const aRead = (name: string, productArea: string, category: string, description: string, extra: Partial<AgentReadyToolDefinition> = {}): AgentReadyToolDefinition => ({
  ...adminRead, name, productArea, category, description, ...extra,
});

export const ADMIN_SKILL_TOOLS: AgentReadyToolDefinition[] = [
  // ---- worker profile / job / history ----
  aRead("find_worker_preferred_name", PERSONAL, "Preferred Name", "A worker's preferred name."),
  aRead("list_worker_web_addresses", CONTACT, "Contact", "Web addresses of a worker."),
  aRead("find_talent_profile_worker_job_history", "Talent / Profile", "Job History", "Past roles from the worker's talent profile."),
  aRead("find_worker_education_records", "Talent / Profile", "Education", "Education history from the worker's talent profile."),
  aRead("get_positions", STAFFING, "Positions", "Position metadata."),
  aRead("get_job_profiles", STAFFING, "Job Profiles", "Job profile metadata."),
  aRead("find_job_profiles", STAFFING, "Job Profiles", "Job profiles by job family."),
  // ---- tax documents ----
  aRead("find_worker_w2s", "Payroll / Year-End Tax", "W-2 (sensitive)", "A worker's W-2 tax documents.", {
    sensitive: true,
    notes: "Likely self-service server-side like the other year-end tax tools. May carry a national ID (SSN): responses pass the sensitive field gate (src/safety/sensitive-fields.ts).",
  }),
  // ---- org hierarchy / worktags ----
  aRead("find_org_chart_navigable", ORGS, "Org Chart", "Raw navigable org chart node data."),
  aRead("get_worktag_values", "Financials / Worktags", "Worktags", "Worktag values (e.g. cost center WIDs)."),
  aRead("list_worktag_type_configurations", "Financials / Worktags", "Worktags", "Worktag type configurations."),
  // ---- compensation reference (read only; never stage compensation changes) ----
  aRead("get_compensation_grades", "Compensation", "Compensation Grades (reference)", "Compensation grade reference data. Read only; compensation changes are refused."),
  aRead("get_compensation_grade_profiles", "Compensation", "Compensation Grades (reference)", "Compensation grade profile reference data. Read only."),
  // ---- business process ----
  aRead("find_in_progress_steps_for_business_process_event", BP, "Business Process Step", "Currently active steps of a business process event."),
  aRead("find_comments_for_business_process_event", BP, "Business Process Event", "Comments on a business process event."),
  aRead("find_attachments_for_business_process_event", BP, "Business Process Event (sensitive)", "Attachments on a business process event.", {
    sensitive: true, notes: "Attachments can hold any document (IDs, contracts); pass through the sensitive field gate.",
  }),
  aRead("find_home_contact_change_event", CONTACT, "Home Contact Change", "Reads a home contact change event (staged values before preview).", {
    notes: "Read step inside home_contact_change.",
  }),
  // ---- recruiting / feedback ----
  aRead("find_internal_job_postings", RECRUITING, "Job Postings", "Employee-visible internal job postings."),
  aRead("find_feedback_events_awaiting_me", PERF, "Anytime Feedback", "Feedback requests awaiting the signed-in user."),
  // ---- demographic reference (aggregate-only when about more than one worker) ----
  aRead("list_active_genders", PERSONAL, "Demographics (reference)", "Active gender reference values.", {
    notes: "Demographic: any multi-worker use goes through the aggregate-only filter (src/safety/diversity.ts).",
  }),
  aRead("list_active_marital_statuses", PERSONAL, "Demographics (reference)", "Active marital status reference values.", {
    notes: "Demographic: any multi-worker use goes through the aggregate-only filter (src/safety/diversity.ts).",
  }),
];

/** admin-skill reference lookups (no worker / org target). */
export const ADMIN_LOOKUP_TOOLS = [
  "get_positions", "get_job_profiles", "find_job_profiles", "get_worktag_values", "list_worktag_type_configurations",
  "get_compensation_grades", "get_compensation_grade_profiles", "find_internal_job_postings",
  "list_active_genders", "list_active_marital_statuses",
] as const;

const tagAdmin = (tools: AgentReadyToolDefinition[]): AgentReadyToolDefinition[] =>
  tools.map((t) =>
    (ADMIN_SHARED_TOOLS as readonly string[]).includes(t.name) ? { ...t, skills: [...(t.skills ?? []), ADMIN_SKILL] } : t,
  );

/**
 * Every tenant-discovered tool: worker-data-skill 13 + self-service-skill 34 new +
 * manager-actions-skill 41 new + hr-partner-skill 21 new + payroll-viewer-skill 22 new +
 * admin-skill 21 new = 152 (shared tools appear once).
 */
export const TENANT_DISCOVERED_TOOLS: AgentReadyToolDefinition[] = tagAdmin(tagPayrollViewer([
  ...tagShared(WORKER_DATA_SKILL_TOOLS),
  ...tagShared(SELF_SERVICE_SKILL_TOOLS),
  ...MANAGER_ACTIONS_SKILL_TOOLS,
  ...HR_PARTNER_SKILL_TOOLS,
  ...PAYROLL_VIEWER_SKILL_TOOLS,
  ...ADMIN_SKILL_TOOLS,
]));

/** Special-category tools (ethnicity, passport/visa/national/government IDs). */
export const SPECIAL_CATEGORY_TENANT_TOOLS: readonly string[] = TENANT_DISCOVERED_TOOLS.filter((t) => t.specialCategory).map((t) => t.name);

/**
 * All tenant tools flagged sensitive: personal info, home address, payslips, dependents, legal name,
 * worker history, expense lines, feedback received, payroll input (request + eligible workers + input records),
 * pay results by pay group/period, tax form box amounts, W-2s, BP event attachments.
 */
export const SENSITIVE_TENANT_TOOLS: readonly string[] = TENANT_DISCOVERED_TOOLS.filter((t) => t.sensitive).map((t) => t.name);

/** Skill text references this tool, but it is not in the skill's tool list (known gap). */
export const KNOWN_TOOL_GAPS = [
  {
    skill: SELF_SERVICE_SKILL,
    tool: "update_personal_information_marital_status",
    note: "Referenced as the stage step of personal_information_change but missing from the skill's tool list; add it in the Developer Agent, then catalogue it.",
  },
  {
    skill: HR_PARTNER_SKILL,
    tool: "(open passport/visa or government-identifier change event)",
    note: "ID writes run within an open change event, but no open-event tool is exposed; the guard requires an externally supplied event WID.",
  },
] as const;
