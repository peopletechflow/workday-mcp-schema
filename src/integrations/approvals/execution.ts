/**
 * Durable approval execution for self-service time off.
 *
 * propose: caller identity (verified channel) -> entitlements -> server-side type map ->
 *   exact Workday payload stored in the approval (hash bound to tenant, requester, tool, target).
 *   Requires the requester to have a linked Workday token (no anonymous previews).
 * commitApproved: caller identity from a verified channel only; the executor is fixed here.
 *   lookupCommit (read-only: owner, tenant, RBAC, finished ledger result) -> requester's own
 *   token (new executions only, no row lock held) -> beginCommit (row lock + ledger) -> duplicate check -> submit ->
 *   finishCommit. Definitive Workday 4xx -> failed. Timeout / 5xx / no id -> unknown (never
 *   auto-resubmitted). Contract-unvalidated operations fail before any state change.
 */
import { assertToolAllowedForUser } from "../../rbac/user-enforce.js";
import type { Role } from "../../rbac/roles.js";
import type { AssignmentStore } from "../../rbac/assignments.js";
import { ApprovalError, type ApprovalRequest } from "./workflow.js";
import type { BoundIdentity } from "../identity.js";
import type { DbApprovalBackend } from "../../store/approvals.js";
import type { WorkdayClient } from "../../workday/client.js";
import { buildRequestTimeOffBody, WorkdayApiError, WorkdayRequestValidationError } from "../../workday/client.js";
import { classifyCommitFailure } from "../../safety/commit-outcome.js";
import { LinkRequiredError, type AccessTokenProvider } from "../../auth/user-tokens.js";
import { AbsenceTypeIdSchema } from "../../schemas/common.js";
import type { TimeOffRequestInput } from "../../workday/types.js";
import type { LogFn } from "../../observability/log.js";
import type { Queryable } from "../../store/db.js";

export const COMMIT_TOOL = "commit_request_time_off";
export const PREVIEW_TOOL = "preview_request_time_off";

export type FormTimeOff = {
  startDate: string;
  endDate: string;
  timeOffType: string;
  quantity: number;
  comment?: string | undefined;
};
export type AuthzResolver = (
  identity: BoundIdentity,
) => Promise<{ roles: readonly Role[]; assignments?: AssignmentStore }>;
export type TimeOffTypeMap = Record<string, { type: "Time_Off_Type_ID" | "Absence_Table_ID" | "WID"; value: string }>;

export class ApprovalExecutionService {
  constructor(
    private readonly d: {
      tenantId: string;
      backend: DbApprovalBackend;
      client: WorkdayClient;
      accessToken: AccessTokenProvider;
      /**
       * Cheap "has a stored Workday link" check for the Slack ack paths (3 s limit). When set,
       * propose does not refresh the token; the refresh happens at commit, off the ack path.
       * When absent, propose resolves a usable access token (may call the token endpoint).
       */
      linked?: ((userId: string) => Promise<boolean>) | undefined;
      authzFor: AuthzResolver;
      typeMap: TimeOffTypeMap;
      /** Operations required for a commit; checked before any state change. */
      assertCommitContract?: (() => void) | undefined;
      log?: LogFn | undefined;
    },
  ) {}

  private assertTenant(identity: BoundIdentity): void {
    if (identity.tenantId !== this.d.tenantId)
      throw new ApprovalError("CROSS_TENANT", "Identity tenant does not match this deployment's Workday tenant.");
  }

  /**
   * Everything propose checks except creating the request: entitlements, type mapping, date
   * range, Workday payload shape, and a usable linked token. Safe to call before consuming a
   * form session, so a fixable error keeps the form open. Throws ApprovalError / RbacDeniedError
   * / LinkRequiredError / TokenRefreshUnavailableError.
   */
  async checkTimeOff(
    requester: BoundIdentity,
    form: FormTimeOff,
  ): Promise<{ authz: Awaited<ReturnType<AuthzResolver>>; willSubmit: TimeOffRequestInput }> {
    this.assertTenant(requester);
    const authz = await this.d.authzFor(requester);
    for (const toolName of [PREVIEW_TOOL, COMMIT_TOOL]) {
      assertToolAllowedForUser({
        userId: requester.userId,
        roles: authz.roles,
        toolName,
        assignments: authz.assignments,
      });
    }
    const type = this.d.typeMap[form.timeOffType];
    if (!type) throw new ApprovalError("UNKNOWN_TYPE", "Time-off type is not mapped for this tenant.");
    if (form.endDate < form.startDate) throw new ApprovalError("BAD_RANGE", "End date before start date.");
    const willSubmit: TimeOffRequestInput = {
      startDate: form.startDate,
      endDate: form.endDate,
      unit: "DAYS",
      quantity: form.quantity,
      timeOffType: AbsenceTypeIdSchema.parse(type),
      ...(form.comment ? { comment: form.comment } : {}),
    };
    // Reject payloads Workday cannot accept now, not after an approver has spent time on them.
    try {
      buildRequestTimeOffBody(willSubmit);
    } catch (e) {
      if (e instanceof WorkdayRequestValidationError) throw new ApprovalError("INVALID_REQUEST", e.message);
      throw e;
    }
    // Must be linked. With `linked` this is a local read (no token endpoint call inside a Slack ack);
    // a dead refresh token then surfaces at commit, where the request stays approved for a re-link.
    if (this.d.linked) {
      if (!(await this.d.linked(requester.userId))) throw new LinkRequiredError();
    } else {
      await this.d.accessToken(requester.userId);
    }
    return { authz, willSubmit };
  }

