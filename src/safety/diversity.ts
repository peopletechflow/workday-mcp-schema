/**
 * Aggregate-only diversity (hr-partner-skill). Ethnicity is GDPR Art. 9 special-category data.
 *
 * The tenant offers no aggregate report, so the skill assembles diversity client-side from org
 * members + find_worker_personal_information. This module is the ONLY place that may do that in
 * the external layer, and its output is counts per bucket:
 *   - minimum group size k = 5: buckets with fewer members are dropped (not even their label is
 *     returned, so the presence of a small group is not disclosed)
 *   - complementary suppression: if suppressed buckets add up to < k, the suppressed total and the
 *     overall total are hidden too, so suppressed counts cannot be derived by subtraction
 *   - populations smaller than k return nothing but `suppressed: true`
 *   - no worker ids, names or per-person values ever leave this function
 * RBAC: recipe `aggregate_diversity` — hr_partner (OrgScope proof for the org) and admin only.
 */
import { DIVERSITY_MIN_GROUP_SIZE } from "../agent-ready/recipes.js";
import { assertAgentReadyCallAllowed, type AgentReadyCallContext } from "../rbac/agent-ready.js";
import type { Role } from "../rbac/roles.js";

export const NOT_DISCLOSED = "Not disclosed";

export type DiversityBucket = { bucket: string; count: number };
export type DiversityAggregate = {
  orgId: string;
  minGroupSize: number;
  /** null when it would reveal suppressed counts. */
  population: number | null;
  /** All buckets suppressed because the population is below k. */
  suppressed: boolean;
  buckets: DiversityBucket[];
  /** Sum of suppressed (unlabelled) buckets, only when >= k (otherwise null). */
  suppressedTotal: number | null;
};

/** Pure aggregation over bucket labels (one per person; null/blank = not disclosed). */
export function aggregateBuckets(
  orgId: string,
  values: Iterable<string | null | undefined>,
  k: number = DIVERSITY_MIN_GROUP_SIZE,
): DiversityAggregate {
  const minGroupSize = Math.max(k, DIVERSITY_MIN_GROUP_SIZE); // never below 5
  const counts = new Map<string, number>();
  let population = 0;
  for (const v of values) {
    const b = v && v.trim() ? v.trim() : NOT_DISCLOSED;
    counts.set(b, (counts.get(b) ?? 0) + 1);
    population++;
  }
  if (population < minGroupSize) {
    return { orgId, minGroupSize, population: null, suppressed: true, buckets: [], suppressedTotal: null };
  }
  const buckets: DiversityBucket[] = [...counts.entries()]
    .filter(([, count]) => count >= minGroupSize)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, count]) => ({ bucket, count }));
  const suppressedSum = [...counts.values()].filter((c) => c < minGroupSize).reduce((a, c) => a + c, 0);
  const leaky = suppressedSum > 0 && suppressedSum < minGroupSize;
  return {
    orgId,
    minGroupSize,
    population: leaky ? null : population,
    suppressed: false,
    buckets,
    suppressedTotal: suppressedSum >= minGroupSize ? suppressedSum : null,
  };
}

export type DiversityAdapter = {
  /** list_organization_members(org), fully paged -> member WIDs. */
  listMemberIds(orgId: string): Promise<string[]>;
  /** find_worker_personal_information(worker) -> ethnicity label (or null if not disclosed). */
  ethnicityOf(workerWid: string): Promise<string | null>;
};

/**
 * RBAC-checked aggregate. ctx must carry the org as contextInstanceId plus an hr_partner OrgScope
 * (admin: any org). Per-person values are consumed in memory and discarded.
 */
export async function computeDiversityAggregate(
  roles: readonly Role[],
  ctx: AgentReadyCallContext & { contextInstanceId: string },
  adapter: DiversityAdapter,
): Promise<DiversityAggregate> {
  assertAgentReadyCallAllowed(roles, "aggregate_diversity", ctx);
  const members = await adapter.listMemberIds(ctx.contextInstanceId);
  const values: (string | null)[] = [];
  for (const m of members) values.push(await adapter.ethnicityOf(m));
  return aggregateBuckets(ctx.contextInstanceId, values);
}
