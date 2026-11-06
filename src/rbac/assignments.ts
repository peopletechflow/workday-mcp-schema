/**
 * Lowest-level user permission assignments for enterprise Layer-3 custom MCP.
 *
 * Resolution (fail closed), applied in user-enforce.ts:
 *   1. permission id in denies  → DENY
 *   2. permission id in grants  → ALLOW (still subject to scope proofs / write guards)
 *   3. any role allows via existing maps → ALLOW
 *   4. else DENY
 *
 * Grants never skip team/org/pay-group proofs or preview→confirm write requirements.
 * Workday security on the user's token remains authoritative.
 */
import { readFileSync, existsSync } from "node:fs";
import type { Role } from "./roles.js";
import { parseRoles } from "./roles.js";
import {
  buildPermissionCatalog,
  isKnownPermissionId,
  permissionIdForTool,
  type PermissionCatalogEntry,
  type PermissionId,
} from "./permission-ids.js";

export type UserPermissionAssignment = {
  userId: string;
  roles: Role[];
  /** Permission ids explicitly allowed for this user. */
  grants: string[];
  /** Permission ids explicitly blocked (wins over roles + grants). */
  denies: string[];
  updatedAt: string;
  updatedBy?: string;
};

export interface AssignmentStore {
  get(userId: string): UserPermissionAssignment | undefined;
  list(): readonly UserPermissionAssignment[];
  set(assignment: UserPermissionAssignment): void;
  delete(userId: string): void;
}

function uniqSorted(ids: readonly string[]): string[] {
  return [...new Set(ids.map((s) => s.trim()).filter(Boolean))].sort();
}

function assertKnownPermissionIds(ids: readonly string[], field: string): void {
  const unknown = ids.filter((id) => !isKnownPermissionId(id));
  if (unknown.length) {
    throw new Error(`Unknown ${field} permission id(s) (fail closed): ${unknown.join(", ")}`);
  }
}

function normalizeAssignment(input: UserPermissionAssignment): UserPermissionAssignment {
  assertKnownPermissionIds(input.grants, "grants");
  assertKnownPermissionIds(input.denies, "denies");
  return {
    userId: input.userId.trim(),
    roles: [...new Set(input.roles)],
    grants: uniqSorted(input.grants),
    denies: uniqSorted(input.denies),
    updatedAt: input.updatedAt,
    updatedBy: input.updatedBy,
  };
}

export class InMemoryAssignmentStore implements AssignmentStore {
  private readonly byUser = new Map<string, UserPermissionAssignment>();

  get(userId: string): UserPermissionAssignment | undefined {
    return this.byUser.get(userId);
  }

  list(): readonly UserPermissionAssignment[] {
    return [...this.byUser.values()].sort((a, b) => a.userId.localeCompare(b.userId));
  }

  set(assignment: UserPermissionAssignment): void {
    const next = normalizeAssignment(assignment);
    if (!next.userId) throw new Error("userId is required");
    this.byUser.set(next.userId, next);
  }

  delete(userId: string): void {
    this.byUser.delete(userId);
  }
}

type FileShape = {
  assignments?: Array<{
    userId: string;
    roles?: string[];
    grants?: string[];
    denies?: string[];
    updatedAt?: string;
    updatedBy?: string;
  }>;
};

/** Load assignments from a JSON file (enterprise config). Missing file → empty store. */
export function loadAssignmentsFromJsonFile(path: string): InMemoryAssignmentStore {
  const store = new InMemoryAssignmentStore();
  if (!existsSync(path)) return store;
  const raw = JSON.parse(readFileSync(path, "utf8")) as FileShape;
  for (const row of raw.assignments ?? []) {
    store.set({
      userId: row.userId,
      roles: parseRoles((row.roles ?? []).join(",")),
      grants: row.grants ?? [],
      denies: row.denies ?? [],
      updatedAt: row.updatedAt ?? new Date(0).toISOString(),
      updatedBy: row.updatedBy,
    });
  }
  return store;
}

function parsePermissionIdList(raw: string | undefined): string[] {
  return uniqSorted((raw ?? "").split(","));
}

/**
 * Seed / merge env into a store for the current WORKDAY_USER_ID:
 * - WORKDAY_USER_ROLES (existing)
 * - WORKDAY_USER_GRANTS / WORKDAY_USER_DENIES (comma-separated permission ids)
 */
