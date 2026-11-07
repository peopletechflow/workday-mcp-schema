/**
 * Human approval routing for writes proposed through Slack forms or agents.
 *
 * Lifecycle: pending -> approved | rejected | expired; approved -> committing -> committed | failed.
 * Rejected / expired / committed / failed are terminal.
 *
 * Guarantees (in-process; use a durable transactional store before production):
 * - preview binds tenant, requester, commit tool, resource, and a sha256 hash of the canonical change
 * - approver is a server-resolved identity listed by server-side policy for that tenant+tool
 * - self approval refused unless policy explicitly allows it (default false)
 * - the model / agent has no approve or commit tool
 * - commit rechecks tenant, requester RBAC (deny overrides grant/role), hash, expiry, status
 * - idempotency key returns the stored result; status flips to "committing" synchronously before
 *   any await, so concurrent commits of the same request cannot both execute
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { Role } from "../../rbac/roles.js";
import type { AssignmentStore } from "../../rbac/assignments.js";
import { assertToolAllowedForUser } from "../../rbac/user-enforce.js";
import { TOOL_REGISTRY } from "../../tools/registry.js";
import type { BoundIdentity } from "../identity.js";

export class ApprovalError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ApprovalError";
  }
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "committing" | "committed" | "failed" | "unknown";

export type ApprovalRequest = {
  id: string;
  tenantId: string;
  requesterUserId: string;
  commitTool: string;
  resource: string;
  change: Record<string, unknown>;
  changeHash: string;
  summary: string;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  assignedApprovers: string[];
  decidedBy?: string;
  decidedAt?: number;
  result?: unknown;
  source: "slack_form" | "agent" | "api";
};

const PolicyRuleSchema = z.object({
  tenantId: z.string().min(1),
  commitTool: z.string().min(1),
  approverUserIds: z.array(z.string().min(1)).min(1),
  allowSelfApproval: z.boolean().default(false),
  /** Optional: assign one approver per request in round-robin order (does not widen the approver set). */
  rotate: z.boolean().default(false),
});
export type ApprovalPolicyRule = z.infer<typeof PolicyRuleSchema>;

/** Stable JSON: sorted keys, no undefined. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

export function hashChange(binding: { tenantId: string; requesterUserId: string; commitTool: string; resource: string; change: unknown }): string {
  return createHash("sha256").update(canonicalJson(binding)).digest("hex");
}

/** Minimal decision surface used by Slack approval buttons (in-memory or durable). */
export interface ApprovalDecider {
  decide(input: { requestId: string; approver: BoundIdentity; decision: "approve" | "reject"; presentedHash: string }): ApprovalRequest | Promise<ApprovalRequest>;
}

export type CommitExecutor = (req: Readonly<ApprovalRequest>) => Promise<unknown>;
export type RequesterAuthz = { roles: readonly Role[]; assignments?: AssignmentStore };

export class ApprovalWorkflow implements ApprovalDecider {
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly idem = new Map<string, unknown>();
  private readonly rotation = new Map<string, number>();
  private readonly rules: ApprovalPolicyRule[];

  constructor(rules: readonly ApprovalPolicyRule[], readonly ttlMs = 15 * 60 * 1000, private readonly now: () => number = Date.now) {
    this.rules = rules.map((r) => PolicyRuleSchema.parse(r));
    for (const r of this.rules) {
      const entry = TOOL_REGISTRY.find((t) => t.name === r.commitTool);
      if (!entry || entry.toolClass !== "write-commit") throw new Error(`Approval policy names non-commit tool ${r.commitTool}`);
    }
  }

  static fromFile(path: string, ttlMs?: number): ApprovalWorkflow {
    if (!existsSync(path)) throw new Error("Approval policy file missing (fail closed).");
    return new ApprovalWorkflow(z.array(PolicyRuleSchema).parse(JSON.parse(readFileSync(path, "utf8"))), ttlMs);
  }

  private rule(tenantId: string, commitTool: string): ApprovalPolicyRule {
    const r = this.rules.find((x) => x.tenantId === tenantId && x.commitTool === commitTool);
    if (!r) throw new ApprovalError("NO_POLICY", `No approval policy for ${commitTool} in this tenant (fail closed).`);
    return r;
  }

