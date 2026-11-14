/**
 * Preview -> confirm guardrail for NATIVE Agent-Ready write tools (self-service-skill).
 *
 * Workday self-service writes are staged business-process events:
 *   open   create_* event          -> event WID
 *   stage  create_/update_/edit_*  (0..n calls against the event)
 *   submit submit_* (or a single-step create_/update_ that submits by itself)
 *
 * This layer never calls a native write directly. A caller first builds a StagedWritePlan and
 * gets a preview token (PreviewStore.createGeneric, user-bound, 15 min TTL). Only
 * commitNativeWrite with that token + userConfirmed=true + an idempotencyKey executes the plan,
 * and every step is re-checked with assertAgentReadyCallAllowed({ previewConfirmed: true }).
 * Argument shapes are passthrough (native schemas are discovered at runtime).
 */
import { getByName } from "../agent-ready/registry.js";
import {
  assertAgentReadyCallAllowed,
  assertAgentReadyScope,
  AgentReadyWriteDeniedError,
  type AgentReadyCallContext,
} from "../rbac/agent-ready.js";
import type { Role } from "../rbac/roles.js";
import type { IdempotencyStore } from "./idempotency.js";
import type { PreviewStore } from "./preview-store.js";
import { classifyCommitFailure } from "./commit-outcome.js";

export type NativeBpFlow =
  | "request_time_off"
  | "cancel_time_off"
  | "personal_information_change"
  | "home_contact_change"
  | "goal_progress"
  // manager-actions-skill
  | "approve_step"
  | "deny_step"
  | "change_job"
  | "performance_review"
  | "anytime_feedback"
  | "payroll_input"
  // hr-partner-skill
  | "leave_of_absence"
  | "passport_visa_change"
  | "government_id_change";

/** Flows from manager-actions-skill: preview details are mandatory. */
export const MANAGER_ACTION_FLOWS: readonly NativeBpFlow[] = [
  "approve_step",
  "deny_step",
  "change_job",
  "performance_review",
  "anytime_feedback",
  "payroll_input",
];
export const DENY_COMMENT_MAX = 256;
/** Flows whose preview must carry WritePreviewDetails (worker, action, changed fields). */
export const DETAILS_REQUIRED_FLOWS: readonly NativeBpFlow[] = [
  ...MANAGER_ACTION_FLOWS,
  "leave_of_absence",
  "passport_visa_change",
  "government_id_change",
];

export type NativeBpFlowDef = {
  /** Opens the event and returns its WID (absent for single-step flows). */
  open?: string;
  /** Tools allowed to stage changes against the open event. */
  stage: readonly string[];
  /** Read-only helpers allowed between open and stage (e.g. resolve the record WID). */
  reads?: readonly string[];
  submit: string;
  /** Tools the skill references but the tenant skill does not expose yet. */
  knownGaps?: readonly string[];
  /**
   * No open-event tool exists in the tenant (gap): the change event must already exist and its
   * WID be supplied in plan.eventWid; stage steps run against it, then submit.
   */
  externalEvent?: boolean;
};

export const NATIVE_WRITE_FLOWS: Readonly<Record<NativeBpFlow, NativeBpFlowDef>> = {
  request_time_off: { stage: [], submit: "create_worker_time_off_request" },
  cancel_time_off: { stage: [], submit: "update_worker_time_off_entry" },
  personal_information_change: {
    open: "create_personal_information_change_event",
    reads: ["find_detailed_personal_information_change_event"],
    stage: [],
    submit: "submit_personal_information_changes",
    knownGaps: ["update_personal_information_marital_status"],
  },
  home_contact_change: {
    open: "create_worker_home_contact_change",
    reads: ["find_home_contact_change_event"],
    stage: [
      "create_email_address_for_home_contact_change",
      "update_email_address_for_home_contact_change",
      "create_phone_number_for_home_contact_change",
      "update_phone_number_for_home_contact_change",
      "create_address_for_home_contact_change",
      "update_address_on_home_contact_change",
    ],
    submit: "submit_home_contact_change",
  },
  goal_progress: {
    open: "create_worker_goal_events",
    stage: ["edit_worker_goals"],
    submit: "submit_worker_goal_events",
  },
  approve_step: { stage: [], submit: "approve_business_process_event_step" },
  deny_step: { stage: [], submit: "deny_business_process_event_step" },
  // No PATCH field staging after initiate_change_job in this tenant: single-step initiate.
  change_job: { stage: [], submit: "initiate_change_job" },
  performance_review: { stage: [], submit: "initiate_performance_review_for_employee" },
  anytime_feedback: { stage: [], submit: "create_anytime_feedback_events" },
  // Highest-risk write: manager/hr_partner + payroll domain; payroll_viewer never.
  payroll_input: { stage: [], submit: "request_payroll_input" },
  leave_of_absence: { stage: [], submit: "request_worker_leave_of_absence" },
  // GAP: no tool to open a passport/visa or government-identifier change event.
  passport_visa_change: {
    externalEvent: true,
    stage: ["create_passport_ids", "update_passport_ids", "create_visa_ids", "update_visa_ids"],
    submit: "submit_passport_and_visa_changes",
  },
  government_id_change: {
    externalEvent: true,
    stage: ["create_national_ids", "update_national_ids", "create_government_ids", "update_government_ids"],
    submit: "submit_government_identifier_changes",
  },
};