  async proposeTimeOff(
    requester: BoundIdentity,
    form: FormTimeOff,
    source: ApprovalRequest["source"],
    opts: { claim?: (q: Queryable) => Promise<boolean> } = {},
  ): Promise<ApprovalRequest> {
    const { authz, willSubmit } = await this.checkTimeOff(requester, form);
    const summary = `Time off ${form.timeOffType} ${form.startDate} to ${form.endDate} (${form.quantity} days)`;
    const req = await this.d.backend.propose({
      requester,
      authz,
      commitTool: COMMIT_TOOL,
      resource: `worker:${requester.userId}:self`,
      change: { kind: "request_time_off", willSubmit },
      summary,
      source,
      ...(opts.claim ? { claim: opts.claim } : {}),
    });
    this.d.log?.({ evt: "approval.proposed", req: req.id, source });
    return req;
  }

  async commitApproved(caller: BoundIdentity, requestId: string, idempotencyKey: string): Promise<unknown> {
    this.assertTenant(caller);
    this.d.assertCommitContract?.();
    const authz = await this.d.authzFor(caller);
    // 1. Read-only check: requester, tenant and permission first; a finished commit is returned
    //    from the ledger without refreshing or re-linking the Workday token.
    const seen = await this.d.backend.lookupCommit({ requestId, caller, authz });
    if (seen.kind === "replay") return seen.result;
    // 2. New execution only: resolve the requester's token with no approval row lock held. A
    //    missing link or an outage leaves the request 'approved' for a re-link / retry.
    // 3. beginCommit re-checks everything under the row lock and claims the ledger (races replay).
    const token = await this.d.accessToken(caller.userId);
    const begun = await this.d.backend.beginCommit({ requestId, caller, authz, idempotencyKey });
    if (begun.kind === "replay") return begun.result;
    const req = begun.request;
    const input = (req.change as { willSubmit: TimeOffRequestInput }).willSubmit;
    try {
      const existing = await this.d.client.findMatchingTimeOffRequest(token, input);
      const result = existing ?? (await this.d.client.submitTimeOffRequest(token, input));
      const body = { submitted: !existing, reusedExisting: Boolean(existing), request: result };
      await this.d.backend.finishCommit(req.id, { state: "ok", body });
      this.d.log?.({ evt: "approval.committed", req: req.id, reused: Boolean(existing) });
      return body;
    } catch (e) {
      const state = classifyCommitFailure(e);
      await this.d.backend.finishCommit(req.id, {
        state,
        body: { error: e instanceof WorkdayApiError ? e.fault.code : e instanceof Error ? e.name : "error" },
      });
      this.d.log?.({ evt: "approval.commit_failed", req: req.id, state });
      if (state === "unknown")
        throw new ApprovalError(
          "COMMIT_UNCERTAIN",
          "Workday did not confirm the result. It will not be resubmitted automatically; an operator will reconcile.",
        );
      throw e;
    }
  }

  async status(caller: BoundIdentity, requestId: string): Promise<{ status: string; summary: string }> {
    const r = await this.d.backend.get(requestId);
    if (
      !r ||
      r.tenantId !== caller.tenantId ||
      (r.requesterUserId !== caller.userId && !r.assignedApprovers.includes(caller.userId))
    ) {
      throw new ApprovalError("NOT_FOUND", "Unknown approval request.");
    }
    return { status: r.status, summary: r.summary };
  }

  /**
   * Operator reconcile for unknown / stale requests: reads Workday (duplicate check) with the
   * requester's token. Found -> committed. Not found -> stays uncertain unless the operator
   * explicitly confirms it was not submitted (then failed; the user starts a new request).
   */
  async reconcile(actor: string, requestId: string, confirmNotSubmitted = false): Promise<string> {
    const req = await this.d.backend.get(requestId);
    if (!req || req.tenantId !== this.d.tenantId) throw new ApprovalError("NOT_FOUND", "Unknown approval request.");
    const input = (req.change as { willSubmit: TimeOffRequestInput }).willSubmit;
    const token = await this.d.accessToken(req.requesterUserId);
    const found = await this.d.client.findMatchingTimeOffRequest(token, input);
    if (found) {
      await this.d.backend.resolveUncertain(actor, requestId, {
        state: "ok",
        body: { submitted: true, reconciled: true, request: found },
      });
      return "committed";
    }
    if (confirmNotSubmitted) {
      await this.d.backend.resolveUncertain(actor, requestId, {
        state: "error",
        body: { error: "NOT_SUBMITTED_CONFIRMED" },
      });
      return "failed";
    }
    return "still_unknown";
  }
}

export const DEFAULT_TIME_OFF_TYPE_MAP: TimeOffTypeMap = {};

/** Parse WORKDAY_TIME_OFF_TYPE_MAP JSON: {"vacation":{"type":"Time_Off_Type_ID","value":"..."}} */
export function parseTypeMap(raw: string | undefined): TimeOffTypeMap {
  if (!raw) return {};
  const v = JSON.parse(raw) as Record<string, { type?: string; value?: string }>;
  const out: TimeOffTypeMap = {};
  for (const [k, x] of Object.entries(v)) {
    if (!["vacation", "sick", "personal"].includes(k)) throw new Error(`Unknown form type ${k}`);
    if (!x.value || !["Time_Off_Type_ID", "Absence_Table_ID", "WID"].includes(String(x.type)))
      throw new Error(`Bad type map entry ${k}`);
    out[k] = { type: x.type as TimeOffTypeMap[string]["type"], value: x.value };
  }
  return out;
}
