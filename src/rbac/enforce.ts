import type { Role } from "./roles.js";
import { rolesForTool } from "./permissions.js";

export type RbacDenialReason = "role" | "deny" | "unmapped" | "unknown_permission";

export class RbacDeniedError extends Error {
  constructor(
    readonly toolName: string,
    readonly required: readonly Role[],
    readonly held: readonly Role[],
    readonly reason: RbacDenialReason = "role",
    readonly permissionId?: string,
  ) {
    super(messageFor(toolName, required, held, reason, permissionId));
    this.name = "RbacDeniedError";
  }
}

function messageFor(
  toolName: string,
  required: readonly Role[],
  held: readonly Role[],
  reason: RbacDenialReason,
  permissionId?: string,
): string {
  if (reason === "deny") {
    return (
      `Access denied: '${toolName}' is explicitly denied for this user` +
      (permissionId ? ` (${permissionId})` : "") +
      `. Explicit denies win over roles and grants. Ask your Workday security admin to clear the deny.`
    );
  }
  if (reason === "unknown_permission") {
    return `Access denied: '${toolName}' has an unknown permission id, so it is blocked (fail closed).`;
  }
  if (reason === "unmapped" || required.length === 0) {
    return `Access denied: '${toolName}' has no RBAC mapping, so it is blocked for everyone (fail closed).`;
  }
  return (
    `Access denied: '${toolName}' requires one of [${required.join(", ")}]; you have [${held.join(", ") || "none"}]. ` +
    `Ask your Workday security admin to add you to the matching security group, or grant the permission explicitly.`
  );
}

/** Throws RbacDeniedError unless the caller holds at least one allowed role. Call before any Workday request. */
export function assertToolAllowed(userRoles: readonly Role[], toolName: string): void {
  const allowed = rolesForTool(toolName) ?? [];
  if (!allowed.some((r) => userRoles.includes(r))) {
    throw new RbacDeniedError(toolName, allowed, userRoles, allowed.length === 0 ? "unmapped" : "role");
  }
}
