/**
 * Durable approval backend (Postgres). All state transitions are conditional updates inside
 * transactions with row locks, so any number of app instances can share one database.
 *
 * Commit protocol (no automatic duplicate submits):
 *   beginCommit  (tx): lock request, validate, ledger row 'in_flight', status 'committing'
 *   [Workday call outside tx]
 *   finishCommit (tx): ledger + request -> ok/committed | error/failed | unknown/unknown
 * A crash between begin and finish leaves 'committing' + 'in_flight'. Those, and 'unknown',
 * are never retried automatically; `reconcile` reads Workday to decide.
 */
import { randomBytes } from "node:crypto";
import type { Db, Queryable } from "./db.js";
import { adminAudit } from "./repos.js";
import {
  ApprovalError,
  canonicalJson,
  hashChange,
  type ApprovalRequest,
  type ApprovalDecider,
} from "../integrations/approvals/workflow.js";
import type { BoundIdentity } from "../integrations/identity.js";
import { assertToolAllowedForUser } from "../rbac/user-enforce.js";
import type { Role } from "../rbac/roles.js";
import type { AssignmentStore } from "../rbac/assignments.js";
import { isCommitTool } from "../tools/registry.js";

type Authz = { roles: readonly Role[]; assignments?: AssignmentStore };

type DbRow = {
  id: string;
  tenant_id: string;
  requester_user_id: string;
  commit_tool: string;
  resource: string;
  change: Record<string, unknown>;
  change_hash: string;
  summary: string;
  status: ApprovalRequest["status"];
  created_ms: string;
  expires_ms: string;
  assigned_approvers: string[];
  decided_by: string | null;
  decided_ms: string | null;
  source: ApprovalRequest["source"];
  result: unknown;
  updated_ms: string;
  /** Expiry evaluated by the database clock, so app-server clock skew cannot extend a window. */
  is_expired: boolean;
};
const COLS = `id, tenant_id, requester_user_id, commit_tool, resource, change, change_hash, summary, status,
  extract(epoch from created_at)*1000 AS created_ms, extract(epoch from expires_at)*1000 AS expires_ms,
  assigned_approvers, decided_by, extract(epoch from decided_at)*1000 AS decided_ms, source, result,
  extract(epoch from updated_at)*1000 AS updated_ms, (expires_at < now()) AS is_expired`;

function toReq(r: DbRow): ApprovalRequest {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    requesterUserId: r.requester_user_id,
    commitTool: r.commit_tool,
    resource: r.resource,
    change: r.change,
    changeHash: r.change_hash,
    summary: r.summary,
    status: r.status,
    createdAt: Number(r.created_ms),
    expiresAt: Number(r.expires_ms),
    assignedApprovers: r.assigned_approvers,
    ...(r.decided_by ? { decidedBy: r.decided_by } : {}),
    ...(r.decided_ms ? { decidedAt: Number(r.decided_ms) } : {}),
    source: r.source,
    ...(r.result != null ? { result: r.result } : {}),
  };
}

export type BeginCommit = { kind: "execute"; request: ApprovalRequest } | { kind: "replay"; result: unknown };
export type CommitOutcome =
  { state: "ok"; body: unknown } | { state: "error"; body: unknown } | { state: "unknown"; body: unknown };

type Locked = { req: ApprovalRequest; expired: boolean };

const HOUR_MS = 60 * 60 * 1000;

export class DbApprovalBackend implements ApprovalDecider {
  /**
   * @param decisionTtlMs  time an approver has to decide after propose
   * @param staleCommitMs  'committing' older than this is surfaced for reconcile
   * @param commitWindowMs time the requester has to submit after approval
   */
  constructor(
    private readonly db: Db,
    readonly decisionTtlMs = 72 * HOUR_MS,
    readonly staleCommitMs = 10 * 60 * 1000,
    readonly commitWindowMs = 24 * HOUR_MS,
  ) {}