export const NATIVE_WRITE_PREVIEW_KIND = "native_bp_write";

export type NativeCall = { tool: string; args: Record<string, unknown> };

/** What the user must see before confirming (mandatory for manager-actions flows). */
export type WritePreviewDetails = {
  worker: { id: string; descriptor: string };
  /** e.g. "Approve step", "Change job", "Request payroll input". */
  action: string;
  /** YYYY-MM-DD. Required for change_job / payroll_input / performance_review; never defaulted. */
  effectiveDate?: string;
  /** Must be "user" where an effective date is required: the agent asked, it did not default. */
  effectiveDateProvidedBy?: "user";
  changedFields: { field: string; from?: unknown; to: unknown }[];
};

export type PreviewApprovers =
  | { source: "find_remaining_steps_for_business_process_event"; eventWid: string; approvers: string[] }
  | { source: "tenant-bp-config"; note: string };

export type StagedWritePlan = {
  flow: NativeBpFlow;
  /** Existing BP event (approve/deny, or a routed event): approvers are read from it. */
  eventWid?: string | undefined;
  /** BP step actions: worker the step awaits (supplied by caller code from the step/task read). */
  awaitingApproverWid?: string | undefined;
  details?: WritePreviewDetails | undefined;
  /** Human-readable current -> proposed summary shown to the user. */
  summary: string;
  /**
   * Target / subject worker: "me" or own WID for self-service flows; for manager actions the
   * worker acted on (must pass team / org scope).
   */
  contextInstanceId: string;
  open?: NativeCall | undefined;
  stage: NativeCall[];
  submit: NativeCall;
};

