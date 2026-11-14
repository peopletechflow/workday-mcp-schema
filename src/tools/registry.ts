import type { z } from "zod";
import * as T from "../schemas/tools/index.js";
import { TOOL_PERMISSIONS, type Role } from "../rbac/index.js";
import type { ToolAudience, ToolClass, ToolContract, WorkdaySurface } from "../schemas/tools/contract.js";

export type OutcomeActionSpec = {
  action: string;
  toolClass: ToolClass;
  access: "read" | "write";
  /** Layer-3 permission key in TOOL_PERMISSIONS. */
  permission: string;
  destructive?: true;
  pairedWith?: string;
};

type AnyContract = ToolContract<z.ZodRawShape, z.ZodRawShape>;

/**
 * Schema-first contract for a tool name, or undefined for names outside src/schemas/tools.
 * Agents read `description` and `input` from here, so the model sees the same text and
 * parameters a human integrator would, instead of internal build rationale.
 */
export function contractFor(name: string): AnyContract | undefined {
  for (const v of Object.values(T)) {
    if (v && typeof v === "object" && "name" in v && "input" in v && "toolClass" in v && v.name === name) return v;
  }
  return undefined;
}

export type RegistryEntry = {
  name: string;
  toolClass: ToolClass | "outcome";
  /** read | write, flattened for docs/metrics. Outcome tools use actions for the real split. */
  access: "read" | "write";
  audience: ToolAudience | "mixed";
  domain:
    "hcm" | "absence" | "benefits" | "payroll" | "org" | "meta" | "talent" | "recruiting" | "expenses" | "personal";
  surface: WorkdaySurface;
  piiFields: string[];
  /** One-line build-vs-buy reason (SKILL §1.2). */
  buildReason: string;
  /** Wired to a live Workday surface yet, or fixture/stub only. */
  liveStatus: "live-stub" | "fixture-only";
  pairedWith?: string;
  /** Commit removes or refuses something (cancel, deny). Surfaces as MCP destructiveHint. */
  destructive?: true;
  actions?: readonly OutcomeActionSpec[];
};

const BR_OUTCOME =
  "One goal-shaped tool instead of one tool per Workday endpoint. Writes stay on preview and commit actions.";
const FIND = {
  action: "find_operation",
  toolClass: "read" as const,
  access: "read" as const,
  permission: T.listAgentReadyTools.name,
};

