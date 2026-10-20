/** Smoke check: every registered tool has an RBAC mapping and enforcement behaves. Run: npm run check:rbac */
import { TOOL_REGISTRY, assertRegistryInvariants } from "../src/tools/registry.js";
import {
  AGENT_READY_RECIPE_PERMISSIONS,
  AGENT_READY_TOOL_PERMISSIONS,
  assertAgentReadyCallAllowed,
  assertToolAllowed,
  RbacDeniedError,
  ROLE_DESCRIPTIONS,
  isAgentReadyWrite,
  targetKindFor,
  verifyTeamScope,
  verifyOrgScope,
  verifyWorkerInOrgScope,
  filterToOrgScope,
  ORG_PROOF_REQUIRED,
  ROLES,
  TOOL_PERMISSIONS,
  type AgentReadyCallContext,
  type Role,
} from "../src/rbac/index.js";
import {
  AGENT_READY_CATALOG,
  AGENT_READY_RECIPES,
  INDIRECT_REPORTS_MAX_DEPTH,
  listIndirectReports,
  MANAGER_CHAIN_MAX_HOPS,
  resolveManagerChain,
  KNOWN_TOOL_GAPS,
  SELF_SERVICE_DISCOVERY_SOURCE,
  SELF_SERVICE_SKILL_TOOLS,
  SENSITIVE_TENANT_TOOLS,
  SENSITIVE_WORKER_DATA_TOOLS,
  MANAGER_ACTIONS_DISCOVERY_SOURCE,
  MANAGER_ACTIONS_SKILL_TOOLS,
  HR_PARTNER_DISCOVERY_SOURCE,
  HR_PARTNER_SKILL_TOOLS,
  SPECIAL_CATEGORY_TENANT_TOOLS,
  DIVERSITY_MIN_GROUP_SIZE,
  TENANT_DISCOVERED_TOOLS,
  TENANT_DISCOVERY_SOURCE,
  WORKER_DATA_SKILL_TOOLS,
} from "../src/agent-ready/index.js";
import {
  commitNativeWrite,
  NATIVE_WRITE_FLOWS,
  previewNativeWrite,
  type StagedWritePlan,
} from "../src/safety/native-write-guard.js";
import { PreviewStore } from "../src/safety/preview-store.js";
import { IdempotencyStore } from "../src/safety/idempotency.js";
import { aggregateBuckets, computeDiversityAggregate } from "../src/safety/diversity.js";

let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.error(`FAIL ${name}: ${e instanceof Error ? e.message : e}`); }
};
check("registry invariants incl. RBAC coverage", () => assertRegistryInvariants(TOOL_REGISTRY.map((t) => t.name)));
for (const t of TOOL_REGISTRY) check(`mapped: ${t.name}`, () => { if (!TOOL_PERMISSIONS[t.name]?.length) throw new Error("no roles"); });
check("worker_self denied manager approve", () => {
  try { assertToolAllowed(["worker_self"], "commit_approve_time_off"); } catch (e) { if (e instanceof RbacDeniedError) return; throw e; }
  const approve = TOOL_REGISTRY.find((t) => /approve/.test(t.name) && t.toolClass === "write-commit")!;
  try { assertToolAllowed(["worker_self"], approve.name); } catch (e) { if (e instanceof RbacDeniedError) return; throw e; }
  throw new Error("expected denial");
});
check("unmapped tool fails closed", () => {
  try { assertToolAllowed(["admin", "manager", "worker_self"], "__unmapped__"); } catch (e) { if (e instanceof RbacDeniedError) return; throw e; }
  throw new Error("expected denial");
});

// ---- Layer-1 tenant-discovered Agent-Ready tools ----
const denied = (roles: Role[], tool: string, ctx: AgentReadyCallContext = {}) => {
  try { assertAgentReadyCallAllowed(roles, tool, ctx); } catch (e) { if (e instanceof RbacDeniedError) return; throw e; }
  throw new Error(`expected denial: [${roles}] ${tool} ${JSON.stringify(ctx)}`);
};
const allowed = (roles: Role[], tool: string, ctx: AgentReadyCallContext = {}) => assertAgentReadyCallAllowed(roles, tool, ctx);
const SELF_WID = "self-wid", OTHER_WID = "other-wid";
const OTHER_IN_SCOPE: AgentReadyCallContext = { contextInstanceId: OTHER_WID, callerWid: SELF_WID, targetInScope: true };
const ME_CONFIRMED: AgentReadyCallContext = { contextInstanceId: "me", previewConfirmed: true };
const SS_READS = SELF_SERVICE_SKILL_TOOLS.filter((t) => t.readOnly).map((t) => t.name);
const SS_WRITES = SELF_SERVICE_SKILL_TOOLS.filter((t) => !t.readOnly).map((t) => t.name);
const PAYSLIPS = ["find_payslips", "find_payslip_summary", "find_payslip_details"];
const HR_ORG_READS = [
  "find_absence_balances", "find_worker_time_off_details", "find_worker_eligible_absence_types", "find_worker_valid_time_off_dates",
  "find_business_process_tasks", "find_plan_assignments", "get_learning_content", "find_learning_transcript",
  "find_continue_learning", "list_my_goals", "find_goal_status",
];
const MA_READS = MANAGER_ACTIONS_SKILL_TOOLS.filter((t) => t.readOnly).map((t) => t.name);
const MA_WRITES = MANAGER_ACTIONS_SKILL_TOOLS.filter((t) => !t.readOnly).map((t) => t.name);
const PAYROLL_INPUT_READS = [
  "list_request_payroll_input_workers", "list_request_payroll_input_pay_components",
  "list_request_payroll_input_event_input_types_for_pay_component",
];
const HR_READS = HR_PARTNER_SKILL_TOOLS.filter((t) => t.readOnly).map((t) => t.name);
const HR_WRITES = HR_PARTNER_SKILL_TOOLS.filter((t) => !t.readOnly).map((t) => t.name);
const ID_TOOLS = HR_WRITES.filter((n) => n !== "request_worker_leave_of_absence");
const SPECIAL = [...ID_TOOLS, "find_ethnicity", "find_ethnicity_details"];
const isNoneTarget = (n: string) => targetKindFor(n) === "none";
// Verified team for SELF_WID: r1 (manager) -> r3 (manager) -> r4 ...; r2 IC. Depth cap 5.
const chainReports: Record<string, { id: string; hasManagerRole: boolean }[]> = {
  [SELF_WID]: [{ id: "r1", hasManagerRole: true }, { id: "r2", hasManagerRole: false }],
  r1: [{ id: "r3", hasManagerRole: true }],
  r3: [{ id: "r4", hasManagerRole: true }],
  r4: [{ id: "r5", hasManagerRole: true }],
  r5: [{ id: "r6", hasManagerRole: true }],
  r6: [{ id: "r7", hasManagerRole: false }],
};
const teamAdapter = (selfWid = SELF_WID) => ({
  resolveSelf: async () => ({ id: selfWid }),
  listDirectReports: async (m: { id: string }) => chainReports[m.id] ?? [],
});
const TEAM = await verifyTeamScope(teamAdapter());
const TEAM_CTX = (target: string): AgentReadyCallContext => ({ contextInstanceId: target, callerWid: SELF_WID, teamScope: TEAM });
// Org tree: hrRoot -> hrA -> hrB -> ... -> hrF (depth 6, beyond cap); manager manages mOrg -> mSub.
const orgChildren: Record<string, string[]> = {
  hrRoot: ["hrA"], hrA: ["hrB"], hrB: ["hrC"], hrC: ["hrD"], hrD: ["hrE"], hrE: ["hrF"], mOrg: ["mSub"],
};
const workerOrgs: Record<string, string[]> = { w_in: ["hrC"], w_out: ["elsewhere"], w_deep: ["hrF"] };
const orgAdapter = (roots: string[], selfWid = SELF_WID) => ({
  resolveSelf: async () => ({ id: selfWid }),
  listRootOrgIds: async () => roots,
  listChildOrgIds: async (o: string) => orgChildren[o] ?? [],
});
const HR_SCOPE = await verifyOrgScope("hr_partner", orgAdapter(["hrRoot"]));
const MGR_ORG_SCOPE = await verifyOrgScope("manager", orgAdapter(["mOrg"]));
const listWorkerOrgs = async (w: string) => workerOrgs[w] ?? [];
const HR_PROOF_IN = await verifyWorkerInOrgScope(HR_SCOPE, "w_in", listWorkerOrgs);
const HR_W = (target: string, extra: AgentReadyCallContext = {}): AgentReadyCallContext => ({
  contextInstanceId: target, callerWid: SELF_WID, orgScope: HR_SCOPE, workerOrgProof: HR_PROOF_IN, ...extra,
});
const HR_EXCLUDED = [...PAYSLIPS, "find_latest_employee_enrollment_event", "get_employee_enrollment_history", "view_benefits_dependent"];

