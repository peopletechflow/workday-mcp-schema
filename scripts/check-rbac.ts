/** Smoke check: every registered tool has an RBAC mapping and enforcement behaves. Run: npm run check:rbac */
import { TOOL_REGISTRY, assertRegistryInvariants } from "../src/tools/registry.js";
import {
  AGENT_READY_RECIPE_PERMISSIONS,
  AGENT_READY_TOOL_PERMISSIONS,
  assertAgentReadyCallAllowed,
  assertToolAllowed,
  RbacDeniedError,
  ROLE_DESCRIPTIONS,
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
const HR_EXCLUDED = [...PAYSLIPS, "find_latest_employee_enrollment_event", "get_employee_enrollment_history", "view_benefits_dependent"];

check("catalog: 13 worker-data + 34 self-service tools, seeds kept, deduped", () => {
  if (WORKER_DATA_SKILL_TOOLS.length !== 13) throw new Error(`worker-data ${WORKER_DATA_SKILL_TOOLS.length}`);
  if (SELF_SERVICE_SKILL_TOOLS.length !== 34) throw new Error(`self-service ${SELF_SERVICE_SKILL_TOOLS.length}`);
  if (SS_READS.length !== 19 || SS_WRITES.length !== 15) throw new Error(`reads ${SS_READS.length} writes ${SS_WRITES.length}`);
  const names = AGENT_READY_CATALOG.tools.map((t) => t.name);
  if (new Set(names).size !== names.length) throw new Error("duplicate catalog names");
  if (names.length !== 53 || AGENT_READY_CATALOG.meta.toolCount !== names.length) throw new Error(`catalog ${names.length}`);
  for (const t of TENANT_DISCOVERED_TOOLS) if (!names.includes(t.name)) throw new Error(`missing ${t.name}`);
  if (!names.includes("getTimeOffEntries")) throw new Error("public seed dropped");
  const shared = WORKER_DATA_SKILL_TOOLS.filter((t) => t.skills?.includes("self-service-skill")).map((t) => t.name);
  if (shared.length !== 5) throw new Error(`shared ${shared}`);
});
check("tenant tools: wid null, source stamped; reads basic, writes advanced + BP step", () => {
  for (const t of WORKER_DATA_SKILL_TOOLS) if (t.source !== TENANT_DISCOVERY_SOURCE) throw new Error(`${t.name} bad source`);
  for (const t of SELF_SERVICE_SKILL_TOOLS) if (t.source !== SELF_SERVICE_DISCOVERY_SOURCE) throw new Error(`${t.name} bad source`);
  for (const t of TENANT_DISCOVERED_TOOLS) {
    if (t.wid !== null) throw new Error(`${t.name} has an invented wid`);
    const isWriteName = /^(create|update|edit|submit)_/.test(t.name);
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
      const t = SELF_SERVICE_SKILL_TOOLS.find((x) => x.name === tool);
      if (!t || t.businessProcess?.flow !== flow || t.businessProcess.step !== step) throw new Error(`${flow}:${tool} mismatch`);
      flowTools.add(tool);
    }
  }
  for (const w of SS_WRITES) if (!flowTools.has(w)) throw new Error(`${w} in no flow`);
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
check("sensitive flags: personal info, addresses, payslips, dependents, legal name", () => {
  const want = ["find_worker_personal_information", "list_worker_addresses", ...PAYSLIPS, "view_benefits_dependent", "find_worker_legal_name"];
  if ([...SENSITIVE_TENANT_TOOLS].sort().join() !== want.sort().join()) throw new Error(`got ${SENSITIVE_TENANT_TOOLS}`);
  for (const n of SENSITIVE_TENANT_TOOLS) {
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
check("payroll_viewer: only payslips, pay-group scope, nothing else", () => {
  for (const n of PAYSLIPS) {
    if (AGENT_READY_TOOL_PERMISSIONS[n]?.payroll_viewer !== "pay_group") throw new Error(`${n} not pay_group`);
    allowed(["payroll_viewer"], n, OTHER_IN_SCOPE);
    denied(["payroll_viewer"], n, { contextInstanceId: OTHER_WID }); // pay-group check not done
  }
  for (const n of [...Object.keys(AGENT_READY_TOOL_PERMISSIONS), ...Object.keys(AGENT_READY_RECIPE_PERMISSIONS)]) {
    if (PAYSLIPS.includes(n)) continue;
    denied(["payroll_viewer"], n, { contextInstanceId: "me", targetInScope: true, previewConfirmed: true });
  }
});
check("admin: full read on every tenant tool and recipe, any target", () => {
  for (const n of [...Object.keys(AGENT_READY_TOOL_PERMISSIONS), ...Object.keys(AGENT_READY_RECIPE_PERMISSIONS)]) {
    if (SS_WRITES.includes(n)) continue;
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
  for (const n of SS_READS) {
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
    denied(["hr_partner"], n, { contextInstanceId: OTHER_WID });
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
check("manager / hr_partner: non-self targets need targetInScope (worker-data)", () => {
  allowed(["manager"], "list_worker_phone_numbers", OTHER_IN_SCOPE);
  denied(["manager"], "list_worker_phone_numbers", { contextInstanceId: OTHER_WID });
  denied(["manager"], "list_worker_phone_numbers", { contextInstanceId: OTHER_WID, targetInScope: false });
  denied(["hr_partner"], "find_staffing_workers", { contextInstanceId: OTHER_WID });
  allowed(["manager", "worker_self"], "find_worker_personal_information", { contextInstanceId: "me" });
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
    const pv = previewNativeWrite(store, caller, contactPlan());
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
    const pv = previewNativeWrite(store, me, contactPlan());
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
    const pv = previewNativeWrite(store, caller, contactPlan());
    const r = await commitNativeWrite({ previewStore: store, idempotency: idem }, caller, { previewToken: pv.previewToken, userConfirmed: true, idempotencyKey: "k" }, mkAdapter(calls, "update_phone_number_for_home_contact_change"));
    if (r.submitted || !r.discardRequired || calls.includes("submit_home_contact_change")) throw new Error(JSON.stringify(r));
  });
})();

if (failed) { console.error(`${failed} RBAC check(s) failed`); process.exit(1); }