/** Single source of truth for every tool this server exposes by default. */
export const TOOL_REGISTRY: RegistryEntry[] = [
  {
    name: T.timeOffTool.name,
    toolClass: "outcome",
    access: "write",
    audience: "mixed",
    domain: "absence",
    surface: "REST",
    piiFields: ["comment", "worker.descriptor"],
    buildReason: BR_OUTCOME,
    liveStatus: "live-stub",
    actions: [
      { action: "balances", toolClass: "read", access: "read", permission: T.getMyTimeOffBalance.name },
      { action: "history", toolClass: "read", access: "read", permission: T.listMyTimeOffRequests.name },
      { action: "team_history", toolClass: "read", access: "read", permission: T.listTeamTimeOffRequests.name },
      {
        action: "request_preview",
        toolClass: "write-preview",
        access: "write",
        permission: T.previewRequestTimeOff.name,
        pairedWith: "request_commit",
      },
      {
        action: "request_commit",
        toolClass: "write-commit",
        access: "write",
        permission: T.commitRequestTimeOff.name,
        pairedWith: "request_preview",
      },
      {
        action: "cancel_preview",
        toolClass: "write-preview",
        access: "write",
        permission: T.previewCancelTimeOff.name,
        pairedWith: "cancel_commit",
      },
      {
        action: "cancel_commit",
        toolClass: "write-commit",
        access: "write",
        permission: T.commitCancelTimeOff.name,
        pairedWith: "cancel_preview",
        destructive: true,
      },
      {
        action: "approve_preview",
        toolClass: "write-preview",
        access: "write",
        permission: T.previewApproveTimeOff.name,
        pairedWith: "approve_commit",
      },
      {
        action: "approve_commit",
        toolClass: "write-commit",
        access: "write",
        permission: T.commitApproveTimeOff.name,
        pairedWith: "approve_preview",
      },
      {
        action: "deny_preview",
        toolClass: "write-preview",
        access: "write",
        permission: T.previewDenyTimeOff.name,
        pairedWith: "deny_commit",
      },
      {
        action: "deny_commit",
        toolClass: "write-commit",
        access: "write",
        permission: T.commitDenyTimeOff.name,
        pairedWith: "deny_preview",
        destructive: true,
      },
      FIND,
    ],
  },
  {
    name: T.workerTool.name,
    toolClass: "outcome",
    access: "read",
    audience: "worker",
    domain: "hcm",
    surface: "REST",
    piiFields: ["preferredName", "hireDate", "terminationDate", "manager.descriptor"],
    buildReason: BR_OUTCOME,
    liveStatus: "fixture-only",
    actions: [{ action: "profile", toolClass: "read", access: "read", permission: T.getMyWorkerProfile.name }, FIND],
  },
  {
    name: T.organizationTool.name,
    toolClass: "outcome",
    access: "read",
    audience: "mixed",
    domain: "org",
    surface: "REST",
    piiFields: ["preferredName", "manager.descriptor"],
    buildReason: BR_OUTCOME,
    liveStatus: "fixture-only",
    actions: [
      { action: "my_team", toolClass: "read", access: "read", permission: T.listMyTeam.name },
      { action: "supervisory_org", toolClass: "read", access: "read", permission: T.getSupervisoryOrg.name },
      FIND,
    ],
  },
  {
    name: T.jobTool.name,
    toolClass: "outcome",
    access: "read",
    audience: "worker",
    domain: "hcm",
    surface: "catalog",
    piiFields: [],
    buildReason: BR_OUTCOME,
    liveStatus: "fixture-only",
    actions: [FIND],
  },
  {
    name: T.compensationTool.name,
    toolClass: "outcome",
    access: "read",
    audience: "worker",
    domain: "hcm",
    surface: "catalog",
    piiFields: [],
    buildReason: BR_OUTCOME,
    liveStatus: "fixture-only",
    actions: [FIND],
  },
  {
    name: T.benefitsTool.name,
    toolClass: "outcome",
    access: "read",
    audience: "worker",
    domain: "benefits",
    surface: "RaaS",
    piiFields: ["coverageLevel"],
    buildReason: BR_OUTCOME,
    liveStatus: "fixture-only",
    actions: [
      { action: "enrollments", toolClass: "read", access: "read", permission: T.getMyBenefitsEnrollments.name },
      FIND,
    ],
  },
  {
    name: T.payTool.name,
    toolClass: "outcome",
    access: "read",
    audience: "worker",
    domain: "payroll",
    surface: "RaaS",
    piiFields: ["grossAmount", "netAmount"],
    buildReason: "Read-only pay summary. Payroll writes are out of scope.",
    liveStatus: "fixture-only",
    actions: [
      { action: "statements", toolClass: "read", access: "read", permission: T.listMyPayStatements.name },
      FIND,
    ],
  },
  {
    name: T.talentTool.name,
    toolClass: "outcome",
    access: "read",
    audience: "worker",
    domain: "talent",
    surface: "catalog",
    piiFields: [],
    buildReason: BR_OUTCOME,
    liveStatus: "fixture-only",
    actions: [FIND],
  },
  {
    name: T.recruitingTool.name,
    toolClass: "outcome",
    access: "read",
    audience: "worker",
    domain: "recruiting",
    surface: "catalog",
    piiFields: [],
    buildReason: BR_OUTCOME,
    liveStatus: "fixture-only",
    actions: [FIND],
  },
  {
    name: T.personalDataTool.name,
    toolClass: "outcome",
    access: "read",
    audience: "worker",
    domain: "personal",
    surface: "catalog",
    piiFields: [],
    buildReason: BR_OUTCOME,
    liveStatus: "fixture-only",
    actions: [FIND],
  },
  {
    name: T.expensesTool.name,
    toolClass: "outcome",
    access: "read",
    audience: "worker",
    domain: "expenses",
    surface: "catalog",
    piiFields: [],
    buildReason: BR_OUTCOME,
    liveStatus: "fixture-only",
    actions: [FIND],
  },
  {
    name: T.businessProcessTool.name,
    toolClass: "outcome",
    access: "read",
    audience: "worker",
    domain: "meta",
    surface: "catalog",
    piiFields: [],
    buildReason: BR_OUTCOME,
    liveStatus: "fixture-only",
    actions: [FIND],
  },
  {
    name: T.catalogTool.name,
    toolClass: "outcome",
    access: "read",
    audience: "worker",
    domain: "meta",
    surface: "catalog",
    piiFields: [],
    buildReason: "Compact catalog search so the model does not load one definition per Workday operation.",
    liveStatus: "fixture-only",
    actions: [
      { action: "search", toolClass: "read", access: "read", permission: T.listAgentReadyTools.name },
      { action: "get", toolClass: "read", access: "read", permission: T.getAgentReadyTool.name },
    ],
  },
];