export type NativeWriteCaller = {
  userId: string;
  roles: readonly Role[];
  callerWid?: string;
  /** Runtime scope proofs supplied by caller code (re-supplied at commit; team scopes expire). */
  scope?: Pick<AgentReadyCallContext, "teamScope" | "targetInScope" | "payrollDomain" | "orgScope" | "workerOrgProof">;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && ISO_DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

function requireUserEffectiveDate(plan: StagedWritePlan): string {
  const d = plan.details;
  if (!d || !isIsoDate(d.effectiveDate))
    throw new NativeWriteGuardError(`${plan.flow}: effective date (YYYY-MM-DD) is required.`);
  if (d.effectiveDateProvidedBy !== "user") {
    throw new NativeWriteGuardError(`${plan.flow}: effective date must be asked from the user, never defaulted.`);
  }
  return d.effectiveDate;
}

/** Flow-specific input rules (args are passthrough except fields named in the discovery notes). */
function validateFlowInputs(plan: StagedWritePlan): void {
  const args = plan.submit.args;
  if (DETAILS_REQUIRED_FLOWS.includes(plan.flow)) {
    const d = plan.details;
    if (!d || !nonEmpty(d.worker?.id) || !nonEmpty(d.worker?.descriptor) || !nonEmpty(d.action)) {
      throw new NativeWriteGuardError(`${plan.flow}: preview needs worker (id + name) and action.`);
    }
    if (!Array.isArray(d.changedFields) || d.changedFields.length === 0) {
      throw new NativeWriteGuardError(`${plan.flow}: preview needs the changed fields.`);
    }
  }
  switch (plan.flow) {
    case "approve_step":
    case "deny_step": {
      if (!nonEmpty(plan.awaitingApproverWid))
        throw new NativeWriteGuardError(`${plan.flow}: awaitingApproverWid is required.`);
      const c = args.comment;
      if (plan.flow === "deny_step") {
        if (!nonEmpty(c)) throw new NativeWriteGuardError("deny_step: comment is required.");
        if (c.length > DENY_COMMENT_MAX)
          throw new NativeWriteGuardError(`deny_step: comment must be <= ${DENY_COMMENT_MAX} characters.`);
      } else if (c !== undefined && typeof c !== "string") {
        throw new NativeWriteGuardError("approve_step: comment must be a string.");
      }
      return;
    }
    case "change_job":
      requireUserEffectiveDate(plan);
      return;
    case "leave_of_absence":
      // Start date is the effective date: required, asked from the user, never defaulted.
      requireUserEffectiveDate(plan);
      return;
    case "performance_review": {
      if (args.reviewAboutWorker !== plan.contextInstanceId) {
        throw new NativeWriteGuardError("performance_review: reviewAboutWorker must equal the target worker.");
      }
      if (!nonEmpty(args.reviewTemplate))
        throw new NativeWriteGuardError("performance_review: reviewTemplate is required.");
      if (!isIsoDate(args.startDate) || !isIsoDate(args.endDate) || args.endDate < args.startDate) {
        throw new NativeWriteGuardError("performance_review: valid startDate <= endDate (YYYY-MM-DD) required.");
      }
      if (requireUserEffectiveDate(plan) !== args.startDate) {
        throw new NativeWriteGuardError("performance_review: preview effective date must equal startDate.");
      }
      return;
    }
    case "payroll_input": {
      const pi = args.payrollInput as Record<string, unknown> | undefined;
      if (!pi || typeof pi !== "object") throw new NativeWriteGuardError("payroll_input: payrollInput is required.");
      if (pi.worker !== plan.contextInstanceId)
        throw new NativeWriteGuardError("payroll_input: payrollInput.worker must equal the target worker.");
      if (!nonEmpty(pi.payComponent))
        throw new NativeWriteGuardError("payroll_input: payrollInput.payComponent is required.");
      if (!isIsoDate(pi.startDate))
        throw new NativeWriteGuardError("payroll_input: payrollInput.startDate (YYYY-MM-DD) is required.");
      if (typeof pi.ongoing !== "boolean")
        throw new NativeWriteGuardError("payroll_input: payrollInput.ongoing (boolean) is required.");
      if (pi.ongoing === false && (!isIsoDate(pi.endDate) || pi.endDate < pi.startDate)) {
        throw new NativeWriteGuardError("payroll_input: endDate (>= startDate) is required when ongoing=false.");
      }
      const details = pi.inputDetails;
      if (!Array.isArray(details) || details.length === 0)
        throw new NativeWriteGuardError("payroll_input: inputDetails[] is required.");
      for (const d of details as Record<string, unknown>[]) {
        if (!nonEmpty(d?.type))
          throw new NativeWriteGuardError("payroll_input: inputDetails[].type (WID) is required.");
        if (typeof d.value !== "number" || !Number.isFinite(d.value)) {
          throw new NativeWriteGuardError("payroll_input: inputDetails[].value must be a number.");
        }
      }
      const bp = args.businessProcessParameters as Record<string, unknown> | undefined;
      if (!nonEmpty(bp?.action))
        throw new NativeWriteGuardError("payroll_input: businessProcessParameters.action is required.");
      if (requireUserEffectiveDate(plan) !== pi.startDate) {
        throw new NativeWriteGuardError("payroll_input: preview effective date must equal payrollInput.startDate.");
      }
      return;
    }
    case "request_time_off":
    case "cancel_time_off":
    case "personal_information_change":
    case "home_contact_change":
    case "goal_progress":
    case "anytime_feedback":
    case "passport_visa_change":
    case "government_id_change":
      return;
    default: {
      const _exhaustive: never = plan.flow;
      return _exhaustive;
    }
  }
}

export class NativeWriteGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeWriteGuardError";
  }
}

