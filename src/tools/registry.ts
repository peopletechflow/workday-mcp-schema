import * as T from "../schemas/tools/index.js";
import type { ToolAudience, ToolClass, WorkdaySurface } from "../schemas/tools/contract.js";

export type RegistryEntry = {
  name: string;
  toolClass: ToolClass;
  /** read | write, flattened for docs/metrics. */
  access: "read" | "write";
  audience: ToolAudience;
  domain: "hcm" | "absence" | "benefits" | "payroll" | "org";
  surface: WorkdaySurface;
  piiFields: string[];
  /** One-line build-vs-buy reason (SKILL §1.2). */
  buildReason: string;
  /** Wired to a live Workday surface yet, or fixture/stub only. */
  liveStatus: "live-stub" | "fixture-only";
  pairedWith?: string;
};

const BR_SELF = "Native self-service exists in UI, but assistant needs a narrow, per-user, audited read.";
const BR_WRITE = "No native MCP write with preview+idempotency gating; must run through BP as the user.";

/** Single source of truth for every tool this server exposes. */
export const TOOL_REGISTRY: RegistryEntry[] = [
  { name: T.getMyWorkerProfile.name, toolClass: "read", access: "read", audience: "worker", domain: "hcm", surface: "REST", piiFields: ["preferredName", "hireDate", "terminationDate", "manager.descriptor"], buildReason: BR_SELF, liveStatus: "fixture-only" },
  { name: T.getMyTimeOffBalance.name, toolClass: "read", access: "read", audience: "worker", domain: "absence", surface: "REST", piiFields: [], buildReason: BR_SELF, liveStatus: "live-stub" },
  { name: T.listMyTimeOffRequests.name, toolClass: "read", access: "read", audience: "worker", domain: "absence", surface: "RaaS", piiFields: ["comment"], buildReason: "Filtered history read; RaaS report beats many WWS calls.", liveStatus: "fixture-only" },
  { name: T.previewRequestTimeOff.name, toolClass: "write-preview", access: "write", audience: "worker", domain: "absence", surface: "REST", piiFields: ["comment"], buildReason: BR_WRITE, liveStatus: "live-stub", pairedWith: T.commitRequestTimeOff.name },
  { name: T.commitRequestTimeOff.name, toolClass: "write-commit", access: "write", audience: "worker", domain: "absence", surface: "REST", piiFields: ["comment"], buildReason: BR_WRITE, liveStatus: "live-stub", pairedWith: T.previewRequestTimeOff.name },
  { name: T.previewCancelTimeOff.name, toolClass: "write-preview", access: "write", audience: "worker", domain: "absence", surface: "WWS", piiFields: ["reason"], buildReason: BR_WRITE, liveStatus: "fixture-only", pairedWith: T.commitCancelTimeOff.name },
  { name: T.commitCancelTimeOff.name, toolClass: "write-commit", access: "write", audience: "worker", domain: "absence", surface: "WWS", piiFields: ["reason"], buildReason: BR_WRITE, liveStatus: "fixture-only", pairedWith: T.previewCancelTimeOff.name },
  { name: T.listMyTeam.name, toolClass: "read", access: "read", audience: "manager", domain: "hcm", surface: "RaaS", piiFields: ["preferredName"], buildReason: "Manager direct-reports read scoped by caller's security; RaaS join.", liveStatus: "fixture-only" },
  { name: T.listTeamTimeOffRequests.name, toolClass: "read", access: "read", audience: "manager", domain: "absence", surface: "RaaS", piiFields: ["worker.descriptor"], buildReason: "Team-wide filtered read; RaaS report with status filter.", liveStatus: "fixture-only" },
  { name: T.previewApproveTimeOff.name, toolClass: "write-preview", access: "write", audience: "manager", domain: "absence", surface: "WWS", piiFields: ["worker.descriptor", "comment"], buildReason: BR_WRITE, liveStatus: "fixture-only", pairedWith: T.commitApproveTimeOff.name },
  { name: T.commitApproveTimeOff.name, toolClass: "write-commit", access: "write", audience: "manager", domain: "absence", surface: "WWS", piiFields: ["worker.descriptor", "comment"], buildReason: BR_WRITE, liveStatus: "fixture-only", pairedWith: T.previewApproveTimeOff.name },
  { name: T.previewDenyTimeOff.name, toolClass: "write-preview", access: "write", audience: "manager", domain: "absence", surface: "WWS", piiFields: ["worker.descriptor", "comment"], buildReason: BR_WRITE, liveStatus: "fixture-only", pairedWith: T.commitDenyTimeOff.name },
  { name: T.commitDenyTimeOff.name, toolClass: "write-commit", access: "write", audience: "manager", domain: "absence", surface: "WWS", piiFields: ["worker.descriptor", "comment"], buildReason: BR_WRITE, liveStatus: "fixture-only", pairedWith: T.previewDenyTimeOff.name },
  { name: T.getMyBenefitsEnrollments.name, toolClass: "read", access: "read", audience: "worker", domain: "benefits", surface: "RaaS", piiFields: ["coverageLevel"], buildReason: BR_SELF, liveStatus: "fixture-only" },
  { name: T.listMyPayStatements.name, toolClass: "read", access: "read", audience: "worker", domain: "payroll", surface: "RaaS", piiFields: ["grossAmount", "netAmount"], buildReason: "Read-only pay summary; payroll writes are out of scope forever.", liveStatus: "fixture-only" },
  { name: T.getSupervisoryOrg.name, toolClass: "read", access: "read", audience: "worker", domain: "org", surface: "REST", piiFields: ["manager.descriptor"], buildReason: "Single-record org read by WID via REST.", liveStatus: "fixture-only" },
];

/** Static guardrails, also asserted at startup. */
export function assertRegistryInvariants(registeredNames: string[]): void {
  const names = TOOL_REGISTRY.map((t) => t.name);
  if (new Set(names).size !== names.length) throw new Error("Duplicate tool names in registry");
  for (const t of TOOL_REGISTRY) {
    if (/call_workday|passthrough|raw/i.test(t.name)) throw new Error(`Forbidden passthrough tool: ${t.name}`);
    if (t.domain === "payroll" && t.access === "write") throw new Error(`Payroll write tools are forbidden: ${t.name}`);
    if (t.toolClass !== "read" && !t.pairedWith) throw new Error(`Write tool without preview/commit pair: ${t.name}`);
  }
  const missing = names.filter((n) => !registeredNames.includes(n));
  const extra = registeredNames.filter((n) => !names.includes(n));
  if (missing.length || extra.length) {
    throw new Error(`Registry mismatch. missing=${missing.join(",")} extra=${extra.join(",")}`);
  }
}
