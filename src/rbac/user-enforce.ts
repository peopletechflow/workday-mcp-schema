/**
 * User-level RBAC overlay: deny / grant / role resolution for Layer-3 tools and Agent-Ready.
 * Additive and fail closed. Does not weaken team/org/pay-group proofs or write preview gates.
 */
import type { Role } from "./roles.js";
import { rolesForTool } from "./permissions.js";
import { assertToolAllowed, RbacDeniedError } from "./enforce.js";
import {
  assertAgentReadyCallAllowed,
  AgentReadyDeniedError,
  AgentReadyWriteDeniedError,
  isAgentReadyWrite,
  isSelfTarget,
  targetKindFor,
  type AgentReadyCallContext,
  type AgentReadyScope,
} from "./agent-ready.js";
import type { AssignmentStore } from "./assignments.js";
import { permissionIdForTool } from "./permission-ids.js";

export type UserEnforceInput = {
  userId: string;
  roles: readonly Role[];
  toolName: string;
  assignments?: AssignmentStore | undefined;
};

function assignmentFor(input: UserEnforceInput) {
  return input.assignments?.get(input.userId);
}

/**
 * Resolution order (fail closed):
 * 1. denies → DENY
 * 2. grants → ALLOW (scope / write guards still apply later for Agent-Ready)
 * 3. role maps → ALLOW
 * 4. else DENY
 */
export function assertToolAllowedForUser(input: UserEnforceInput): void {
  const { roles, toolName } = input;
  const permissionId = permissionIdForTool(toolName);
  const assignment = assignmentFor(input);
  const allowedRoles = rolesForTool(toolName) ?? [];

  if (assignment?.denies.includes(permissionId)) {
    throw new RbacDeniedError(toolName, allowedRoles, roles, "deny", permissionId);
  }
  if (assignment?.grants.includes(permissionId)) {
    // Grant unlocks the tool name. Layer-3 has no extra scope proofs beyond role maps.
    return;
  }
  if (allowedRoles.length === 0) {
    throw new RbacDeniedError(toolName, allowedRoles, roles, "unmapped", permissionId);
  }
  assertToolAllowed(roles, toolName);
}

/**
 * Agent-Ready call check with deny/grant overlay.
 * Deny wins. Grant can allow a tool the role map would not, but:
 * - never skips preview→confirm for writes
 * - never skips team/org/pay-group / awaiting-approver / payroll-domain proof failures
 */
export function assertAgentReadyCallAllowedForUser(
  input: UserEnforceInput & { ctx?: AgentReadyCallContext },
): AgentReadyScope {
  const { roles, toolName, ctx = {} } = input;
  const permissionId = permissionIdForTool(toolName);
  const assignment = assignmentFor(input);

  if (assignment?.denies.includes(permissionId)) {
    throw new RbacDeniedError(toolName, [], roles, "deny", permissionId);
  }

  const hasGrant = assignment?.grants.includes(permissionId) === true;

  try {
    return assertAgentReadyCallAllowed(roles, toolName, ctx);
  } catch (err) {
    if (!hasGrant) throw err;

    // Grant cannot bypass write preview / confirmation.
    if (isAgentReadyWrite(toolName) && ctx.previewConfirmed !== true) {
      throw new AgentReadyWriteDeniedError(
        toolName,
        roles,
        "is a write: run it through the native write guard (preview, then explicit confirmation).",
      );
    }

    // Grant cannot bypass proof / domain / awaiting-approver denials.
    if (err instanceof AgentReadyDeniedError) throw err;
    if (err instanceof AgentReadyWriteDeniedError) {
      // Self-target write failures stay blocked even with a grant.
      throw err;
    }

    // Role-map denial (RbacDeniedError): grant unlocks the tool name.
    // Conservative scope for grant-only (no role mapping): worker targets must be self;
    // none/org/pay_group still need their proofs via a successful role path (already failed),
    // so for grant-only non-self we fail closed unless the kind is "none".
    const kind = targetKindFor(toolName);
    if (kind === "none") return "self";
    if (isSelfTarget(ctx) || kind === "caller_list") return "self";
    if (isAgentReadyWrite(toolName)) {
      throw new AgentReadyWriteDeniedError(
        toolName,
        roles,
        'is a write: target must be "me" or your own WID (grants do not widen write scope).',
      );
    }
    // Grant without role does not invent team/org/pay-group membership.
    throw new RbacDeniedError(toolName, [], roles, "role", permissionId);
  }
}