export function seedAssignmentsFromEnv(
  store: AssignmentStore,
  env: NodeJS.ProcessEnv = process.env,
): AssignmentStore {
  const userId = env.WORKDAY_USER_ID?.trim() || "local-user";
  const roles = parseRoles(env.WORKDAY_USER_ROLES ?? "worker_self");
  const grants = parsePermissionIdList(env.WORKDAY_USER_GRANTS);
  const denies = parsePermissionIdList(env.WORKDAY_USER_DENIES);
  if (!grants.length && !denies.length) {
    // Still record roles so getUserAssignment sees them when only roles are set.
    const existing = store.get(userId);
    if (!existing) {
      store.set({
        userId,
        roles,
        grants: [],
        denies: [],
        updatedAt: new Date().toISOString(),
        updatedBy: "env",
      });
    }
    return store;
  }
  assertKnownPermissionIds(grants, "WORKDAY_USER_GRANTS");
  assertKnownPermissionIds(denies, "WORKDAY_USER_DENIES");
  const existing = store.get(userId);
  store.set({
    userId,
    roles: existing?.roles?.length ? existing.roles : roles,
    grants: uniqSorted([...(existing?.grants ?? []), ...grants]),
    denies: uniqSorted([...(existing?.denies ?? []), ...denies]),
    updatedAt: new Date().toISOString(),
    updatedBy: "env",
  });
  return store;
}

/**
 * Create the process-wide assignment store: optional JSON file, then env grants/denies.
 * Path from WORKDAY_RBAC_ASSIGNMENTS_PATH.
 */
export function createAssignmentStore(env: NodeJS.ProcessEnv = process.env): AssignmentStore {
  const path = env.WORKDAY_RBAC_ASSIGNMENTS_PATH?.trim();
  const store = path ? loadAssignmentsFromJsonFile(path) : new InMemoryAssignmentStore();
  return seedAssignmentsFromEnv(store, env);
}

// ---- Admin management API (caller must hold admin) ----

function assertAdmin(callerRoles: readonly Role[]): void {
  if (!callerRoles.includes("admin")) {
    throw new Error("Access denied: user permission assignment management requires the admin role.");
  }
}

export function listPermissions(): readonly PermissionCatalogEntry[] {
  return buildPermissionCatalog();
}

export function getUserAssignment(store: AssignmentStore, userId: string): UserPermissionAssignment | undefined {
  return store.get(userId);
}

export function setUserAssignment(
  store: AssignmentStore,
  callerRoles: readonly Role[],
  assignment: UserPermissionAssignment,
  callerUserId?: string,
): UserPermissionAssignment {
  assertAdmin(callerRoles);
  const next: UserPermissionAssignment = {
    ...assignment,
    updatedAt: assignment.updatedAt || new Date().toISOString(),
    updatedBy: assignment.updatedBy ?? callerUserId,
  };
  store.set(next);
  return store.get(next.userId)!;
}

export function grantPermission(
  store: AssignmentStore,
  callerRoles: readonly Role[],
  userId: string,
  permissionId: string,
  callerUserId?: string,
): UserPermissionAssignment {
  assertAdmin(callerRoles);
  if (!isKnownPermissionId(permissionId)) {
    throw new Error(`Unknown permission id (fail closed): ${permissionId}`);
  }
  const existing = store.get(userId) ?? {
    userId,
    roles: [],
    grants: [],
    denies: [],
    updatedAt: new Date().toISOString(),
  };
  const grants = uniqSorted([...existing.grants, permissionId]);
  const denies = existing.denies.filter((d) => d !== permissionId);
  store.set({
    ...existing,
    grants,
    denies,
    updatedAt: new Date().toISOString(),
    updatedBy: callerUserId,
  });
  return store.get(userId)!;
}

export function denyPermission(
  store: AssignmentStore,
  callerRoles: readonly Role[],
  userId: string,
  permissionId: string,
  callerUserId?: string,
): UserPermissionAssignment {
  assertAdmin(callerRoles);
  if (!isKnownPermissionId(permissionId)) {
    throw new Error(`Unknown permission id (fail closed): ${permissionId}`);
  }
  const existing = store.get(userId) ?? {
    userId,
    roles: [],
    grants: [],
    denies: [],
    updatedAt: new Date().toISOString(),
  };
  const denies = uniqSorted([...existing.denies, permissionId]);
  store.set({
    ...existing,
    denies,
    updatedAt: new Date().toISOString(),
    updatedBy: callerUserId,
  });
  return store.get(userId)!;
}

export function clearGrant(
  store: AssignmentStore,
  callerRoles: readonly Role[],
  userId: string,
  permissionId: string,
  callerUserId?: string,
): UserPermissionAssignment | undefined {
  assertAdmin(callerRoles);
  const existing = store.get(userId);
  if (!existing) return undefined;
  store.set({
    ...existing,
    grants: existing.grants.filter((g) => g !== permissionId),
    updatedAt: new Date().toISOString(),
    updatedBy: callerUserId,
  });
  return store.get(userId);
}

export function clearDeny(
  store: AssignmentStore,
  callerRoles: readonly Role[],
  userId: string,
  permissionId: string,
  callerUserId?: string,
): UserPermissionAssignment | undefined {
  assertAdmin(callerRoles);
  const existing = store.get(userId);
  if (!existing) return undefined;
  store.set({
    ...existing,
    denies: existing.denies.filter((d) => d !== permissionId),
    updatedAt: new Date().toISOString(),
    updatedBy: callerUserId,
  });
  return store.get(userId);
}