check("catalog: 13 worker-data + 34 self-service + 41 manager-actions + 21 hr-partner tools, seeds kept, deduped", () => {
  if (HR_PARTNER_SKILL_TOOLS.length !== 21 || HR_READS.length !== 10 || HR_WRITES.length !== 11) {
    throw new Error(`hr-partner ${HR_PARTNER_SKILL_TOOLS.length} r${HR_READS.length} w${HR_WRITES.length}`);
  }
  for (const t of HR_PARTNER_SKILL_TOOLS) if (t.source !== HR_PARTNER_DISCOVERY_SOURCE) throw new Error(`${t.name} bad source`);
  if (MANAGER_ACTIONS_SKILL_TOOLS.length !== 41 || MA_READS.length !== 35 || MA_WRITES.length !== 6) {
    throw new Error(`manager-actions ${MANAGER_ACTIONS_SKILL_TOOLS.length} r${MA_READS.length} w${MA_WRITES.length}`);
  }
  const tagged = TENANT_DISCOVERED_TOOLS.filter((t) => t.skills?.includes("manager-actions-skill")).length;
  if (tagged !== 52) throw new Error(`manager-actions-skill tagged on ${tagged}, want 52`);
  if (WORKER_DATA_SKILL_TOOLS.length !== 13) throw new Error(`worker-data ${WORKER_DATA_SKILL_TOOLS.length}`);
  if (SELF_SERVICE_SKILL_TOOLS.length !== 34) throw new Error(`self-service ${SELF_SERVICE_SKILL_TOOLS.length}`);
  if (SS_READS.length !== 19 || SS_WRITES.length !== 15) throw new Error(`reads ${SS_READS.length} writes ${SS_WRITES.length}`);
  const names = AGENT_READY_CATALOG.tools.map((t) => t.name);
  if (new Set(names).size !== names.length) throw new Error("duplicate catalog names");
  if (names.length !== 115 || AGENT_READY_CATALOG.meta.toolCount !== names.length) throw new Error(`catalog ${names.length}`);
  for (const t of TENANT_DISCOVERED_TOOLS) if (!names.includes(t.name)) throw new Error(`missing ${t.name}`);
  if (!names.includes("getTimeOffEntries")) throw new Error("public seed dropped");
  const shared = WORKER_DATA_SKILL_TOOLS.filter((t) => t.skills?.includes("self-service-skill")).map((t) => t.name);
  if (shared.length !== 5) throw new Error(`shared ${shared}`);
});
check("tenant tools: wid null, source stamped; reads basic, writes advanced + BP step", () => {
  for (const t of WORKER_DATA_SKILL_TOOLS) if (t.source !== TENANT_DISCOVERY_SOURCE) throw new Error(`${t.name} bad source`);
  for (const t of SELF_SERVICE_SKILL_TOOLS) if (t.source !== SELF_SERVICE_DISCOVERY_SOURCE) throw new Error(`${t.name} bad source`);
  for (const t of MANAGER_ACTIONS_SKILL_TOOLS) if (t.source !== MANAGER_ACTIONS_DISCOVERY_SOURCE) throw new Error(`${t.name} bad source`);
  for (const t of TENANT_DISCOVERED_TOOLS) {
    if (t.wid !== null) throw new Error(`${t.name} has an invented wid`);
    const isWriteName = /^(create|update|edit|submit|approve|deny|initiate|request)_/.test(t.name);
    if (isWriteName !== (t.readOnly === false)) throw new Error(`${t.name} readOnly wrong`);
    if (t.readOnly && (t.kind !== "basic" || t.businessProcess)) throw new Error(`${t.name} read misclassified`);
    if (!t.readOnly && (t.kind !== "advanced" || !t.businessProcess)) throw new Error(`${t.name} write missing BP step`);
  }
});
check("write tools <-> NATIVE_WRITE_FLOWS consistent; known gap not catalogued", () => {
  const flowTools = new Set<string>();
  for (const [flow, d] of Object.entries(NATIVE_WRITE_FLOWS)) {
    const want: [string, string][] = [...(d.open ? [[d.open, "open"] as [string, string]] : []), ...d.stage.map((x) => [x, "stage"] as [string, string]), [d.submit, "submit"]];
    for (const [tool, step] of want) {
      const t = TENANT_DISCOVERED_TOOLS.find((x) => x.name === tool);
      if (!t || t.businessProcess?.flow !== flow || t.businessProcess.step !== step) throw new Error(`${flow}:${tool} mismatch`);
      flowTools.add(tool);
    }
  }
  for (const w of [...SS_WRITES, ...MA_WRITES]) if (!flowTools.has(w)) throw new Error(`${w} in no flow`);
  for (const g of KNOWN_TOOL_GAPS) if (AGENT_READY_CATALOG.tools.some((t) => t.name === g.tool)) throw new Error(`gap ${g.tool} catalogued`);
});
check("every tenant tool has an Agent-Ready RBAC mapping (and no orphans)", () => {
  const names = TENANT_DISCOVERED_TOOLS.map((t) => t.name);
  for (const n of names) if (!Object.keys(AGENT_READY_TOOL_PERMISSIONS[n] ?? {}).length) throw new Error(`unmapped ${n}`);
  const orphans = Object.keys(AGENT_READY_TOOL_PERMISSIONS).filter((n) => !names.includes(n));
  if (orphans.length) throw new Error(`orphans: ${orphans}`);
  const recipeOrphans = Object.keys(AGENT_READY_RECIPE_PERMISSIONS).filter((n) => !(n in AGENT_READY_RECIPES));
  if (recipeOrphans.length) throw new Error(`recipe orphans: ${recipeOrphans}`);
});
check("sensitive flags: personal info, addresses, payslips, dependents, legal name, history, expenses, feedback, payroll input", () => {
  const want = [
    "find_worker_personal_information", "list_worker_addresses", ...PAYSLIPS, "view_benefits_dependent", "find_worker_legal_name",
    "find_worker_history_events", "find_expense_lines", "find_worker_anytime_feedback_received", "request_payroll_input",
    "list_request_payroll_input_workers",
    "list_worker_history_events", ...SPECIAL,
  ];
  if ([...SENSITIVE_TENANT_TOOLS].sort().join() !== want.sort().join()) throw new Error(`got ${SENSITIVE_TENANT_TOOLS}`);
  for (const n of SENSITIVE_TENANT_TOOLS.filter((x) => ![...MA_READS, ...MA_WRITES, ...HR_READS, ...HR_WRITES].includes(x))) {
    const g = AGENT_READY_TOOL_PERMISSIONS[n] ?? {};
    if (g.manager && g.manager !== "self") throw new Error(`${n}: manager beyond self`);
    denied(["manager"], n, OTHER_IN_SCOPE);
  }
});
check("worker-data sensitive: never manager; worker_self(self) + hr_partner only", () => {
  for (const n of SENSITIVE_WORKER_DATA_TOOLS) {
    const g = AGENT_READY_TOOL_PERMISSIONS[n] ?? {};
    if (g.manager) throw new Error(`${n} granted to manager`);
    if (g.worker_self !== "self" || g.hr_partner !== "supervisory_org") throw new Error(`${n} grants wrong`);
    allowed(["worker_self"], n, { contextInstanceId: "me" });
    allowed(["hr_partner"], n, OTHER_IN_SCOPE);
  }
});
check("payroll_viewer: only payslips + payroll-input lookups, pay-group scope, never writes", () => {
  for (const n of PAYROLL_INPUT_READS) if (AGENT_READY_TOOL_PERMISSIONS[n]?.payroll_viewer !== "pay_group") throw new Error(`${n} not pay_group`);
  allowed(["payroll_viewer"], "list_request_payroll_input_workers", { targetInScope: true });
  denied(["payroll_viewer"], "list_request_payroll_input_workers", {}); // pay group not checked
  allowed(["payroll_viewer"], "list_request_payroll_input_pay_components", {});
  denied(["payroll_viewer"], "request_payroll_input", { ...ME_CONFIRMED, payrollDomain: true, targetInScope: true });
  for (const n of PAYSLIPS) {
    if (AGENT_READY_TOOL_PERMISSIONS[n]?.payroll_viewer !== "pay_group") throw new Error(`${n} not pay_group`);
    allowed(["payroll_viewer"], n, OTHER_IN_SCOPE);
    denied(["payroll_viewer"], n, { contextInstanceId: OTHER_WID }); // pay-group check not done
  }
  for (const n of [...Object.keys(AGENT_READY_TOOL_PERMISSIONS), ...Object.keys(AGENT_READY_RECIPE_PERMISSIONS)]) {
    if (PAYSLIPS.includes(n) || PAYROLL_INPUT_READS.includes(n)) continue;
    denied(["payroll_viewer"], n, { contextInstanceId: "me", targetInScope: true, previewConfirmed: true });
  }
});
check("admin: full read on every tenant tool and recipe, any target", () => {
  for (const n of [...Object.keys(AGENT_READY_TOOL_PERMISSIONS), ...Object.keys(AGENT_READY_RECIPE_PERMISSIONS)]) {
    if (isAgentReadyWrite(n)) {
      const g = AGENT_READY_TOOL_PERMISSIONS[n] ?? {};
      if (g.admin !== "self" && g.admin !== "actor_self") throw new Error(`${n}: admin write not self-scoped`);
      continue;
    }
    if (allowed(["admin"], n, { contextInstanceId: OTHER_WID }) !== "all") throw new Error(`${n} admin not all`);
  }
});
check("writes: self only for every role, never hr_partner/payroll_viewer, need confirmed preview", () => {
  for (const n of SS_WRITES) {
    const g = AGENT_READY_TOOL_PERMISSIONS[n] ?? {};
    if (Object.values(g).some((s) => s !== "self")) throw new Error(`${n} has a non-self write grant`);
    if (g.hr_partner || g.payroll_viewer) throw new Error(`${n} granted to hr_partner/payroll_viewer`);
    for (const r of ["worker_self", "manager", "admin"] as Role[]) {
      allowed([r], n, ME_CONFIRMED);
      allowed([r], n, { contextInstanceId: SELF_WID, callerWid: SELF_WID, previewConfirmed: true });
      denied([r], n, { contextInstanceId: "me" }); // no preview/confirm
      denied([r], n, { ...OTHER_IN_SCOPE, previewConfirmed: true }); // other worker
    }
    denied(["hr_partner"], n, ME_CONFIRMED);
    denied(["payroll_viewer"], n, ME_CONFIRMED);
    denied([...ROLES], n, { ...OTHER_IN_SCOPE, previewConfirmed: true });
  }
});
check("self-service reads: worker_self + manager self only", () => {
  for (const n of SS_READS.filter((x) => !isNoneTarget(x))) {
    for (const r of ["worker_self", "manager"] as Role[]) {
      allowed([r], n, { contextInstanceId: "me" });
      denied([r], n, OTHER_IN_SCOPE);
    }
  }
});
check("hr_partner: org-scope time off/inbox/learning/goals; no payslips/benefits/dependents/legal name", () => {
  for (const n of HR_ORG_READS) {
    if (AGENT_READY_TOOL_PERMISSIONS[n]?.hr_partner !== "supervisory_org") throw new Error(`${n} not org`);
    allowed(["hr_partner"], n, OTHER_IN_SCOPE);
    if (!isNoneTarget(n)) denied(["hr_partner"], n, { contextInstanceId: OTHER_WID });
  }
  for (const n of [...HR_EXCLUDED, "find_worker_legal_name"]) denied(["hr_partner"], n, OTHER_IN_SCOPE);
});
check("worker_self: 'me' or own WID only (worker-data)", () => {
  allowed(["worker_self"], "find_staffing_workers", { contextInstanceId: "me" });
  allowed(["worker_self"], "find_staffing_workers", { contextInstanceId: SELF_WID, callerWid: SELF_WID });
  denied(["worker_self"], "find_staffing_workers", OTHER_IN_SCOPE);
  denied(["worker_self"], "find_staffing_workers", {});
  denied(["worker_self"], "list_worker_direct_reports", { contextInstanceId: "me" });
  denied(["worker_self"], "resolve_manager_chain", { contextInstanceId: "me" });
});
check("manager needs a verified team scope; hr_partner needs targetInScope (worker-data)", () => {
  denied(["manager"], "list_worker_phone_numbers", OTHER_IN_SCOPE); // targetInScope is not enough for manager
  allowed(["manager"], "list_worker_phone_numbers", TEAM_CTX("r2"));
  denied(["manager"], "list_worker_phone_numbers", { contextInstanceId: OTHER_WID });
  denied(["manager"], "list_worker_phone_numbers", { contextInstanceId: OTHER_WID, targetInScope: false });
  denied(["hr_partner"], "find_staffing_workers", { contextInstanceId: OTHER_WID });
  allowed(["manager", "worker_self"], "find_worker_personal_information", { contextInstanceId: "me" });
});

