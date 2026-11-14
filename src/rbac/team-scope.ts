/**
 * Team-scope verifier for manager actions on a target worker.
 *
 * Rule (manager-actions-skill): resolve the manager via find_staffing_workers(contextInstanceId "me"),
 * then team = list_worker_direct_reports, recursing into reports where hasManagerRole is true
 * (depth cap 5), i.e. the list_indirect_reports recipe. Workers not in the team are refused.
 *
 * verifyTeamScope() returns a TeamScope that only this module can mint (tracked in a WeakSet),
 * with a short TTL. assertAgentReadyScope() accepts a manager's non-self target only when it is
 * a member of a verified, unexpired TeamScope minted for the same caller. A truncated walk
 * (depth cap hit) never widens access: workers beyond the cap are simply not members.
 */
import {
  INDIRECT_REPORTS_MAX_DEPTH,
  listIndirectReports,
  type IndirectReportsAdapter,
  type RecipeRef,
} from "../agent-ready/recipes.js";

export const TEAM_SCOPE_TTL_MS = 5 * 60 * 1000;

export type TeamScope = {
  /** The manager's own worker WID (resolved from "me"). */
  readonly managerWid: string;
  readonly memberIds: ReadonlySet<string>;
  /** true when the depth cap cut the walk short (members beyond it are NOT included). */
  readonly truncated: boolean;
  readonly expiresAt: number;
};

export type TeamScopeAdapter = IndirectReportsAdapter & {
  /** find_staffing_workers(contextInstanceId "me") -> the caller's worker ref (WID). */
  resolveSelf(): Promise<RecipeRef>;
};

const MINTED = new WeakSet<TeamScope>();

export async function verifyTeamScope(adapter: TeamScopeAdapter, now: number = Date.now()): Promise<TeamScope> {
  const self = await adapter.resolveSelf();
  if (!self.id || self.id === "me") throw new Error("resolveSelf must return the caller's WID, not 'me'.");
  const { reports, truncated } = await listIndirectReports(adapter, self, INDIRECT_REPORTS_MAX_DEPTH);
  const scope: TeamScope = Object.freeze({
    managerWid: self.id,
    memberIds: new Set(reports.map((r) => r.id)),
    truncated,
    expiresAt: now + TEAM_SCOPE_TTL_MS,
  });
  MINTED.add(scope);
  return scope;
}

/** True only for a TeamScope minted by verifyTeamScope, unexpired, and (when known) for this caller. */
export function isValidTeamScope(
  scope: TeamScope | undefined,
  callerWid?: string,
  now: number = Date.now(),
): scope is TeamScope {
  if (!scope || !MINTED.has(scope)) return false;
  if (scope.expiresAt < now) return false;
  if (callerWid && scope.managerWid !== callerWid) return false;
  return true;
}

export function isInVerifiedTeam(
  scope: TeamScope | undefined,
  targetWid: string | undefined,
  callerWid?: string,
): boolean {
  return !!targetWid && isValidTeamScope(scope, callerWid) && scope.memberIds.has(targetWid);
}
