/** Smoke check: every registered tool has an RBAC mapping and enforcement behaves. Run: npm run check:rbac */
import { TOOL_REGISTRY, assertRegistryInvariants } from "../src/tools/registry.js";
import { assertToolAllowed, RbacDeniedError, TOOL_PERMISSIONS } from "../src/rbac/index.js";

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
if (failed) { console.error(`${failed} RBAC check(s) failed`); process.exit(1); }