/** Roles allowed for a registry entry (from src/rbac/permissions.ts; kept parallel to stay DRY). */
export const rolesFor = (e: RegistryEntry): readonly Role[] => TOOL_PERMISSIONS[e.name] ?? [];

/** Registry entry by tool name. */
export const registryEntry = (name: string): RegistryEntry | undefined => TOOL_REGISTRY.find((t) => t.name === name);

/** True for a registry commit tool or an outcome action whose permission is a commit. */
export function isCommitTool(name: string): boolean {
  return TOOL_REGISTRY.some(
    (tool) =>
      (tool.name === name && tool.toolClass === "write-commit") ||
      tool.actions?.some((action) => action.permission === name && action.toolClass === "write-commit"),
  );
}

/** Static guardrails, also asserted at startup. catalogNames are opt-in granular tools. */
export function assertRegistryInvariants(registeredNames: string[], opts?: { catalogNames?: readonly string[] }): void {
  const names = TOOL_REGISTRY.map((t) => t.name);
  if (new Set(names).size !== names.length) throw new Error("Duplicate tool names in registry");
  const permissionKeys = new Set<string>();
  for (const t of TOOL_REGISTRY) {
    if (/call_workday|passthrough|raw/i.test(t.name)) throw new Error(`Forbidden passthrough tool: ${t.name}`);
    const actions = t.actions ?? [];
    if (t.domain === "payroll" && (t.access === "write" || actions.some((a) => a.access === "write"))) {
      throw new Error(`Payroll write tools are forbidden: ${t.name}`);
    }
    if (t.toolClass === "outcome" && actions.length === 0) throw new Error(`Outcome tool has no actions: ${t.name}`);
    if (t.toolClass !== "outcome" && t.toolClass !== "read" && !t.pairedWith)
      throw new Error(`Write tool without preview/commit pair: ${t.name}`);
    if (t.destructive && t.toolClass !== "write-commit")
      throw new Error(`Only commit tools can be destructive: ${t.name}`);
    const roles = TOOL_PERMISSIONS[t.name];
    if (!roles || roles.length === 0) throw new Error(`Tool has no RBAC mapping in src/rbac/permissions.ts: ${t.name}`);
    if (t.access === "write" && roles.includes("payroll_viewer"))
      throw new Error(`payroll_viewer must not have write tools: ${t.name}`);
    for (const action of actions) {
      permissionKeys.add(action.permission);
      if (action.toolClass !== "read" && !action.pairedWith)
        throw new Error(`Write action without pair: ${t.name}.${action.action}`);
      if (action.destructive && action.toolClass !== "write-commit")
        throw new Error(`Only commit actions can be destructive: ${t.name}.${action.action}`);
      const actionRoles = TOOL_PERMISSIONS[action.permission];
      if (!actionRoles?.length) throw new Error(`Action has no RBAC mapping: ${action.permission}`);
      if (action.access === "write" && actionRoles.includes("payroll_viewer"))
        throw new Error(`payroll_viewer must not have write actions: ${action.permission}`);
      if (action.pairedWith) {
        const pair = actions.find((item) => item.action === action.pairedWith);
        if (!pair) throw new Error(`Missing pair action ${action.pairedWith} on ${t.name}`);
        if ((TOOL_PERMISSIONS[pair.permission] ?? []).join() !== actionRoles.join()) {
          throw new Error(`Preview/commit pair must share roles: ${action.permission}`);
        }
      }
    }
  }
  const known = new Set([...names, ...permissionKeys]);
  const orphanRbac = Object.keys(TOOL_PERMISSIONS).filter((n) => !known.has(n));
  if (orphanRbac.length) throw new Error(`RBAC mappings for unknown tools: ${orphanRbac.join(",")}`);
  const catalog = new Set(opts?.catalogNames ?? []);
  const missing = names.filter((n) => !registeredNames.includes(n));
  const extra = registeredNames.filter((n) => !names.includes(n) && !catalog.has(n));
  if (missing.length || extra.length) {
    throw new Error(`Registry mismatch. missing=${missing.join(",")} extra=${extra.join(",")}`);
  }
}