// ---- manager-actions-skill ----
check("team scope: direct + indirect via hasManagerRole, depth cap 5, refuse outsiders", () => {
  for (const id of ["r1", "r2", "r3", "r4", "r5", "r6"]) if (!TEAM.memberIds.has(id)) throw new Error(`missing ${id}`);
  if (TEAM.memberIds.has("r7") || !TEAM.truncated) throw new Error("depth cap not applied");
  allowed(["manager"], "find_worker_history_events", TEAM_CTX("r6"));
  denied(["manager"], "find_worker_history_events", TEAM_CTX("r7")); // beyond cap
  denied(["manager"], "find_worker_history_events", TEAM_CTX(OTHER_WID));
  denied(["manager"], "find_worker_history_events", { ...TEAM_CTX("r1"), callerWid: "someone-else" }); // scope of another manager
  denied(["manager"], "find_worker_history_events", { contextInstanceId: "r1", callerWid: SELF_WID,
    teamScope: { managerWid: SELF_WID, memberIds: new Set(["r1"]), truncated: false, expiresAt: Date.now() + 1e6 } }); // forged
});
check("manager: all 35 new reads + 6 writes only on verified team", () => {
  for (const n of MA_READS) {
    if (AGENT_READY_TOOL_PERMISSIONS[n]?.manager !== "self_and_reports") throw new Error(`${n} manager not team`);
    if (targetKindFor(n) === "worker") {
      allowed(["manager"], n, TEAM_CTX("r3"));
      denied(["manager"], n, TEAM_CTX(OTHER_WID));
    }
  }
  const W = { ...TEAM_CTX("r1"), previewConfirmed: true };
  allowed(["manager"], "initiate_change_job", W);
  allowed(["manager"], "initiate_performance_review_for_employee", W);
  allowed(["manager"], "create_anytime_feedback_events", W);
  allowed(["manager"], "request_payroll_input", { ...W, payrollDomain: true });
  for (const n of MA_WRITES) denied(["manager"], n, { ...TEAM_CTX(OTHER_WID), previewConfirmed: true, payrollDomain: true, awaitingApproverWid: "me" });
  for (const n of MA_WRITES) denied(["manager"], n, { ...W, payrollDomain: true, awaitingApproverWid: "me", previewConfirmed: false });
});
check("approve/deny only where caller is the awaiting approver (all roles)", () => {
  for (const n of ["approve_business_process_event_step", "deny_business_process_event_step"]) {
    const base = { ...TEAM_CTX("r1"), previewConfirmed: true };
    allowed(["manager"], n, { ...base, awaitingApproverWid: SELF_WID });
    denied(["manager"], n, { ...base, awaitingApproverWid: "r9" });
    denied(["manager"], n, base);
    denied(["manager"], n, { ...TEAM_CTX(OTHER_WID), previewConfirmed: true, awaitingApproverWid: "me" }); // subject outside team
    allowed(["worker_self"], n, { contextInstanceId: OTHER_WID, callerWid: SELF_WID, awaitingApproverWid: "me", previewConfirmed: true });
    denied(["worker_self"], n, { contextInstanceId: OTHER_WID, callerWid: SELF_WID, awaitingApproverWid: OTHER_WID, previewConfirmed: true });
    allowed(["hr_partner"], n, { ...OTHER_IN_SCOPE, awaitingApproverWid: "me", previewConfirmed: true });
    denied(["hr_partner"], n, { contextInstanceId: OTHER_WID, awaitingApproverWid: "me", previewConfirmed: true });
    allowed(["admin"], n, { contextInstanceId: OTHER_WID, awaitingApproverWid: "me", previewConfirmed: true });
    denied(["admin"], n, { contextInstanceId: OTHER_WID, awaitingApproverWid: OTHER_WID, previewConfirmed: true });
    denied(["payroll_viewer"], n, { ...OTHER_IN_SCOPE, awaitingApproverWid: "me", previewConfirmed: true });
  }
});
check("request_payroll_input: manager/hr_partner + payroll domain; never payroll_viewer/worker_self; admin self", () => {
  const n = "request_payroll_input";
  denied(["manager"], n, { ...TEAM_CTX("r1"), previewConfirmed: true }); // no payroll domain
  allowed(["hr_partner"], n, { ...OTHER_IN_SCOPE, previewConfirmed: true, payrollDomain: true });
  denied(["hr_partner"], n, { ...OTHER_IN_SCOPE, previewConfirmed: true });
  denied(["worker_self"], n, { ...ME_CONFIRMED, payrollDomain: true });
  denied(["payroll_viewer"], n, { ...OTHER_IN_SCOPE, previewConfirmed: true, payrollDomain: true });
  allowed(["admin"], n, { ...ME_CONFIRMED, payrollDomain: true });
  denied(["admin"], n, { contextInstanceId: OTHER_WID, previewConfirmed: true, payrollDomain: true });
});
check("hr_partner: all new reads in org scope; writes in org scope", () => {
  for (const n of MA_READS) {
    if (AGENT_READY_TOOL_PERMISSIONS[n]?.hr_partner !== "supervisory_org") throw new Error(`${n} hr not org`);
    allowed(["hr_partner"], n, OTHER_IN_SCOPE);
    if (targetKindFor(n) !== "none") denied(["hr_partner"], n, { contextInstanceId: OTHER_WID });
  }
  for (const n of ["initiate_change_job", "initiate_performance_review_for_employee", "create_anytime_feedback_events"]) {
    allowed(["hr_partner"], n, { ...OTHER_IN_SCOPE, previewConfirmed: true });
    denied(["hr_partner"], n, { contextInstanceId: OTHER_WID, previewConfirmed: true });
  }
});
check("worker_self: own inbox/BP items, approve/deny own, give feedback to anyone, own feedback events; nothing else", () => {
  const ws: Role[] = ["worker_self"];
  allowed(ws, "find_business_process_tasks", { contextInstanceId: "me" });
  allowed(ws, "find_business_process_event_step", { contextInstanceId: OTHER_WID, callerWid: SELF_WID, awaitingApproverWid: "me" });
  denied(ws, "find_business_process_event_step", { contextInstanceId: OTHER_WID, callerWid: SELF_WID });
  allowed(ws, "create_anytime_feedback_events", { contextInstanceId: OTHER_WID, previewConfirmed: true });
  denied(ws, "create_anytime_feedback_events", { contextInstanceId: OTHER_WID }); // still needs preview + confirm
  allowed(ws, "find_anytime_feedback_events", { contextInstanceId: "me" });
  denied(ws, "find_anytime_feedback_events", OTHER_IN_SCOPE);
  denied(ws, "find_worker_anytime_feedback_received", { contextInstanceId: OTHER_WID });
  const wsOk = new Set([
    "find_business_process_event", "find_business_process_event_step", "find_completed_steps_for_business_process_event",
    "find_remaining_steps_for_business_process_event", "find_anytime_feedback_events",
    "approve_business_process_event_step", "deny_business_process_event_step", "create_anytime_feedback_events",
  ]);
  for (const n of [...MA_READS, ...MA_WRITES]) {
    const has = Boolean(AGENT_READY_TOOL_PERMISSIONS[n]?.worker_self);
    if (has !== wsOk.has(n)) throw new Error(`${n}: worker_self grant ${has}`);
  }
});
check("write grants never 'all'; actor_self only on writes", () => {
  for (const [n, g] of Object.entries(AGENT_READY_TOOL_PERMISSIONS)) {
    for (const s of Object.values(g)) {
      if (isAgentReadyWrite(n) && s === "all") throw new Error(`${n}: write granted 'all'`);
      if (!isAgentReadyWrite(n) && s === "actor_self") throw new Error(`${n}: actor_self on read`);
    }
  }
});

