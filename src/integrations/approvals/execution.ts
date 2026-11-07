/**
 * Application approval execution path for time off.
 *
 * propose: validated form -> server-side type mapping -> existing preview core (caller token,
 *   preview store) -> approval request whose hashed change contains the exact Workday payload,
 *   the target, and a sha256 fingerprint of the preview token. The raw preview token stays in
 *   this service's memory only (never in Slack metadata, buttons, or model output).
 * commitApproved: caller identity comes from a verified channel (signed Slack command), never
 *   from a body. The executor is fixed inside this service: it re-reads the preview, checks it
 *   still equals the approved payload, then calls the existing commit core with the requester's
 *   own Workday token and idempotency key.
 */
import { createHash } from "node:crypto";
import type { Role } from "../../rbac/roles.js";
import type { AssignmentStore } from "../../rbac/assignments.js";
import { assertToolAllowedForUser } from "../../rbac/user-enforce.js";
import { canonicalJson, ApprovalError, type ApprovalRequest, type ApprovalWorkflow } from "./workflow.js";
import type { BoundIdentity } from "../identity.js";
import { COMMIT_TOOL, PREVIEW_TOOL, commitTimeOffPreview, createTimeOffPreview, type TimeOffCoreDeps, type TimeOffPreviewInput } from "../../tools/time-off-core.js";
import { PREVIEW_TTL_SECONDS } from "../../tools/framework.js";

export type FormTimeOff = { startDate: string; endDate: string; timeOffType: string; quantity: number; comment?: string };
export type AuthzResolver = (identity: BoundIdentity) => { roles: readonly Role[]; assignments?: AssignmentStore };

/** Server-side mapping from form choice to the tenant's Workday time-off type id. */
export type TimeOffTypeMap = Record<string, { type: "Time_Off_Type_ID" | "Absence_Table_ID" | "WID"; value: string }>;

const fp = (token: string) => createHash("sha256").update(token).digest("hex");

export class ApprovalExecutionService {
  private readonly previewTokens = new Map<string, string>();

  constructor(
    private readonly deps: {
      workflow: ApprovalWorkflow;
      core: TimeOffCoreDeps;
      authzFor: AuthzResolver;
      typeMap: TimeOffTypeMap;
    },
  ) {
    if (deps.workflow.ttlMs > PREVIEW_TTL_SECONDS * 1000) {
      throw new Error("Approval TTL must not exceed preview TTL (fail closed).");
    }
  }

  private assertTenant(identity: BoundIdentity): void {
    // TokenStore and Workday config are single-tenant per deployment.
    if (identity.tenantId !== this.deps.core.config.workdayTenant) {
      throw new ApprovalError("CROSS_TENANT", "Identity tenant does not match this deployment's Workday tenant.");
    }
  }

  async proposeTimeOff(requester: BoundIdentity, form: FormTimeOff, source: ApprovalRequest["source"]): Promise<ApprovalRequest> {
    this.assertTenant(requester);
    const authz = this.deps.authzFor(requester);
    for (const toolName of [PREVIEW_TOOL, COMMIT_TOOL]) {
      assertToolAllowedForUser({ userId: requester.userId, roles: authz.roles, toolName, assignments: authz.assignments });
    }
    const type = this.deps.typeMap[form.timeOffType];
    if (!type) throw new ApprovalError("UNKNOWN_TYPE", "Time-off type is not mapped for this tenant.");
    const input: TimeOffPreviewInput = {
      startDate: form.startDate,
      endDate: form.endDate,
      unit: "DAYS",
      quantity: form.quantity,
      timeOffType: { ...type },
      ...(form.comment ? { comment: form.comment } : {}),
    };
    const preview = await createTimeOffPreview(this.deps.core, requester.userId, input);
    const req = this.deps.workflow.propose({
      requester,
      authz,
      commitTool: COMMIT_TOOL,
      resource: `worker:${requester.userId}:self`,
      change: { kind: "request_time_off", willSubmit: preview.willSubmit, previewFingerprint: fp(preview.previewToken) },
      summary: preview.summary,
      source,
    });
    this.previewTokens.set(req.id, preview.previewToken);
    return req;
  }

  /** Commit an approved request. `caller` must come from a verified channel identity. */
  async commitApproved(caller: BoundIdentity, requestId: string, idempotencyKey: string): Promise<unknown> {
    this.assertTenant(caller);
    const authz = this.deps.authzFor(caller);
    const { core } = this.deps;
    return this.deps.workflow.commit({
      requestId,
      caller,
      authz,
      idempotencyKey,
      executor: async (req) => {
        const token = this.previewTokens.get(req.id);
        if (!token || fp(token) !== req.change.previewFingerprint) throw new ApprovalError("PREVIEW_MISSING", "Preview token missing or does not match approval.");
        const live = core.previewStore.peek(token, req.requesterUserId, "request_time_off");
        if (!live) throw new ApprovalError("PREVIEW_EXPIRED", "Preview expired or already used. Start a new request.");
        const { kind: _k, userId: _u, summary: _s, expiresAt: _e, ...payload } = live;
        if (canonicalJson(payload) !== canonicalJson(req.change.willSubmit)) throw new ApprovalError("PREVIEW_CHANGED", "Preview differs from approved change.");
        const out = await commitTimeOffPreview(core, req.requesterUserId, token, idempotencyKey);
        this.previewTokens.delete(req.id);
        if (out.replayed && out.status === "error") throw new ApprovalError("COMMIT_FAILED", "Earlier commit with this key failed.");
        return out.body;
      },
    });
  }

  status(caller: BoundIdentity, requestId: string): { status: string; summary: string } {
    const r = this.deps.workflow.get(requestId);
    if (!r || r.tenantId !== caller.tenantId || (r.requesterUserId !== caller.userId && !r.assignedApprovers.includes(caller.userId))) {
      throw new ApprovalError("NOT_FOUND", "Unknown approval request.");
    }
    return { status: r.status, summary: r.summary };
  }
}

export const DEFAULT_TIME_OFF_TYPE_MAP: TimeOffTypeMap = {
  vacation: { type: "Time_Off_Type_ID", value: "VACATION" },
  sick: { type: "Time_Off_Type_ID", value: "SICK" },
  personal: { type: "Time_Off_Type_ID", value: "PERSONAL" },
};