/** Structural validation: each step is the right catalogued write tool for this flow/step. */
export function validateStagedWritePlan(plan: StagedWritePlan): void {
  const def = NATIVE_WRITE_FLOWS[plan.flow];
  if (!def) throw new NativeWriteGuardError(`Unknown flow '${plan.flow}'.`);
  if ((def.open ?? null) !== (plan.open?.tool ?? null)) {
    throw new NativeWriteGuardError(`Flow '${plan.flow}' must open with ${def.open ?? "no open step"}.`);
  }
  if (plan.submit.tool !== def.submit)
    throw new NativeWriteGuardError(`Flow '${plan.flow}' must submit with ${def.submit}.`);
  for (const s of plan.stage) {
    if (def.knownGaps?.includes(s.tool)) {
      throw new NativeWriteGuardError(
        `${s.tool} is referenced by the skill but not exposed by the tenant (known gap).`,
      );
    }
    if (!def.stage.includes(s.tool))
      throw new NativeWriteGuardError(`${s.tool} is not a stage step of '${plan.flow}'.`);
  }
  if (def.externalEvent) {
    if (!nonEmpty(plan.eventWid)) {
      throw new NativeWriteGuardError(
        `Flow '${plan.flow}': no open-event tool exists in this tenant; supply the existing change event WID (eventWid).`,
      );
    }
    if (!plan.stage.length) throw new NativeWriteGuardError(`Flow '${plan.flow}' needs at least one stage step.`);
  } else if (!def.open && plan.stage.length) {
    throw new NativeWriteGuardError(`Flow '${plan.flow}' is single-step; no stage calls.`);
  }
  validateFlowInputs(plan);
  for (const c of [plan.open, ...plan.stage, plan.submit].filter((c): c is NativeCall => !!c)) {
    const t = getByName(c.tool);
    if (!t || t.readOnly !== false) throw new NativeWriteGuardError(`${c.tool} is not a catalogued native write tool.`);
  }
}

function callCtx(caller: NativeWriteCaller, plan: StagedWritePlan, previewConfirmed?: boolean): AgentReadyCallContext {
  return {
    ...caller.scope,
    contextInstanceId: plan.contextInstanceId,
    callerWid: caller.callerWid,
    awaitingApproverWid: plan.awaitingApproverWid,
    ...(previewConfirmed ? { previewConfirmed: true } : {}),
  };
}

export type NativeWritePreview = {
  previewToken: string;
  summary: string;
  steps: string[];
  preview: {
    worker: WritePreviewDetails["worker"] | null;
    action: string | null;
    effectiveDate: string | null;
    changedFields: WritePreviewDetails["changedFields"];
    approvers: PreviewApprovers;
  };
  nextStep: string;
};

export type PreviewOptions = {
  /**
   * Reads find_remaining_steps_for_business_process_event for plan.eventWid (as the user) and
   * returns approver names. Required whenever the plan carries an eventWid.
   */
  remainingSteps?: (eventWid: string) => Promise<string[]>;
};

/**
 * Preview: validate + RBAC (scope, team, approver, payroll domain), resolve approvers, mint a
 * user-bound token. Performs no Workday write (only the remaining-steps read, if any).
 */
export async function previewNativeWrite(
  store: PreviewStore,
  caller: NativeWriteCaller,
  plan: StagedWritePlan,
  opts: PreviewOptions = {},
): Promise<NativeWritePreview> {
  validateStagedWritePlan(plan);
  const ctx = callCtx(caller, plan);
  const steps = [plan.open, ...plan.stage, plan.submit].filter((c): c is NativeCall => !!c);
  for (const c of steps) assertAgentReadyScope(caller.roles, c.tool, ctx);

  let approvers: PreviewApprovers;
  if (plan.eventWid) {
    if (!opts.remainingSteps)
      throw new NativeWriteGuardError("Event exists: remainingSteps lookup is required to show approvers.");
    assertAgentReadyCallAllowed(caller.roles, "find_remaining_steps_for_business_process_event", {
      ...ctx,
      awaitingApproverWid: plan.awaitingApproverWid,
    });
    approvers = {
      source: "find_remaining_steps_for_business_process_event",
      eventWid: plan.eventWid,
      approvers: await opts.remainingSteps(plan.eventWid),
    };
  } else {
    approvers = {
      source: "tenant-bp-config",
      note: "No business process event yet: approvers are determined by the tenant's business process configuration on submit.",
    };
  }
  const previewToken = store.createGeneric(NATIVE_WRITE_PREVIEW_KIND, caller.userId, plan.summary, plan);
  return {
    previewToken,
    summary: plan.summary,
    steps: steps.map((c) => c.tool),
    preview: {
      worker: plan.details?.worker ?? null,
      action: plan.details?.action ?? null,
      effectiveDate: plan.details?.effectiveDate ?? null,
      changedFields: plan.details?.changedFields ?? [],
      approvers,
    },
    nextStep:
      'Show the preview and ask "Shall I submit this? Please confirm with yes or no." On yes, call commitNativeWrite ' +
      "with this previewToken, userConfirmed=true and a fresh idempotencyKey. On no, discard.",
  };
}

