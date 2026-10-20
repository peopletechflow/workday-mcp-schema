/**
 * Org-scope gate (hr-partner-skill, and manager org-chart reads).
 *
 * Rule (hr-partner-skill): verify the target worker/org is within the HR partner's supervisory
 * orgs (list_worker_organizations / find_staffing_supervisory_organization) before every action;
 * on 403 do not retry. For managers, the root orgs are the orgs they manage ("own team orgs").
 *
 * verifyOrgScope() walks root orgs + descendants (get_org_chart_children, depth cap 5) and mints
 * an OrgScope; verifyWorkerInOrgScope() mints a per-worker proof from the worker's org
 * memberships. Both are tracked in WeakSets (only this module can mint them), carry a TTL and
 * are bound to the caller's WID and a basis (hr_partner | manager). A truncated walk never widens
 * access: orgs beyond the cap are not members.
 */
import type { RecipeRef } from "../agent-ready/recipes.js";

export const ORG_SCOPE_MAX_DEPTH = 5;
export const ORG_SCOPE_TTL_MS = 5 * 60 * 1000;

export type OrgScopeBasis = "hr_partner" | "manager";

export type OrgScope = {
  readonly basis: OrgScopeBasis;
  readonly callerWid: string;
  readonly orgIds: ReadonlySet<string>;
  readonly truncated: boolean;
  readonly expiresAt: number;
};

export type WorkerOrgProof = {
  readonly basis: OrgScopeBasis;
  readonly callerWid: string;
  readonly workerWid: string;
  /** The in-scope org that made the worker eligible. */
  readonly viaOrgId: string;
  readonly expiresAt: number;
};

export type OrgScopeAdapter = {
  /** find_staffing_workers(contextInstanceId "me") -> caller's WID. */
  resolveSelf(): Promise<RecipeRef>;
  /** hr_partner: supported supervisory orgs; manager: orgs the caller manages. */
  listRootOrgIds(): Promise<string[]>;
  /** get_org_chart_children(org) -> child org WIDs. */
  listChildOrgIds(orgId: string): Promise<string[]>;
};

export class OrgScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrgScopeError";
  }
}

const SCOPES = new WeakSet<OrgScope>();
const PROOFS = new WeakSet<WorkerOrgProof>();

export async function verifyOrgScope(basis: OrgScopeBasis, adapter: OrgScopeAdapter, now: number = Date.now()): Promise<OrgScope> {
  const self = await adapter.resolveSelf();
  if (!self.id || self.id === "me") throw new OrgScopeError("resolveSelf must return the caller's WID, not 'me'.");
  const orgIds = new Set<string>();
  let truncated = false;
  let frontier = [...new Set(await adapter.listRootOrgIds())];
  for (const id of frontier) orgIds.add(id);
  for (let depth = 1; frontier.length; depth++) {
    const next: string[] = [];
    for (const org of frontier) {
      for (const child of await adapter.listChildOrgIds(org)) {
        if (orgIds.has(child)) continue;
        if (depth > ORG_SCOPE_MAX_DEPTH) {
          truncated = true;
          continue;
        }
        orgIds.add(child);
        next.push(child);
      }
    }
    frontier = next;
  }
  const scope: OrgScope = Object.freeze({ basis, callerWid: self.id, orgIds, truncated, expiresAt: now + ORG_SCOPE_TTL_MS });
  SCOPES.add(scope);
  return scope;
}

export function isValidOrgScope(scope: OrgScope | undefined, basis: OrgScopeBasis, callerWid?: string, now: number = Date.now()): scope is OrgScope {
  return !!scope && SCOPES.has(scope) && scope.basis === basis && scope.expiresAt >= now && !!callerWid && scope.callerWid === callerWid;
}

export function isOrgInScope(scope: OrgScope | undefined, orgId: string | undefined, basis: OrgScopeBasis, callerWid?: string): boolean {
  return !!orgId && isValidOrgScope(scope, basis, callerWid) && scope.orgIds.has(orgId);
}

/**
 * Mint a per-worker proof: the worker's org memberships (list_worker_organizations, supervisory
 * orgs) must intersect the scope. Throws OrgScopeError (refuse) otherwise.
 */
export async function verifyWorkerInOrgScope(
  scope: OrgScope,
  workerWid: string,
  listWorkerOrgIds: (workerWid: string) => Promise<string[]>,
  now: number = Date.now(),
): Promise<WorkerOrgProof> {
  if (!SCOPES.has(scope) || scope.expiresAt < now) throw new OrgScopeError("Org scope is not verified or has expired.");
  const via = (await listWorkerOrgIds(workerWid)).find((o) => scope.orgIds.has(o));
  if (!via) throw new OrgScopeError(`Worker ${workerWid} is outside your organization scope.`);
  const proof: WorkerOrgProof = Object.freeze({
    basis: scope.basis,
    callerWid: scope.callerWid,
    workerWid,
    viaOrgId: via,
    expiresAt: Math.min(scope.expiresAt, now + ORG_SCOPE_TTL_MS),
  });
  PROOFS.add(proof);
  return proof;
}

export function isWorkerInOrgScope(
  proof: WorkerOrgProof | undefined,
  workerWid: string | undefined,
  basis: OrgScopeBasis,
  callerWid?: string,
  now: number = Date.now(),
): boolean {
  return (
    !!proof && PROOFS.has(proof) && !!workerWid && proof.workerWid === workerWid && proof.basis === basis &&
    !!callerWid && proof.callerWid === callerWid && proof.expiresAt >= now
  );
}

/** Post-filter search results (e.g. find_org_chart_organizations) to the verified org scope. */
export function filterToOrgScope<T>(scope: OrgScope, items: readonly T[], orgIdOf: (item: T) => string): T[] {
  if (!SCOPES.has(scope)) throw new OrgScopeError("Org scope is not verified.");
  return items.filter((i) => scope.orgIds.has(orgIdOf(i)));
}
