import * as T from "../schemas/tools/index.js";
import type { Role } from "./roles.js";

const SELF: Role[] = ["worker_self"];
const MGR: Role[] = ["manager"];

/**
 * Tool name -> roles allowed to invoke it. Single source of truth for RBAC;
 * preview/commit pairs MUST share the same roles. Payroll stays read-only.
 * Note: RBAC is a coarse pre-filter; Workday security on the user's token is still authoritative.
 */
export const TOOL_PERMISSIONS: Readonly<Record<string, readonly Role[]>> = {
  [T.getMyWorkerProfile.name]: SELF,
  [T.getMyTimeOffBalance.name]: SELF,
  [T.listMyTimeOffRequests.name]: SELF,
  [T.previewRequestTimeOff.name]: SELF,
  [T.commitRequestTimeOff.name]: SELF,
  [T.previewCancelTimeOff.name]: SELF,
  [T.commitCancelTimeOff.name]: SELF,
  [T.getMyBenefitsEnrollments.name]: SELF,
  [T.listMyPayStatements.name]: ["worker_self", "payroll_viewer"],
  [T.listMyTeam.name]: ["manager", "hr_partner"],
  [T.listTeamTimeOffRequests.name]: ["manager", "hr_partner"],
  [T.previewApproveTimeOff.name]: MGR,
  [T.commitApproveTimeOff.name]: MGR,
  [T.previewDenyTimeOff.name]: MGR,
  [T.commitDenyTimeOff.name]: MGR,
  [T.getSupervisoryOrg.name]: ["worker_self", "manager", "hr_partner"],
};

export function rolesForTool(toolName: string): readonly Role[] | undefined {
  return TOOL_PERMISSIONS[toolName];
}