/** Adapter that performs one native Workday MCP call as the user (ASU token). */
export type NativeWriteAdapter = {
  call(tool: string, args: Record<string, unknown>, ctx: { eventWid?: string | undefined }): Promise<unknown>;
  /** Extract the event WID from the open step's response (shape discovered at runtime). */
  eventWidFrom(openResult: unknown): string | undefined;
};

export type NativeWriteResult = {
  replayed: boolean;
  submitted: boolean;
  flow: NativeBpFlow;
  eventWid?: string | undefined;
  /** Set when a step after "open" failed: the open event must be discarded/cancelled in Workday. */
  discardRequired?: boolean;
  /** True when the submit may have reached Workday and must be reconciled, not retried. */
  uncertain?: boolean;
  error?: string;
  submitResult?: unknown;
};

/**
 * Commit: requires userConfirmed + idempotencyKey; consumes the preview token (one use, same
 * user, unexpired); replays a stored result on retry; runs open -> stage -> submit.
 */
export async function commitNativeWrite(
  deps: { previewStore: PreviewStore; idempotency: IdempotencyStore },
  caller: NativeWriteCaller,
  input: { previewToken: string; userConfirmed: boolean; idempotencyKey: string },
  adapter: NativeWriteAdapter,
): Promise<NativeWriteResult> {
  if (input.userConfirmed !== true) {
    throw new AgentReadyWriteDeniedError("native write", caller.roles, "requires userConfirmed=true.");
  }
  if (!input.idempotencyKey?.trim()) throw new NativeWriteGuardError("idempotencyKey is required.");
  const cached = deps.idempotency.get(caller.userId, NATIVE_WRITE_PREVIEW_KIND, input.idempotencyKey);
  if (cached?.status === "unknown") {
    return { ...(cached.body as NativeWriteResult), replayed: true, uncertain: true };
  }
  if (cached) return { ...(cached.body as NativeWriteResult), replayed: true };

  const { data: plan } = deps.previewStore.consumeGeneric<StagedWritePlan>(
    input.previewToken,
    caller.userId,
    NATIVE_WRITE_PREVIEW_KIND,
  );
  validateStagedWritePlan(plan);
  const ctx = callCtx(caller, plan, true);
  const run = async (c: NativeCall, eventWid?: string) => {
    assertAgentReadyCallAllowed(caller.roles, c.tool, ctx);
    return adapter.call(c.tool, c.args, { eventWid });
  };

  // Re-check every step before touching Workday (roles may have changed since preview);
  // a denial here throws and is never pinned to the idempotency key.
  for (const c of [plan.open, ...plan.stage, plan.submit])
    if (c) assertAgentReadyCallAllowed(caller.roles, c.tool, ctx);

  const external = Boolean(NATIVE_WRITE_FLOWS[plan.flow].externalEvent);
  let eventWid: string | undefined = external ? plan.eventWid : undefined;
  let touched = false; // an event we opened or staged on may need discarding on failure
  let result: NativeWriteResult;
  try {
    if (plan.open) {
      eventWid = adapter.eventWidFrom(await run(plan.open));
      if (!eventWid) throw new NativeWriteGuardError(`${plan.open.tool} returned no event WID.`);
      touched = true;
    }
    for (const s of plan.stage) {
      touched = true;
      await run(s, eventWid);
    }
    const submitResult = await run(plan.submit, eventWid);
    result = { replayed: false, submitted: true, flow: plan.flow, eventWid, submitResult };
  } catch (e) {
    const state = classifyCommitFailure(e);
    result = {
      replayed: false,
      submitted: false,
      flow: plan.flow,
      eventWid,
      discardRequired: touched && Boolean(eventWid),
      uncertain: state === "unknown",
      error: e instanceof Error ? e.name : "error",
    };
    deps.idempotency.set(caller.userId, NATIVE_WRITE_PREVIEW_KIND, input.idempotencyKey, {
      status: state,
      body: result,
      workdayEventId: eventWid,
    });
    return result;
  }
  deps.idempotency.set(caller.userId, NATIVE_WRITE_PREVIEW_KIND, input.idempotencyKey, {
    status: "ok",
    body: result,
    workdayEventId: eventWid,
  });
  return result;
}
