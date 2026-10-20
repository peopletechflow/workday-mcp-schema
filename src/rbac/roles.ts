/**
 * Baseline RBAC roles. Each role should map 1:1 to a Workday security group
 * (and to the ASOR agent skill "Available To" list). Adjust per tenant.
 */
export const ROLES = ["worker_self", "manager", "hr_partner", "payroll_viewer", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  worker_self: "Own profile, own time-off, own benefits, own pay statements (read); request/cancel own time-off.",
  manager: "Team roster and team time-off reads; approve/deny team time-off.",
  hr_partner: "Broader org reads (supervisory org). No payroll write.",
  payroll_viewer: "Pay statement reads only. No writes.",
  admin:
    "Full READ access to worker data (all scopes) plus kill switch / config. Uses the admin's own sign-in, " +
    "never a shared account. Writes only on the admin's own record, always preview + explicit confirm.",
};

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** Parse a comma-separated role list (e.g. WORKDAY_USER_ROLES). Unknown roles throw (fail closed). */
export function parseRoles(raw: string | undefined): Role[] {
  const parts = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = parts.filter((p) => !isRole(p));
  if (unknown.length) throw new Error(`Unknown role(s) in WORKDAY_USER_ROLES: ${unknown.join(", ")}. Valid: ${ROLES.join(", ")}`);
  return [...new Set(parts as Role[])];
}

/** Fixture/dev role resolution from env. Real deployments resolve from Workday security groups. */
export function resolveRolesFromEnv(env: NodeJS.ProcessEnv = process.env): Role[] {
  return parseRoles(env.WORKDAY_USER_ROLES ?? "worker_self");
}