  async setPolicy(
    actor: string,
    p: {
      tenantId: string;
      commitTool: string;
      approverUserIds: string[];
      allowSelfApproval?: boolean;
      rotate?: boolean;
    },
  ): Promise<void> {
    if (!isCommitTool(p.commitTool)) throw new Error(`Not a commit tool: ${p.commitTool}`);
    if (!p.approverUserIds.length) throw new Error("At least one approver required.");
    await this.db.tx(async (q) => {
      await q.query(
        `INSERT INTO approval_policies (tenant_id, commit_tool, approver_user_ids, allow_self_approval, rotate, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, commit_tool) DO UPDATE SET approver_user_ids = EXCLUDED.approver_user_ids, allow_self_approval = EXCLUDED.allow_self_approval, rotate = EXCLUDED.rotate, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [p.tenantId, p.commitTool, p.approverUserIds, p.allowSelfApproval ?? false, p.rotate ?? false, actor],
      );
      await adminAudit(q, actor, "policy.set", p);
    });
  }

  private async policy(q: Queryable, tenantId: string, commitTool: string, lock = false) {
    const r = await q.query<{
      approver_user_ids: string[];
      allow_self_approval: boolean;
      rotate: boolean;
      rotation_counter: string;
    }>(
      `SELECT approver_user_ids, allow_self_approval, rotate, rotation_counter FROM approval_policies WHERE tenant_id = $1 AND commit_tool = $2${lock ? " FOR UPDATE" : ""}`,
      [tenantId, commitTool],
    );
    const p = r.rows[0];
    if (!p) throw new ApprovalError("NO_POLICY", `No approval policy for ${commitTool} in this tenant (fail closed).`);
    return p;
  }

  async propose(input: {
    requester: BoundIdentity;
    authz: Authz;
    commitTool: string;
    resource: string;
    change: Record<string, unknown>;
    summary: string;
    source: ApprovalRequest["source"];
    /**
     * Single-use claim run inside the same transaction just before the insert (for example a
     * Slack form nonce). False means already used: nothing is created. A later failure rolls
     * the claim back, so the form stays usable.
     */
    claim?: (q: Queryable) => Promise<boolean>;
  }): Promise<ApprovalRequest> {
    if (!isCommitTool(input.commitTool))
      throw new ApprovalError("NOT_A_WRITE", "Only registered commit tools can be proposed.");
    assertToolAllowedForUser({
      userId: input.requester.userId,
      roles: input.authz.roles,
      toolName: input.commitTool,
      assignments: input.authz.assignments,
    });
    const change = JSON.parse(canonicalJson(input.change)) as Record<string, unknown>;
    const { tenantId, userId } = input.requester;
    return this.db.tx(async (q) => {
      const p = await this.policy(q, tenantId, input.commitTool, true);
      let eligible = p.allow_self_approval ? p.approver_user_ids : p.approver_user_ids.filter((u) => u !== userId);
      if (!eligible.length) throw new ApprovalError("NO_APPROVER", "No eligible approver other than the requester.");
      if (p.rotate) {
        const i = Number(p.rotation_counter);
        await q.query(
          "UPDATE approval_policies SET rotation_counter = rotation_counter + 1 WHERE tenant_id = $1 AND commit_tool = $2",
          [tenantId, input.commitTool],
        );
        eligible = [eligible[i % eligible.length]!];
      }
      if (input.claim && !(await input.claim(q)))
        throw new ApprovalError("FORM_USED", "This form was already submitted.");
      const id = `apr_${randomBytes(16).toString("base64url")}`;
      const hash = hashChange({
        tenantId,
        requesterUserId: userId,
        commitTool: input.commitTool,
        resource: input.resource,
        change,
      });
      const r = await q.query<DbRow>(
        `INSERT INTO approval_requests (id, tenant_id, requester_user_id, commit_tool, resource, change, change_hash, summary, status, expires_at, assigned_approvers, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending', now() + ($9 || ' milliseconds')::interval, $10, $11) RETURNING ${COLS}`,
        [
          id,
          tenantId,
          userId,
          input.commitTool,
          input.resource,
          JSON.stringify(change),
          hash,
          input.summary.slice(0, 500),
          String(this.decisionTtlMs),
          eligible,
          input.source,
        ],
      );
      return toReq(r.rows[0]!);
    });
  }

  async get(id: string): Promise<ApprovalRequest | undefined> {
    const r = await this.db.query<DbRow>(`SELECT ${COLS} FROM approval_requests WHERE id = $1`, [id]);
    return r.rows[0] && toReq(r.rows[0]);
  }

  async list(tenantId: string, status?: string): Promise<ApprovalRequest[]> {
    const r = await this.db.query<DbRow>(
      `SELECT ${COLS} FROM approval_requests WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at`,
      [tenantId, status ?? null],
    );
    return r.rows.map(toReq);
  }

  private async lock(q: Queryable, id: string): Promise<Locked> {
    const r = await q.query<DbRow>(`SELECT ${COLS} FROM approval_requests WHERE id = $1 FOR UPDATE`, [id]);
    const row = r.rows[0];
    if (!row) throw new ApprovalError("NOT_FOUND", "Unknown approval request.");
    const req = toReq(row);
    if (req.status === "pending" && row.is_expired) {
      await q.query("UPDATE approval_requests SET status = 'expired', updated_at = now() WHERE id = $1", [id]);
      req.status = "expired";
    }
    return { req, expired: row.is_expired };
  }

  async decide(input: {
    requestId: string;
    approver: BoundIdentity;
    decision: "approve" | "reject";
    presentedHash: string;
  }): Promise<ApprovalRequest> {
    const out = await this.db.tx(async (q) => {
      const { req: r } = await this.lock(q, input.requestId);
      if (r.tenantId !== input.approver.tenantId)
        throw new ApprovalError("CROSS_TENANT", "Approver is in another tenant.");
      if (r.status !== "pending") return { err: new ApprovalError("NOT_PENDING", `Request is ${r.status}.`) };
      if (input.presentedHash !== r.changeHash)
        throw new ApprovalError("HASH_MISMATCH", "Preview changed; approval refused.");
      const p = await this.policy(q, r.tenantId, r.commitTool);
      if (input.approver.userId === r.requesterUserId && !p.allow_self_approval)
        throw new ApprovalError("SELF_APPROVAL", "Requester cannot approve their own change.");
      if (
        !r.assignedApprovers.includes(input.approver.userId) ||
        !p.approver_user_ids.includes(input.approver.userId)
      ) {
        throw new ApprovalError("NOT_APPROVER", "Caller is not an authorized approver for this request.");
      }
      const status = input.decision === "approve" ? "approved" : "rejected";
      // Approval opens a fresh submit window; the decision deadline no longer applies.
      const u = await q.query<DbRow>(
        `UPDATE approval_requests SET status = $2, decided_by = $3, decided_at = now(), updated_at = now(),
           expires_at = CASE WHEN $2 = 'approved' THEN now() + ($4 || ' milliseconds')::interval ELSE expires_at END
         WHERE id = $1 AND status = 'pending' RETURNING ${COLS}`,
        [r.id, status, input.approver.userId, String(this.commitWindowMs)],
      );
      return { req: toReq(u.rows[0]!) };
    });
    if ("err" in out && out.err) throw out.err; // thrown after commit so the expiry update persists
    return (out as { req: ApprovalRequest }).req;
  }

  /**
   * Read-only pre-check before any token work: ownership, tenant, and permission are checked
   * BEFORE a stored ledger result is disclosed. A finished commit is returned without touching
   * the OAuth provider; a failed or uncertain one throws; otherwise the caller may proceed to
   * fetch a token and call beginCommit (which re-checks everything under the row lock).
   */
  async lookupCommit(input: {
    requestId: string;
    caller: BoundIdentity;
    authz: Authz;
  }): Promise<{ kind: "replay"; result: unknown } | { kind: "proceed" }> {
    const r = await this.db.query<{
      tenant_id: string;
      requester_user_id: string;
      commit_tool: string;
      state: string | null;
      body: unknown;
    }>(
      `SELECT a.tenant_id, a.requester_user_id, a.commit_tool, l.state, l.body
         FROM approval_requests a LEFT JOIN commit_ledger l ON l.request_id = a.id WHERE a.id = $1`,
      [input.requestId],
    );
    const x = r.rows[0];
    if (!x) throw new ApprovalError("NOT_FOUND", "Unknown approval request.");
    if (x.tenant_id !== input.caller.tenantId || x.requester_user_id !== input.caller.userId)
      throw new ApprovalError("NOT_REQUESTER", "Only the requester can commit, in the same tenant.");
    assertToolAllowedForUser({
      userId: x.requester_user_id,
      roles: input.authz.roles,
      toolName: x.commit_tool,
      assignments: input.authz.assignments,
    });
    if (x.state === "ok") return { kind: "replay", result: x.body };
    if (x.state === "error")
      throw new ApprovalError("COMMIT_FAILED", "This request already failed in Workday. Start a new request.");
    if (x.state)
      throw new ApprovalError(
        "COMMIT_UNCERTAIN",
        "A previous submit is in flight or its result is unknown. An operator must reconcile; it will not be resubmitted automatically.",
      );
    return { kind: "proceed" };
  }

  async beginCommit(input: {
    requestId: string;
    caller: BoundIdentity;
    authz: Authz;
    idempotencyKey: string;
  }): Promise<BeginCommit> {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey))
      throw new ApprovalError("BAD_IDEMPOTENCY_KEY", "idempotencyKey must be 8-128 url-safe chars.");
    type Step = BeginCommit | { kind: "expired" } | { kind: "tampered" };
    // Expiry / tamper status updates must persist, so they are returned (not thrown) from the tx.
    const step = await this.db.tx(async (q): Promise<Step> => {
      const { req: r, expired } = await this.lock(q, input.requestId);
      if (r.tenantId !== input.caller.tenantId || r.requesterUserId !== input.caller.userId)
        throw new ApprovalError("NOT_REQUESTER", "Only the requester can commit, in the same tenant.");
      // Permission is checked before a stored result is disclosed (revoked roles cannot read it).
      assertToolAllowedForUser({
        userId: r.requesterUserId,
        roles: input.authz.roles,
        toolName: r.commitTool,
        assignments: input.authz.assignments,
      });
      const led = await q.query<{ state: string; body: unknown; idempotency_key: string }>(
        "SELECT state, body, idempotency_key FROM commit_ledger WHERE request_id = $1",
        [r.id],
      );
      const l = led.rows[0];
      if (l) {
        if (l.state === "ok") return { kind: "replay", result: l.body };
        if (l.state === "error")
          throw new ApprovalError("COMMIT_FAILED", "This request already failed in Workday. Start a new request.");
        throw new ApprovalError(
          "COMMIT_UNCERTAIN",
          "A previous submit is in flight or its result is unknown. An operator must reconcile; it will not be resubmitted automatically.",
        );
      }
      if (r.status !== "approved") throw new ApprovalError("NOT_APPROVED", `Request is ${r.status}.`);
      if (expired) {
        await q.query("UPDATE approval_requests SET status = 'expired', updated_at = now() WHERE id = $1", [r.id]);
        return { kind: "expired" };
      }
      const recomputed = hashChange({
        tenantId: r.tenantId,
        requesterUserId: r.requesterUserId,
        commitTool: r.commitTool,
        resource: r.resource,
        change: r.change,
      });
      if (recomputed !== r.changeHash) {
        await q.query("UPDATE approval_requests SET status = 'failed', updated_at = now() WHERE id = $1", [r.id]);
        return { kind: "tampered" };
      }
      await q.query(
        "UPDATE approval_requests SET status = 'committing', updated_at = now() WHERE id = $1 AND status = 'approved'",
        [r.id],
      );
      await q.query(
        "INSERT INTO commit_ledger (tenant_id, user_id, tool, idempotency_key, request_id, state) VALUES ($1,$2,$3,$4,$5,'in_flight')",
        [r.tenantId, r.requesterUserId, r.commitTool, input.idempotencyKey, r.id],
      );
      return { kind: "execute", request: { ...r, status: "committing" } };
    });
    if (step.kind === "expired")
      throw new ApprovalError("EXPIRED", "The submit window after approval has expired. Start a new request.");
    if (step.kind === "tampered") throw new ApprovalError("TAMPERED", "Stored change does not match approved hash.");
    return step;
  }

  async finishCommit(requestId: string, outcome: CommitOutcome): Promise<void> {
    const status = outcome.state === "ok" ? "committed" : outcome.state === "error" ? "failed" : "unknown";
    await this.db.tx(async (q) => {
      await q.query(
        "UPDATE commit_ledger SET state = $2, body = $3, updated_at = now() WHERE request_id = $1 AND state IN ('in_flight','unknown')",
        [requestId, outcome.state, JSON.stringify(outcome.body ?? null)],
      );
      await q.query(
        "UPDATE approval_requests SET status = $2, result = $3, updated_at = now() WHERE id = $1 AND status IN ('committing','unknown')",
        [requestId, status, JSON.stringify(outcome.body ?? null)],
      );
    });
  }

  /** Requests needing an operator: unknown results, or committing for longer than staleCommitMs (crash). */
  async needingReconcile(tenantId: string): Promise<ApprovalRequest[]> {
    const r = await this.db.query<DbRow>(
      `SELECT ${COLS} FROM approval_requests WHERE tenant_id = $1 AND (status = 'unknown' OR (status = 'committing' AND updated_at < now() - ($2 || ' milliseconds')::interval)) ORDER BY created_at`,
      [tenantId, String(this.staleCommitMs)],
    );
    return r.rows.map(toReq);
  }

  /** Operator decision after reading Workday. Only for unknown / stale committing requests. */
  async resolveUncertain(actor: string, requestId: string, outcome: CommitOutcome): Promise<void> {
    await this.db.tx(async (q) => {
      const { req: r } = await this.lock(q, requestId);
      const stale = r.status === "committing";
      if (r.status !== "unknown" && !stale) throw new ApprovalError("NOT_UNCERTAIN", `Request is ${r.status}.`);
      await adminAudit(q, actor, "approval.reconcile", { requestId, state: outcome.state });
    });
    await this.finishCommit(requestId, outcome);
  }
}
