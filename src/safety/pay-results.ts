/**
 * Pay result response shaping (payroll-viewer-skill).
 *
 * Rule (payroll-viewer-skill, "Pay Results by Group and Period"): present results as a summary
 * (pay group, period dates, result count, statuses). Do not expand individual worker-level pay
 * lines unless the caller is a payroll viewer and asks explicitly.
 *
 * This module is the ONLY place in the external layer that may turn
 * payroll_payroll_results_for_pay_group_detail_and_period_prompt output into a response:
 *   - default: summary only (result count + count per calculation status); no worker ids,
 *     names or amounts leave this function
 *   - worker-level lines only when the caller holds payroll_viewer AND the request sets
 *     `explicitDetail: true` (the user asked for line detail in this request; never inferred)
 *   - every other role, admin included, gets the summary
 * RBAC: the call is checked with assertAgentReadyCallAllowed first, so the pay group detail ID
 * still needs the pay-group proof (src/rbac/pay-group-scope.ts) for payroll_viewer.
 */
import { assertAgentReadyCallAllowed, type AgentReadyCallContext } from "../rbac/agent-ready.js";
import type { Role } from "../rbac/roles.js";

export const PAY_RESULTS_TOOL = "payroll_payroll_results_for_pay_group_detail_and_period_prompt";
export const UNKNOWN_STATUS = "Unknown";

/** One worker-level result line as returned by Workday (shape passthrough beyond these fields). */
export type PayResultLine = { workerId: string; status?: string | null; [field: string]: unknown };

export type PayResultsRequest = {
  /** true only when the user explicitly asked for worker-level lines in this request. */
  explicitDetail?: boolean;
};

export type PayResultsSummary = {
  mode: "summary";
  payGroupDetailId: string;
  periodId: string;
  periodStart: string | null;
  periodEnd: string | null;
  resultCount: number;
  statuses: { status: string; count: number }[];
  /** Why lines were withheld (shown to the user so they know detail exists). */
  linesWithheld: string | null;
};
export type PayResultsDetail = Omit<PayResultsSummary, "mode" | "linesWithheld"> & { mode: "detail"; lines: PayResultLine[] };
export type ShapedPayResults = PayResultsSummary | PayResultsDetail;

export type PayResultsInput = {
  payGroupDetailId: string;
  periodId: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  lines: readonly PayResultLine[];
};

/** Worker-level lines: payroll_viewer + explicit request only. */
export function mayReturnPayResultLines(roles: readonly Role[], request: PayResultsRequest = {}): boolean {
  return roles.includes("payroll_viewer") && request.explicitDetail === true;
}

/** Pure shaping. Summary carries counts and statuses only. */
export function shapePayResults(roles: readonly Role[], request: PayResultsRequest, input: PayResultsInput): ShapedPayResults {
  const counts = new Map<string, number>();
  for (const l of input.lines) {
    const s = typeof l.status === "string" && l.status.trim() ? l.status.trim() : UNKNOWN_STATUS;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const base = {
    payGroupDetailId: input.payGroupDetailId,
    periodId: input.periodId,
    periodStart: input.periodStart ?? null,
    periodEnd: input.periodEnd ?? null,
    resultCount: input.lines.length,
    statuses: [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) => ({ status, count })),
  };
  if (mayReturnPayResultLines(roles, request)) return { ...base, mode: "detail", lines: input.lines.map((l) => ({ ...l })) };
  return {
    ...base,
    mode: "summary",
    linesWithheld:
      input.lines.length === 0
        ? null
        : roles.includes("payroll_viewer")
          ? "Worker-level lines are shown only when you explicitly ask for them."
          : "Worker-level pay lines are available to payroll viewers only.",
  };
}

export type PayResultsAdapter = {
  /** payroll_payroll_results_for_pay_group_detail_and_period_prompt(detail, period), fully paged. */
  fetch(payGroupDetailId: string, periodId: string): Promise<Omit<PayResultsInput, "payGroupDetailId" | "periodId">>;
};

/**
 * RBAC-checked fetch + shaping. ctx must carry the pay group detail as payGroupId plus, for
 * payroll_viewer, a PayGroupSession in which that ID was listed (admin: any detail).
 */
export async function getPayResults(
  roles: readonly Role[],
  ctx: AgentReadyCallContext & { payGroupId: string },
  periodId: string,
  request: PayResultsRequest,
  adapter: PayResultsAdapter,
): Promise<ShapedPayResults> {
  assertAgentReadyCallAllowed(roles, PAY_RESULTS_TOOL, ctx);
  const r = await adapter.fetch(ctx.payGroupId, periodId);
  return shapePayResults(roles, request, { ...r, payGroupDetailId: ctx.payGroupId, periodId });
}