  /**
   * Create a preview awaiting human approval. The requester must already be allowed to
   * use the commit tool (deny overrides grant/role). Does not execute anything.
   */
  propose(input: {
    requester: BoundIdentity;
    authz: RequesterAuthz;
    commitTool: string;
    resource: string;
    change: Record<string, unknown>;
    summary: string;
    source: ApprovalRequest["source"];
  }): ApprovalRequest {
    const entry = TOOL_REGISTRY.find((t) => t.name === input.commitTool);
    if (!entry || entry.toolClass !== "write-commit") throw new ApprovalError("NOT_A_WRITE", "Only registered commit tools can be proposed.");
    assertToolAllowedForUser({ userId: input.requester.userId, roles: input.authz.roles, toolName: input.commitTool, assignments: input.authz.assignments });
    const rule = this.rule(input.requester.tenantId, input.commitTool);
    let eligible = rule.allowSelfApproval ? rule.approverUserIds : rule.approverUserIds.filter((u) => u !== input.requester.userId);
    if (!eligible.length) throw new ApprovalError("NO_APPROVER", "No eligible approver other than the requester.");
    if (rule.rotate) {
      const k = `${rule.tenantId}:${rule.commitTool}`;
      const i = this.rotation.get(k) ?? 0;
      this.rotation.set(k, i + 1);
      eligible = [eligible[i % eligible.length]!];
    }
    const change = JSON.parse(canonicalJson(input.change)) as Record<string, unknown>;
    const t = this.now();
    const req: ApprovalRequest = {
      id: `apr_${randomBytes(16).toString("base64url")}`,
      tenantId: input.requester.tenantId,
      requesterUserId: input.requester.userId,
      commitTool: input.commitTool,
      resource: input.resource,
      change,
      changeHash: hashChange({ tenantId: input.requester.tenantId, requesterUserId: input.requester.userId, commitTool: input.commitTool, resource: input.resource, change }),
      summary: input.summary.slice(0, 500),
      status: "pending",
      createdAt: t,
      expiresAt: t + this.ttlMs,
      assignedApprovers: [...eligible],
      source: input.source,
    };
    this.requests.set(req.id, req);
    return structuredClone(req);
  }

  get(id: string): Readonly<ApprovalRequest> | undefined {
    const r = this.requests.get(id);
    return r ? structuredClone(r) : undefined;
  }

  /** Copies of requests for one tenant (admin/status views and tests). */
  list(tenantId: string): ApprovalRequest[] {
    return [...this.requests.values()].filter((r) => r.tenantId === tenantId).map((r) => structuredClone(r));
  }

  private load(id: string): ApprovalRequest {
    const r = this.requests.get(id);
    if (!r) throw new ApprovalError("NOT_FOUND", "Unknown approval request.");
    if (r.status === "pending" && r.expiresAt < this.now()) r.status = "expired";
    return r;
  }

  /** Approver identity must come from verified channel identity (e.g. signed Slack interaction + identity map). */
  decide(input: { requestId: string; approver: BoundIdentity; decision: "approve" | "reject"; presentedHash: string }): ApprovalRequest {
    const r = this.load(input.requestId);
    if (r.tenantId !== input.approver.tenantId) throw new ApprovalError("CROSS_TENANT", "Approver is in another tenant.");
    if (r.status !== "pending") throw new ApprovalError("NOT_PENDING", `Request is ${r.status}.`);
    if (input.presentedHash !== r.changeHash) throw new ApprovalError("HASH_MISMATCH", "Preview changed; approval refused.");
    const rule = this.rule(r.tenantId, r.commitTool);
    if (input.approver.userId === r.requesterUserId && !rule.allowSelfApproval) throw new ApprovalError("SELF_APPROVAL", "Requester cannot approve their own change.");
    if (!r.assignedApprovers.includes(input.approver.userId) || !rule.approverUserIds.includes(input.approver.userId)) {
      throw new ApprovalError("NOT_APPROVER", "Caller is not an authorized approver for this request.");
    }
    r.status = input.decision === "approve" ? "approved" : "rejected";
    r.decidedBy = input.approver.userId;
    r.decidedAt = this.now();
    return structuredClone(r);
  }

  /** Commit after approval. Rechecks everything; executor runs at most once per request. */
  async commit(input: { requestId: string; caller: BoundIdentity; authz: RequesterAuthz; idempotencyKey: string; executor: CommitExecutor }): Promise<unknown> {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey)) throw new ApprovalError("BAD_IDEMPOTENCY_KEY", "idempotencyKey must be 8-128 url-safe chars.");
    const idemKey = `${input.caller.tenantId}:${input.caller.userId}:${input.requestId}:${input.idempotencyKey}`;
    if (this.idem.has(idemKey)) return this.idem.get(idemKey);
    const r = this.load(input.requestId);
    if (r.tenantId !== input.caller.tenantId || r.requesterUserId !== input.caller.userId) {
      throw new ApprovalError("NOT_REQUESTER", "Only the requester can commit, in the same tenant.");
    }
    if (r.status === "committed") return r.result;
    if (r.status !== "approved") throw new ApprovalError("NOT_APPROVED", `Request is ${r.status}.`);
    if (r.expiresAt < this.now()) {
      r.status = "expired";
      throw new ApprovalError("EXPIRED", "Approval window expired.");
    }
    const recomputed = hashChange({ tenantId: r.tenantId, requesterUserId: r.requesterUserId, commitTool: r.commitTool, resource: r.resource, change: r.change });
    if (recomputed !== r.changeHash) {
      r.status = "failed";
      throw new ApprovalError("TAMPERED", "Stored change does not match approved hash.");
    }
    assertToolAllowedForUser({ userId: r.requesterUserId, roles: input.authz.roles, toolName: r.commitTool, assignments: input.authz.assignments });
    r.status = "committing"; // synchronous claim before any await
    try {
      const result = await input.executor(structuredClone(r));
      r.status = "committed";
      r.result = result;
      this.idem.set(idemKey, result);
      return result;
    } catch (err) {
      r.status = "failed";
      throw err;
    }
  }
}
