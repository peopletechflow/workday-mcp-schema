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
};

export function rolesForTool(toolName: string): readonly Role[] | undefined {
  return TOOL_PERMISSIONS[toolName];
}
