import * as T from "../schemas/tools/index.js";
import type { Role } from "./roles.js";

const SELF: Role[] = ["worker_self"];
const MGR: Role[] = ["manager"];
/** Self reads: admin has full read access (own sign-in, never a shared account). */
const SELF_READ: Role[] = ["worker_self", "admin"];

/**
 * Tool name -> roles allowed to invoke it. Single source of truth for RBAC;
 * preview/commit pairs MUST share the same roles. Payroll stays read-only.
 * admin: every READ tool (full read); no Layer-3 writes (admin self-writes go through native
 * self-service tools + src/safety/native-write-guard.ts).
 * Note: RBAC is a coarse pre-filter; Workday security on the user's token is still authoritative.
 */
export const TOOL_PERMISSIONS: Readonly<Record<string, readonly Role[]>> = {
  [T.getMyWorkerProfile.name]: SELF_READ,
  [T.getMyTimeOffBalance.name]: SELF_READ,
  [T.listMyTimeOffRequests.name]: SELF_READ,
  [T.previewRequestTimeOff.name]: SELF,
  [T.commitRequestTimeOff.name]: SELF,
  [T.previewCancelTimeOff.name]: SELF,
  [T.commitCancelTimeOff.name]: SELF,
  [T.getMyBenefitsEnrollments.name]: SELF_READ,
  [T.listMyPayStatements.name]: ["worker_self", "payroll_viewer", "admin"],
  [T.listMyTeam.name]: ["manager", "hr_partner", "admin"],
  [T.listTeamTimeOffRequests.name]: ["manager", "hr_partner", "admin"],
  [T.previewApproveTimeOff.name]: MGR,
  [T.commitApproveTimeOff.name]: MGR,
  [T.previewDenyTimeOff.name]: MGR,
  [T.commitDenyTimeOff.name]: MGR,
  [T.getSupervisoryOrg.name]: ["worker_self", "manager", "hr_partner", "admin"],

  // Layer-1 catalog meta tools (discovery only; not native Workday passthroughs)
  [T.listAgentReadyTools.name]: ["worker_self", "manager", "hr_partner", "admin"],
  [T.getAgentReadyTool.name]: ["worker_self", "manager", "hr_partner", "admin"],

  // Outcome tools. Action checks use the operation names above. These rows let the
  // registry see the exposed names. A deny of an operation name still blocks that action.
  [T.timeOffTool.name]: ["worker_self", "manager", "hr_partner"],
  [T.workerTool.name]: SELF_READ,
  [T.organizationTool.name]: ["worker_self", "manager", "hr_partner", "admin"],
  [T.jobTool.name]: ["worker_self", "manager", "hr_partner", "admin"],
  [T.compensationTool.name]: ["worker_self", "manager", "hr_partner", "admin"],
  [T.benefitsTool.name]: SELF_READ,
  [T.payTool.name]: ["worker_self", "payroll_viewer", "admin"],
  [T.talentTool.name]: ["worker_self", "manager", "hr_partner", "admin"],
  [T.recruitingTool.name]: ["worker_self", "manager", "hr_partner", "admin"],
  [T.personalDataTool.name]: ["worker_self", "manager", "hr_partner", "admin"],
  [T.expensesTool.name]: ["worker_self", "manager", "hr_partner", "admin"],
  [T.businessProcessTool.name]: ["worker_self", "manager", "hr_partner", "admin"],
  [T.catalogTool.name]: ["worker_self", "manager", "hr_partner", "admin"],
};

export function rolesForTool(toolName: string): readonly Role[] | undefined {
  return TOOL_PERMISSIONS[toolName];
}
