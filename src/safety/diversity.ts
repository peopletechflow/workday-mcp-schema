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
 *
 * admin-skill Rule 3: any read touching MORE THAN ONE worker's demographic data (personal
 * information, ethnicity, gender, marital status) must go through this filter:
 * assertSingleWorkerDemographicRead() refuses per-person demographic reads spanning several
 * workers, and computeDemographicAggregate() returns the same k >= 5 bucket counts for any
 * demographic dimension.
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

/** Tools whose output (or use) carries demographic data. */
export const DEMOGRAPHIC_TOOLS: ReadonlySet<string> = new Set([
  "find_worker_personal_information",
  "find_ethnicity",
  "find_ethnicity_details",
  "list_active_genders",
  "list_active_marital_statuses",
]);
export type DemographicDimension = "ethnicity" | "gender" | "marital_status";

export class AggregateOnlyError extends Error {
  constructor(tool: string, workers: number) {
    super(
      `'${tool}' touches demographic data for ${workers} workers: per-person output is not allowed. ` +
        "Use computeDemographicAggregate (counts per bucket, groups under 5 suppressed).",
    );
    this.name = "AggregateOnlyError";
  }
}

/** Per-person demographic reads are allowed for at most ONE worker per request. */
export function assertSingleWorkerDemographicRead(tool: string, workerIds: readonly string[]): void {
  if (!DEMOGRAPHIC_TOOLS.has(tool)) return;
  const n = new Set(workerIds.map((w) => w.trim()).filter(Boolean)).size;
  if (n > 1) throw new AggregateOnlyError(tool, n);
}

export type DemographicAdapter = {
  listMemberIds(orgId: string): Promise<string[]>;
  /** find_worker_personal_information(worker) -> label for the dimension (null = not disclosed). */
  attributeOf(workerWid: string, dimension: DemographicDimension): Promise<string | null>;
};

/** Same RBAC and k >= 5 suppression as computeDiversityAggregate, for any dimension. */
export async function computeDemographicAggregate(
  roles: readonly Role[],
  ctx: AgentReadyCallContext & { contextInstanceId: string },
  dimension: DemographicDimension,
  adapter: DemographicAdapter,
): Promise<DiversityAggregate & { dimension: DemographicDimension }> {
  assertAgentReadyCallAllowed(roles, "aggregate_diversity", ctx);
  const members = await adapter.listMemberIds(ctx.contextInstanceId);
  const values: (string | null)[] = [];
  for (const m of members) values.push(await adapter.attributeOf(m, dimension));
  return { ...aggregateBuckets(ctx.contextInstanceId, values), dimension };
}
