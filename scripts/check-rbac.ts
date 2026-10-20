/** Smoke check: every registered tool has an RBAC mapping and enforcement behaves. Run: npm run check:rbac */
import { TOOL_REGISTRY, assertRegistryInvariants } from "../src/tools/registry.js";
import {
  AGENT_READY_RECIPE_PERMISSIONS,
  AGENT_READY_TOOL_PERMISSIONS,
  assertAgentReadyCallAllowed,
  assertToolAllowed,
  RbacDeniedError,
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
  SENSITIVE_TENANT_TOOLS,
  TENANT_DISCOVERED_TOOLS,
  TENANT_DISCOVERY_SOURCE,
} from "../src/agent-ready/index.js";

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
const SELF_WID = "self-wid", OTHER_WID = "other-wid";
check("13 tenant-discovered tools, all in catalog, deduped", () => {
  if (TENANT_DISCOVERED_TOOLS.length !== 13) throw new Error(`got ${TENANT_DISCOVERED_TOOLS.length}`);
  const names = AGENT_READY_CATALOG.tools.map((t) => t.name);
  if (new Set(names).size !== names.length) throw new Error("duplicate catalog names");
  if (AGENT_READY_CATALOG.meta.toolCount !== names.length) throw new Error("meta.toolCount mismatch");
  for (const t of TENANT_DISCOVERED_TOOLS) if (!names.includes(t.name)) throw new Error(`missing ${t.name}`);
  if (!names.includes("getTimeOffEntries")) throw new Error("public seed dropped");
});
check("tenant tools: readOnly, wid null, source stamped", () => {
  for (const t of TENANT_DISCOVERED_TOOLS) {
    if (t.readOnly !== true || t.kind !== "basic") throw new Error(`${t.name} not read-only basic`);
    if (t.wid !== null) throw new Error(`${t.name} has an invented wid`);
    if (t.source !== TENANT_DISCOVERY_SOURCE) throw new Error(`${t.name} bad source`);
  }
});
check("every tenant tool has an Agent-Ready RBAC mapping (and no orphans)", () => {
  const names = TENANT_DISCOVERED_TOOLS.map((t) => t.name);
  for (const n of names) if (!Object.keys(AGENT_READY_TOOL_PERMISSIONS[n] ?? {}).length) throw new Error(`unmapped ${n}`);
  const orphans = Object.keys(AGENT_READY_TOOL_PERMISSIONS).filter((n) => !names.includes(n));
  if (orphans.length) throw new Error(`orphans: ${orphans}`);
  const recipeOrphans = Object.keys(AGENT_READY_RECIPE_PERMISSIONS).filter((n) => !(n in AGENT_READY_RECIPES));
  if (recipeOrphans.length) throw new Error(`recipe orphans: ${recipeOrphans}`);
});
check("payroll_viewer gets no worker-data tools or recipes", () => {
  for (const n of [...Object.keys(AGENT_READY_TOOL_PERMISSIONS), ...Object.keys(AGENT_READY_RECIPE_PERMISSIONS)]) {
    denied(["payroll_viewer"], n, { contextInstanceId: "me", targetInScope: true });
  }
});
check("admin allowed on every tenant tool and recipe", () => {
  for (const n of [...Object.keys(AGENT_READY_TOOL_PERMISSIONS), ...Object.keys(AGENT_READY_RECIPE_PERMISSIONS)]) {
    assertAgentReadyCallAllowed(["admin"], n, { contextInstanceId: OTHER_WID });
  }
});
check("sensitive tools: never manager; worker_self(self) + hr_partner only", () => {
  for (const n of SENSITIVE_TENANT_TOOLS) {
    const g = AGENT_READY_TOOL_PERMISSIONS[n] ?? {};
    if (g.manager) throw new Error(`${n} granted to manager`);
    if (g.worker_self !== "self" || g.hr_partner !== "supervisory_org") throw new Error(`${n} grants wrong`);
    denied(["manager"], n, { contextInstanceId: OTHER_WID, targetInScope: true });
    assertAgentReadyCallAllowed(["worker_self"], n, { contextInstanceId: "me" });
    assertAgentReadyCallAllowed(["hr_partner"], n, { contextInstanceId: OTHER_WID, targetInScope: true });
  }
});
check("worker_self: 'me' or own WID only", () => {
  assertAgentReadyCallAllowed(["worker_self"], "find_staffing_workers", { contextInstanceId: "me" });
  assertAgentReadyCallAllowed(["worker_self"], "find_staffing_workers", { contextInstanceId: SELF_WID, callerWid: SELF_WID });
  denied(["worker_self"], "find_staffing_workers", { contextInstanceId: OTHER_WID, callerWid: SELF_WID, targetInScope: true });
  denied(["worker_self"], "find_staffing_workers", {});
  denied(["worker_self"], "list_worker_direct_reports", { contextInstanceId: "me" });
  denied(["worker_self"], "resolve_manager_chain", { contextInstanceId: "me" });
});
check("manager / hr_partner: non-self targets need targetInScope", () => {
  assertAgentReadyCallAllowed(["manager"], "list_worker_phone_numbers", { contextInstanceId: OTHER_WID, targetInScope: true });
  denied(["manager"], "list_worker_phone_numbers", { contextInstanceId: OTHER_WID });
  denied(["manager"], "list_worker_phone_numbers", { contextInstanceId: OTHER_WID, targetInScope: false });
  denied(["hr_partner"], "find_staffing_workers", { contextInstanceId: OTHER_WID });
  assertAgentReadyCallAllowed(["manager", "worker_self"], "find_worker_personal_information", { contextInstanceId: "me" });
});
check("unmapped Agent-Ready tool fails closed", () => denied([...ROLES], "__unmapped_native__", { contextInstanceId: "me" }));

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
})();

if (failed) { console.error(`${failed} RBAC check(s) failed`); process.exit(1); }
