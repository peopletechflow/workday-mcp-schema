import type { Role } from "./roles.js";
import { rolesForTool } from "./permissions.js";

export class RbacDeniedError extends Error {
  constructor(readonly toolName: string, readonly required: readonly Role[], readonly held: readonly Role[]) {
    super(
      required.length === 0
        ? `Access denied: '${toolName}' has no RBAC mapping, so it is blocked for everyone (fail closed).`
        : `Access denied: '${toolName}' requires one of [${required.join(", ")}]; you have [${held.join(", ") || "none"}]. ` +
          `Ask your Workday security admin to add you to the matching security group.`,
    );
    this.name = "RbacDeniedError";
  }
}

/** Throws RbacDeniedError unless the caller holds at least one allowed role. Call before any Workday request. */
export function assertToolAllowed(userRoles: readonly Role[], toolName: string): void {
  const allowed = rolesForTool(toolName) ?? [];
  if (!allowed.some((r) => userRoles.includes(r))) throw new RbacDeniedError(toolName, allowed, userRoles);
}
