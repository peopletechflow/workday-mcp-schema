/**
 * TENANT-DISCOVERED Agent-Ready tools (hand-maintained, kept separate from the generated seed
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

/** Shared fields for every tool in the worker-data-skill (read-only, WID unknown). */
const base = {
  kind: "basic",
  operationType: "VIEW",
  readOnly: true,
  wid: null, // WID not exposed by the Developer Agent UI — fill from ASOR, never invent.
  source: TENANT_DISCOVERY_SOURCE,
} as const;

export const TENANT_DISCOVERED_TOOLS: AgentReadyToolDefinition[] = [
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
    productArea: "Workforce / Worker Data",
    category: "Contact",
    description: "Phone numbers of a worker.",
    inputSchemaStatus: "unknown",
  },
];

/** Tools that expose sensitive personal data: never granted to `manager`. */
export const SENSITIVE_TENANT_TOOLS = ["find_worker_personal_information", "list_worker_addresses"] as const;