// ---- hr-partner-skill ----
check("org scope: roots + descendants to depth 5; outsiders and deep orgs refused", () => {
  for (const o of ["hrRoot", "hrA", "hrB", "hrC", "hrD", "hrE"]) if (!HR_SCOPE.orgIds.has(o)) throw new Error(`missing ${o}`);
  if (HR_SCOPE.orgIds.has("hrF") || !HR_SCOPE.truncated) throw new Error("depth cap not applied");
  allowed(["hr_partner"], "get_org_chart_children", HR_W("hrE"));
  denied(["hr_partner"], "get_org_chart_children", HR_W("hrF"));
  denied(["hr_partner"], "get_org_chart_children", HR_W("mOrg"));
  denied(["hr_partner"], "get_org_chart_children", { contextInstanceId: "hrA", callerWid: SELF_WID, targetInScope: true }); // boolean not accepted
  denied(["hr_partner"], "get_org_chart_children", { ...HR_W("hrA"), callerWid: "someone-else" });
  denied(["hr_partner"], "get_org_chart_children", { contextInstanceId: "hrA", callerWid: SELF_WID,
    orgScope: { basis: "hr_partner", callerWid: SELF_WID, orgIds: new Set(["hrA"]), truncated: false, expiresAt: Date.now() + 1e6 } }); // forged
});
check("hr_partner: every new read and write needs the org proof", () => {
  for (const n of [...HR_READS, ...HR_WRITES]) {
    if (!ORG_PROOF_REQUIRED.has(n)) throw new Error(`${n} not proof-gated`);
    if (AGENT_READY_TOOL_PERMISSIONS[n]?.hr_partner !== "supervisory_org") throw new Error(`${n} hr not org`);
  }
  for (const n of HR_READS) {
    const kind = targetKindFor(n);
    const ctx = kind === "org" ? HR_W("hrB") : HR_W("w_in");
    allowed(["hr_partner"], n, ctx);
    if (kind !== "none") denied(["hr_partner"], n, { contextInstanceId: kind === "org" ? "hrB" : "w_in", callerWid: SELF_WID, targetInScope: true });
    else denied(["hr_partner"], n, { callerWid: SELF_WID, targetInScope: true }); // lookup still needs a verified org scope
  }
  for (const n of HR_WRITES) {
    allowed(["hr_partner"], n, HR_W("w_in", { previewConfirmed: true }));
    denied(["hr_partner"], n, HR_W("w_out", { previewConfirmed: true }));
    denied(["hr_partner"], n, { contextInstanceId: "w_in", callerWid: SELF_WID, targetInScope: true, previewConfirmed: true });
    denied(["hr_partner"], n, HR_W("w_in")); // no preview/confirm
  }
});
check("manager: no ID/passport/visa/ethnicity tools; org chart only for own team orgs", () => {
  for (const n of [...SPECIAL, "list_organization_members", "list_worker_history_events", "request_worker_leave_of_absence",
    "list_leave_event_statuses", "list_time_off_entry_statuses", "list_onboarding_business_process_tasks"]) {
    if (AGENT_READY_TOOL_PERMISSIONS[n]?.manager) throw new Error(`${n} granted to manager`);
    denied(["manager"], n, { contextInstanceId: "me", callerWid: SELF_WID, orgScope: MGR_ORG_SCOPE, teamScope: TEAM, previewConfirmed: true });
  }
  const M = (org: string): AgentReadyCallContext => ({ contextInstanceId: org, callerWid: SELF_WID, orgScope: MGR_ORG_SCOPE });
  allowed(["manager"], "get_org_chart_children", M("mSub"));
  allowed(["manager"], "get_org_chart_parent", M("mOrg"));
  denied(["manager"], "get_org_chart_parent", M("hrA"));
  denied(["manager"], "get_org_chart_parent", { ...HR_W("hrA") }); // hr basis scope is not a manager scope
  allowed(["manager"], "find_org_chart_organizations", { callerWid: SELF_WID, orgScope: MGR_ORG_SCOPE });
  denied(["manager"], "find_org_chart_organizations", { callerWid: SELF_WID });
  const filtered = filterToOrgScope(MGR_ORG_SCOPE, [{ id: "mSub" }, { id: "hrA" }], (o) => o.id).map((o) => o.id).join();
  if (filtered !== "mSub") throw new Error(`filter ${filtered}`);
});
check("worker_self: own ID changes + own leave only; no hr reads", () => {
  for (const n of HR_WRITES) {
    allowed(["worker_self"], n, ME_CONFIRMED);
    denied(["worker_self"], n, { contextInstanceId: OTHER_WID, callerWid: SELF_WID, previewConfirmed: true, targetInScope: true });
    denied(["worker_self"], n, { contextInstanceId: "me" });
  }
  for (const n of HR_READS) denied(["worker_self"], n, { contextInstanceId: "me" });
});
check("payroll_viewer: no hr-partner tools; admin full read + self-only writes", () => {
  for (const n of [...HR_READS, ...HR_WRITES, "aggregate_diversity"]) {
    denied(["payroll_viewer"], n, { ...HR_W("w_in"), contextInstanceId: "me", previewConfirmed: true });
  }
  for (const n of HR_READS) allowed(["admin"], n, { contextInstanceId: targetKindFor(n) === "org" ? "anyOrg" : OTHER_WID });
  for (const n of HR_WRITES) {
    allowed(["admin"], n, ME_CONFIRMED);
    denied(["admin"], n, { contextInstanceId: OTHER_WID, previewConfirmed: true });
  }
});
check("special category: ID tools + ethnicity flagged; only self / hr_partner / admin", () => {
  if ([...SPECIAL_CATEGORY_TENANT_TOOLS].sort().join() !== [...SPECIAL].sort().join()) throw new Error(`got ${SPECIAL_CATEGORY_TENANT_TOOLS}`);
  for (const n of SPECIAL_CATEGORY_TENANT_TOOLS) {
    const roles = Object.keys(AGENT_READY_TOOL_PERMISSIONS[n] ?? {}).sort().join();
    const ok = ["admin,hr_partner", "admin,hr_partner,worker_self"];
    if (!ok.includes(roles)) throw new Error(`${n}: ${roles}`);
  }
});
check("diversity: k>=5 suppression, labels of small groups hidden, no per-person output", () => {
  const vals = [...Array(7).fill("A"), ...Array(5).fill("B"), ...Array(2).fill("C"), null];
  const r = aggregateBuckets("org", vals, 1); // k below 5 is raised to 5
  if (r.minGroupSize !== DIVERSITY_MIN_GROUP_SIZE) throw new Error("k lowered");
  if (r.buckets.map((b) => `${b.bucket}:${b.count}`).join() !== "A:7,B:5") throw new Error(JSON.stringify(r));
  if (r.population !== null || r.suppressedTotal !== null) throw new Error("suppressed counts derivable"); // 3 suppressed < 5
  const json = JSON.stringify(r);
  if (/"C"|Not disclosed/.test(json)) throw new Error("small-group label leaked");
  const r2 = aggregateBuckets("org", [...Array(6).fill("A"), ...Array(3).fill("B"), ...Array(3).fill("C")]);
  if (r2.population !== 12 || r2.suppressedTotal !== 6) throw new Error(JSON.stringify(r2));
  const r3 = aggregateBuckets("org", ["A", "A", "B", "B"]);
  if (!r3.suppressed || r3.buckets.length || r3.population !== null) throw new Error(JSON.stringify(r3));
});
check("diversity recipe: hr_partner (org proof) + admin only", () => {
  allowed(["hr_partner"], "aggregate_diversity", HR_W("hrB"));
  denied(["hr_partner"], "aggregate_diversity", HR_W("mOrg"));
  denied(["hr_partner"], "aggregate_diversity", { contextInstanceId: "hrB", callerWid: SELF_WID, targetInScope: true });
  allowed(["admin"], "aggregate_diversity", { contextInstanceId: "anyOrg" });
  for (const r of ["worker_self", "manager", "payroll_viewer"] as Role[]) {
    denied([r], "aggregate_diversity", { contextInstanceId: "mOrg", callerWid: SELF_WID, orgScope: MGR_ORG_SCOPE, teamScope: TEAM });
  }
});
check("unmapped Agent-Ready tool fails closed", () => denied([...ROLES], "__unmapped_native__", { contextInstanceId: "me" }));
check("admin role description grants full read (old config-only rule removed)", () => {
  if (!/full read/i.test(ROLE_DESCRIPTIONS.admin) || /config introspection only/i.test(ROLE_DESCRIPTIONS.admin)) throw new Error(ROLE_DESCRIPTIONS.admin);
  for (const t of TOOL_REGISTRY) {
    const roles = TOOL_PERMISSIONS[t.name] ?? [];
    if (t.access === "read" && !roles.includes("admin")) throw new Error(`admin missing read ${t.name}`);
    if (t.access === "write" && roles.includes("admin")) throw new Error(`admin has Layer-3 write ${t.name}`);
  }
});

await (async () => {
  const run = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.error(`FAIL ${name}: ${e instanceof Error ? e.message : e}`); }
  };
  await run(`recipe: manager chain capped at ${MANAGER_CHAIN_MAX_HOPS}`, async () => {
    // Infinite upward chain w0 -> w1 -> ...; worker n's org is org-n, managed by w(n+1).
    const r = await resolveManagerChain(
      {
        getPrimarySupervisoryOrg: async (w) => ({ id: `org-${w.id.slice(1)}` }),
        getOrgManager: async (o) => ({ id: `w${Number(o.id.slice(4)) + 1}` }),
      },
      { id: "w0" },
      99,
    );
    if (r.chain.length !== MANAGER_CHAIN_MAX_HOPS || !r.truncated) throw new Error(JSON.stringify(r));
  });
  await run("recipe: manager chain stops at top / on cycle", async () => {
    const mgr: Record<string, string> = { a: "b", b: "c", c: "c" };
    const top = await resolveManagerChain(
      { getPrimarySupervisoryOrg: async (w) => ({ id: w.id }), getOrgManager: async (o) => ({ id: mgr[o.id]! }) },
      { id: "a" },
    );
    if (top.chain.map((x) => x.id).join() !== "b,c" || top.truncated) throw new Error(JSON.stringify(top));
    const cyc: Record<string, string> = { a: "b", b: "a" };
    const c = await resolveManagerChain(
      { getPrimarySupervisoryOrg: async (w) => ({ id: w.id }), getOrgManager: async (o) => ({ id: cyc[o.id]! }) },
      { id: "a" },
    );
    if (c.stoppedBecause !== "cycle detected") throw new Error(JSON.stringify(c));
  });
  await run(`recipe: indirect reports recurse only hasManagerRole, depth cap ${INDIRECT_REPORTS_MAX_DEPTH}`, async () => {
    // Each manager m<d> has one manager report m<d+1> and one IC i<d>; unbounded depth.
    const r = await listIndirectReports(
      {
        listDirectReports: async (m) => {
          const d = Number(m.id.slice(1));
          return [{ id: `m${d + 1}`, hasManagerRole: true }, { id: `i${d + 1}`, hasManagerRole: false }];
        },
      },
      { id: "m0" },
      99,
    );
    const maxDepth = Math.max(...r.reports.map((x) => x.depth));
    if (maxDepth !== INDIRECT_REPORTS_MAX_DEPTH || !r.truncated || r.reports.length !== 2 * INDIRECT_REPORTS_MAX_DEPTH) {
      throw new Error(JSON.stringify({ maxDepth, truncated: r.truncated, n: r.reports.length }));
    }
  });

  // ---- native write guard: preview -> confirm -> open/stage/submit ----
  const contactPlan = (contextInstanceId = "me"): StagedWritePlan => ({
    flow: "home_contact_change",
    summary: "Phone: +31 6 0000 0000 -> +31 6 1111 1111",
    contextInstanceId,
    open: { tool: "create_worker_home_contact_change", args: {} },
    stage: [{ tool: "update_phone_number_for_home_contact_change", args: {} }],
    submit: { tool: "submit_home_contact_change", args: {} },
  });
  const mkAdapter = (calls: string[], failOn?: string) => ({
    call: async (tool: string) => { calls.push(tool); if (tool === failOn) throw new Error("400"); return { id: "evt-1" }; },
    eventWidFrom: (r: unknown) => (r as { id?: string }).id,
  });
  const expectThrow = async (fn: () => Promise<unknown> | unknown, label: string) => {
    try { await fn(); } catch { return; }
    throw new Error(`expected throw: ${label}`);
  };
  await run("guard: preview + confirm runs open -> stage -> submit once; retry replays", async () => {
    const store = new PreviewStore(), idem = new IdempotencyStore(), calls: string[] = [];
    const caller = { userId: "u1", roles: ["worker_self"] as Role[] };
    const pv = await previewNativeWrite(store, caller, contactPlan());
    if (calls.length) throw new Error("preview called Workday");
    const r = await commitNativeWrite({ previewStore: store, idempotency: idem }, caller, { previewToken: pv.previewToken, userConfirmed: true, idempotencyKey: "k1" }, mkAdapter(calls));
    if (!r.submitted || calls.join() !== "create_worker_home_contact_change,update_phone_number_for_home_contact_change,submit_home_contact_change") throw new Error(JSON.stringify({ r, calls }));
    const again = await commitNativeWrite({ previewStore: store, idempotency: idem }, caller, { previewToken: pv.previewToken, userConfirmed: true, idempotencyKey: "k1" }, mkAdapter(calls));
    if (!again.replayed || calls.length !== 3) throw new Error("not replayed");
  });
  await run("guard: no confirm / reused token / other user / other worker / hr_partner all refused", async () => {
    const store = new PreviewStore(), idem = new IdempotencyStore(), calls: string[] = [];
    const deps = { previewStore: store, idempotency: idem };
    const me = { userId: "u1", roles: ["admin"] as Role[], callerWid: SELF_WID };
    const pv = await previewNativeWrite(store, me, contactPlan());
    await expectThrow(() => commitNativeWrite(deps, me, { previewToken: pv.previewToken, userConfirmed: false, idempotencyKey: "a" }, mkAdapter(calls)), "unconfirmed");
    await expectThrow(() => commitNativeWrite(deps, { ...me, userId: "u2" }, { previewToken: pv.previewToken, userConfirmed: true, idempotencyKey: "b" }, mkAdapter(calls)), "other user");
    await commitNativeWrite(deps, me, { previewToken: pv.previewToken, userConfirmed: true, idempotencyKey: "c" }, mkAdapter(calls));
    await expectThrow(() => commitNativeWrite(deps, me, { previewToken: pv.previewToken, userConfirmed: true, idempotencyKey: "d" }, mkAdapter(calls)), "token reuse");
    await expectThrow(() => previewNativeWrite(store, me, contactPlan(OTHER_WID)), "admin write on other worker");
    await expectThrow(() => previewNativeWrite(store, { userId: "u3", roles: ["hr_partner", "payroll_viewer"] }, contactPlan()), "hr/payroll write");
  });
  await run("guard: rejects wrong flow steps and the known-gap tool", async () => {
    const store = new PreviewStore(), caller = { userId: "u1", roles: ["worker_self"] as Role[] };
    await expectThrow(() => previewNativeWrite(store, caller, { ...contactPlan(), submit: { tool: "submit_worker_goal_events", args: {} } }), "wrong submit");
    await expectThrow(() => previewNativeWrite(store, caller, { ...contactPlan(), stage: [{ tool: "find_staffing_workers", args: {} }] }), "read as stage");
    await expectThrow(() => previewNativeWrite(store, caller, {
      flow: "personal_information_change", summary: "x", contextInstanceId: "me",
      open: { tool: "create_personal_information_change_event", args: {} },
      stage: [{ tool: "update_personal_information_marital_status", args: {} }],
      submit: { tool: "submit_personal_information_changes", args: {} },
    }), "known gap");
  });
  await run("guard: failure after open reports discardRequired, no submit", async () => {
    const store = new PreviewStore(), idem = new IdempotencyStore(), calls: string[] = [];
    const caller = { userId: "u1", roles: ["manager"] as Role[] };
    const pv = await previewNativeWrite(store, caller, contactPlan());
    const r = await commitNativeWrite({ previewStore: store, idempotency: idem }, caller, { previewToken: pv.previewToken, userConfirmed: true, idempotencyKey: "k" }, mkAdapter(calls, "update_phone_number_for_home_contact_change"));
    if (r.submitted || !r.discardRequired || calls.includes("submit_home_contact_change")) throw new Error(JSON.stringify(r));
  });

  // ---- manager-actions write guards ----
  const mgr = { userId: "m1", roles: ["manager"] as Role[], callerWid: SELF_WID, scope: { teamScope: TEAM } };
  const det = (action: string, extra: Partial<import("../src/safety/native-write-guard.js").WritePreviewDetails> = {}) => ({
    worker: { id: "r1", descriptor: "Report One" }, action, changedFields: [{ field: "x", to: "y" }], ...extra,
  });
  const denyPlan = (comment: unknown): StagedWritePlan => ({
    flow: "deny_step", summary: "Deny", contextInstanceId: "r1", eventWid: "evt-9", awaitingApproverWid: SELF_WID,
    details: det("Deny step", { changedFields: [{ field: "step", from: "Awaiting", to: "Denied" }] }),
    stage: [], submit: { tool: "deny_business_process_event_step", args: { comment } },
  });
  const steps = async () => ["HR Partner", "Compensation Partner"];
  await run("guard: approve/deny previews show approvers; deny needs comment <= 256", async () => {
    const store = new PreviewStore();
    const pv = await previewNativeWrite(store, mgr, denyPlan("Wrong dates"), { remainingSteps: steps });
    if (pv.preview.approvers.source !== "find_remaining_steps_for_business_process_event" || pv.preview.worker?.descriptor !== "Report One") {
      throw new Error(JSON.stringify(pv.preview));
    }
    await expectThrow(() => previewNativeWrite(store, mgr, denyPlan(""), { remainingSteps: steps }), "empty comment");
    await expectThrow(() => previewNativeWrite(store, mgr, denyPlan(undefined), { remainingSteps: steps }), "missing comment");
    await expectThrow(() => previewNativeWrite(store, mgr, denyPlan("x".repeat(257)), { remainingSteps: steps }), "long comment");
    await previewNativeWrite(store, mgr, denyPlan("x".repeat(256)), { remainingSteps: steps });
    await expectThrow(() => previewNativeWrite(store, mgr, denyPlan("ok")), "event without approver lookup");
    await expectThrow(() => previewNativeWrite(store, mgr, { ...denyPlan("ok"), awaitingApproverWid: "r9" }, { remainingSteps: steps }), "not awaiting approver");
    await expectThrow(() => previewNativeWrite(store, mgr, { ...denyPlan("ok"), details: undefined }, { remainingSteps: steps }), "no details");
  });
  const changeJob = (extra: Partial<StagedWritePlan> = {}, d: Record<string, unknown> = {}): StagedWritePlan => ({
    flow: "change_job", summary: "Change job", contextInstanceId: "r1",
    details: det("Change job", { effectiveDate: "2026-11-01", effectiveDateProvidedBy: "user", ...d }),
    stage: [], submit: { tool: "initiate_change_job", args: {} }, ...extra,
  });
  await run("guard: change job needs user-provided effective date; team only; approvers note without event", async () => {
    const store = new PreviewStore();
    const pv = await previewNativeWrite(store, mgr, changeJob());
    if (pv.preview.approvers.source !== "tenant-bp-config" || pv.preview.effectiveDate !== "2026-11-01") throw new Error(JSON.stringify(pv.preview));
    await expectThrow(() => previewNativeWrite(store, mgr, changeJob({}, { effectiveDate: undefined })), "no date");
    await expectThrow(() => previewNativeWrite(store, mgr, changeJob({}, { effectiveDateProvidedBy: undefined })), "defaulted date");
    await expectThrow(() => previewNativeWrite(store, mgr, changeJob({}, { effectiveDate: "2026-13-45" })), "bad date");
    await expectThrow(() => previewNativeWrite(store, mgr, changeJob({ contextInstanceId: OTHER_WID })), "outside team");
    await expectThrow(() => previewNativeWrite(store, { ...mgr, scope: {} }, changeJob()), "no team proof");
    await expectThrow(() => previewNativeWrite(store, mgr, changeJob({ stage: [{ tool: "edit_worker_goals", args: {} }] })), "PATCH staging");
  });
  const payroll = (pi: Record<string, unknown> = {}, d: Record<string, unknown> = {}): StagedWritePlan => ({
    flow: "payroll_input", summary: "Payroll input", contextInstanceId: "r1",
    details: det("Request payroll input", { effectiveDate: "2026-11-01", effectiveDateProvidedBy: "user", ...d }),
    stage: [],
    submit: { tool: "request_payroll_input", args: {
      payrollInput: { worker: "r1", payComponent: "pc", startDate: "2026-11-01", ongoing: false, endDate: "2026-11-30",
        inputDetails: [{ type: "t", value: 150 }], ...pi },
      businessProcessParameters: { action: "submit-wid" },
    } },
  });
  await run("guard: payroll input validation + payroll domain + commit", async () => {
    const store = new PreviewStore(), idem = new IdempotencyStore(), calls: string[] = [];
    const pm = { ...mgr, scope: { teamScope: TEAM, payrollDomain: true } };
    await expectThrow(() => previewNativeWrite(store, mgr, payroll()), "no payroll domain");
    await expectThrow(() => previewNativeWrite(store, pm, payroll({ endDate: undefined })), "endDate when ongoing=false");
    await previewNativeWrite(store, pm, payroll({ ongoing: true, endDate: undefined }));
    await expectThrow(() => previewNativeWrite(store, pm, payroll({ inputDetails: [{ type: "t", value: "150" }] })), "non-numeric value");
    await expectThrow(() => previewNativeWrite(store, pm, payroll({ startDate: undefined })), "no start date");
    await expectThrow(() => previewNativeWrite(store, pm, payroll({ worker: "r2" })), "worker mismatch");
    await expectThrow(() => previewNativeWrite(store, pm, payroll({}, { effectiveDate: "2026-12-01" })), "effective != start");
    await expectThrow(() => previewNativeWrite(store, { userId: "p1", roles: ["payroll_viewer"], scope: { payrollDomain: true, targetInScope: true } }, payroll()), "payroll_viewer write");
    const pv = await previewNativeWrite(store, pm, payroll());
    await expectThrow(() => commitNativeWrite({ previewStore: store, idempotency: idem }, mgr, { previewToken: pv.previewToken, userConfirmed: true, idempotencyKey: "p" }, mkAdapter(calls)), "commit without domain");
    const pv2 = await previewNativeWrite(store, pm, payroll());
    const r = await commitNativeWrite({ previewStore: store, idempotency: idem }, pm, { previewToken: pv2.previewToken, userConfirmed: true, idempotencyKey: "p2" }, mkAdapter(calls));
    if (!r.submitted || calls.join() !== "request_payroll_input") throw new Error(JSON.stringify({ r, calls }));
  });
  await run("guard: performance review + feedback flows", async () => {
    const store = new PreviewStore();
    const review = (a: Record<string, unknown> = {}): StagedWritePlan => ({
      flow: "performance_review", summary: "Review", contextInstanceId: "r1",
      details: det("Initiate performance review", { effectiveDate: "2026-11-01", effectiveDateProvidedBy: "user" }),
      stage: [], submit: { tool: "initiate_performance_review_for_employee",
        args: { reviewAboutWorker: "r1", reviewTemplate: "tpl", startDate: "2026-11-01", endDate: "2026-12-31", ...a } },
    });
    await previewNativeWrite(store, mgr, review());
    await expectThrow(() => previewNativeWrite(store, mgr, review({ endDate: "2026-10-01" })), "end < start");
    await expectThrow(() => previewNativeWrite(store, mgr, review({ reviewAboutWorker: "r2" })), "worker mismatch");
    const fb: StagedWritePlan = {
      flow: "anytime_feedback", summary: "Feedback", contextInstanceId: OTHER_WID,
      details: { worker: { id: OTHER_WID, descriptor: "Peer" }, action: "Give feedback", changedFields: [{ field: "message", to: "Great demo" }] },
      stage: [], submit: { tool: "create_anytime_feedback_events", args: {} },
    };
    await previewNativeWrite(store, { userId: "w1", roles: ["worker_self"], callerWid: SELF_WID }, fb);
    await expectThrow(() => previewNativeWrite(store, mgr, fb), "manager-only feedback to non-team");
  });

  // ---- hr-partner-skill guards ----
  await run("org proof: outside / deep workers refused", async () => {
    await expectThrow(() => verifyWorkerInOrgScope(HR_SCOPE, "w_out", listWorkerOrgs), "outside");
    await expectThrow(() => verifyWorkerInOrgScope(HR_SCOPE, "w_deep", listWorkerOrgs), "beyond depth cap");
  });
  const hr = { userId: "h1", roles: ["hr_partner"] as Role[], callerWid: SELF_WID, scope: { orgScope: HR_SCOPE, workerOrgProof: HR_PROOF_IN } };
  const idPlan = (extra: Partial<StagedWritePlan> = {}): StagedWritePlan => ({
    flow: "passport_visa_change", summary: "Passport", contextInstanceId: "w_in", eventWid: "evt-ext",
    details: { worker: { id: "w_in", descriptor: "In Scope" }, action: "Update passport", changedFields: [{ field: "passport", from: "•••1", to: "•••2" }] },
    stage: [{ tool: "update_passport_ids", args: {} }], submit: { tool: "submit_passport_and_visa_changes", args: {} }, ...extra,
  });
  await run("guard: ID changes need an external event WID (gap), stage on it, org proof, approvers", async () => {
    const store = new PreviewStore(), idem = new IdempotencyStore(), calls: string[] = [];
    await expectThrow(() => previewNativeWrite(store, hr, idPlan({ eventWid: undefined }), { remainingSteps: steps }), "no event WID");
    await expectThrow(() => previewNativeWrite(store, hr, idPlan({ stage: [] }), { remainingSteps: steps }), "no stage");
    await expectThrow(() => previewNativeWrite(store, hr, idPlan({ open: { tool: "create_passport_ids", args: {} } }), { remainingSteps: steps }), "fake open");
    await expectThrow(() => previewNativeWrite(store, hr, idPlan({ stage: [{ tool: "create_national_ids", args: {} }] }), { remainingSteps: steps }), "cross-flow stage");
    await expectThrow(() => previewNativeWrite(store, hr, idPlan({ contextInstanceId: "w_out" }), { remainingSteps: steps }), "outside org");
    await expectThrow(() => previewNativeWrite(store, { ...hr, scope: { targetInScope: true } }, idPlan(), { remainingSteps: steps }), "boolean scope");
    const pv = await previewNativeWrite(store, hr, idPlan(), { remainingSteps: steps });
    if (pv.preview.approvers.source !== "find_remaining_steps_for_business_process_event") throw new Error("approvers");
    const r = await commitNativeWrite({ previewStore: store, idempotency: idem }, hr, { previewToken: pv.previewToken, userConfirmed: true, idempotencyKey: "id1" }, mkAdapter(calls));
    if (!r.submitted || r.eventWid !== "evt-ext" || calls.join() !== "update_passport_ids,submit_passport_and_visa_changes") throw new Error(JSON.stringify({ r, calls }));
    const self = { userId: "w1", roles: ["worker_self"] as Role[], callerWid: SELF_WID };
    const gov: StagedWritePlan = { ...idPlan(), flow: "government_id_change", contextInstanceId: "me",
      stage: [{ tool: "create_national_ids", args: {} }], submit: { tool: "submit_government_identifier_changes", args: {} } };
    await previewNativeWrite(store, self, gov, { remainingSteps: steps });
    await expectThrow(() => previewNativeWrite(store, self, { ...gov, contextInstanceId: OTHER_WID }, { remainingSteps: steps }), "self only");
    await expectThrow(() => previewNativeWrite(store, { ...mgr, scope: { teamScope: TEAM, orgScope: MGR_ORG_SCOPE } }, { ...gov, contextInstanceId: "r1" }, { remainingSteps: steps }), "manager ID change");
  });
  await run("guard: leave of absence needs a user-provided start date", async () => {
    const store = new PreviewStore(), self = { userId: "w1", roles: ["worker_self"] as Role[], callerWid: SELF_WID };
    const leave = (d: Record<string, unknown> = {}): StagedWritePlan => ({
      flow: "leave_of_absence", summary: "Leave", contextInstanceId: "me",
      details: { worker: { id: SELF_WID, descriptor: "Me" }, action: "Request leave of absence",
        changedFields: [{ field: "leave", to: "Parental" }], effectiveDate: "2027-01-04", effectiveDateProvidedBy: "user", ...d },
      stage: [], submit: { tool: "request_worker_leave_of_absence", args: {} },
    });
    const pv = await previewNativeWrite(store, self, leave());
    if (pv.preview.approvers.source !== "tenant-bp-config") throw new Error("approvers note");
    await expectThrow(() => previewNativeWrite(store, self, leave({ effectiveDate: undefined })), "no start");
    await expectThrow(() => previewNativeWrite(store, self, leave({ effectiveDateProvidedBy: undefined })), "defaulted start");
    await previewNativeWrite(store, hr, { ...leave(), contextInstanceId: "w_in" });
    await expectThrow(() => previewNativeWrite(store, hr, { ...leave(), contextInstanceId: "w_out" }), "hr outside org");
  });
  await run("diversity: computeDiversityAggregate checks RBAC and returns counts only", async () => {
    const eth: Record<string, string | null> = {};
    const members = Array.from({ length: 12 }, (_, i) => `p${i}`);
    members.forEach((m, i) => (eth[m] = i < 6 ? "A" : i < 11 ? "B" : null));
    const adapter = { listMemberIds: async () => members, ethnicityOf: async (w: string) => eth[w] ?? null };
    const r = await computeDiversityAggregate(["hr_partner"], { contextInstanceId: "hrB", callerWid: SELF_WID, orgScope: HR_SCOPE }, adapter);
    if (JSON.stringify(r).match(/p\d/)) throw new Error("per-person id leaked");
    if (r.buckets.map((b) => `${b.bucket}:${b.count}`).join() !== "A:6,B:5" || r.population !== null) throw new Error(JSON.stringify(r));
    await expectThrow(() => computeDiversityAggregate(["manager"], { contextInstanceId: "mOrg", callerWid: SELF_WID, orgScope: MGR_ORG_SCOPE }, adapter), "manager");
  });
})();

if (failed) { console.error(`${failed} RBAC check(s) failed`); process.exit(1); }
