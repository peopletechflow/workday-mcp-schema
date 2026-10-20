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
import { assertAgentReadyCallAllowed, assertAgentReadyScope, AgentReadyWriteDeniedError } from "../rbac/agent-ready.js";
import type { Role } from "../rbac/roles.js";
import type { IdempotencyStore } from "./idempotency.js";
import type { PreviewStore } from "./preview-store.js";

export type NativeBpFlow =
  | "request_time_off"
  | "cancel_time_off"
  | "personal_information_change"
  | "home_contact_change"
  | "goal_progress";

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
  goal_progress: { open: "create_worker_goal_events", stage: ["edit_worker_goals"], submit: "submit_worker_goal_events" },
};

export const NATIVE_WRITE_PREVIEW_KIND = "native_bp_write";

export type NativeCall = { tool: string; args: Record<string, unknown> };

export type StagedWritePlan = {
  flow: NativeBpFlow;
  /** Human-readable current -> proposed summary shown to the user. */
  summary: string;
  /** Always the caller: "me" or the caller's own WID. */
  contextInstanceId: string;
  open?: NativeCall;
  stage: NativeCall[];
  submit: NativeCall;
};

export type NativeWriteCaller = { userId: string; roles: readonly Role[]; callerWid?: string };

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
  if (plan.submit.tool !== def.submit) throw new NativeWriteGuardError(`Flow '${plan.flow}' must submit with ${def.submit}.`);
  for (const s of plan.stage) {
    if (def.knownGaps?.includes(s.tool)) {
      throw new NativeWriteGuardError(`${s.tool} is referenced by the skill but not exposed by the tenant (known gap).`);
    }
    if (!def.stage.includes(s.tool)) throw new NativeWriteGuardError(`${s.tool} is not a stage step of '${plan.flow}'.`);
  }
  if (!def.open && plan.stage.length) throw new NativeWriteGuardError(`Flow '${plan.flow}' is single-step; no stage calls.`);
  for (const c of [plan.open, ...plan.stage, plan.submit].filter((c): c is NativeCall => !!c)) {
    const t = getByName(c.tool);
    if (!t || t.readOnly !== false) throw new NativeWriteGuardError(`${c.tool} is not a catalogued native write tool.`);
  }
}

/** Preview: validate + RBAC (self only), mint a user-bound token. Calls nothing in Workday. */
export function previewNativeWrite(
  store: PreviewStore,
  caller: NativeWriteCaller,
  plan: StagedWritePlan,
): { previewToken: string; summary: string; steps: string[]; nextStep: string } {
  validateStagedWritePlan(plan);
  const ctx = { contextInstanceId: plan.contextInstanceId, callerWid: caller.callerWid };
  const steps = [plan.open, ...plan.stage, plan.submit].filter((c): c is NativeCall => !!c);
  for (const c of steps) assertAgentReadyScope(caller.roles, c.tool, ctx);
  const previewToken = store.createGeneric(NATIVE_WRITE_PREVIEW_KIND, caller.userId, plan.summary, plan);
  return {
    previewToken,
    summary: plan.summary,
    steps: steps.map((c) => c.tool),
    nextStep:
      'Show the summary and ask "Shall I submit this? Please confirm with yes or no." On yes, call commitNativeWrite ' +
      "with this previewToken, userConfirmed=true and a fresh idempotencyKey. On no, discard.",
  };
}

/** Adapter that performs one native Workday MCP call as the user (ASU token). */
export type NativeWriteAdapter = {
  call(tool: string, args: Record<string, unknown>, ctx: { eventWid?: string }): Promise<unknown>;
  /** Extract the event WID from the open step's response (shape discovered at runtime). */
  eventWidFrom(openResult: unknown): string | undefined;
};

export type NativeWriteResult = {
  replayed: boolean;
  submitted: boolean;
  flow: NativeBpFlow;
  eventWid?: string;
  /** Set when a step after "open" failed: the open event must be discarded/cancelled in Workday. */
  discardRequired?: boolean;
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
  if (cached) return { ...(cached.body as NativeWriteResult), replayed: true };

  const { data: plan } = deps.previewStore.consumeGeneric<StagedWritePlan>(
    input.previewToken,
    caller.userId,
    NATIVE_WRITE_PREVIEW_KIND,
  );
  validateStagedWritePlan(plan);
  const ctx = { contextInstanceId: plan.contextInstanceId, callerWid: caller.callerWid, previewConfirmed: true };
  const run = async (c: NativeCall, eventWid?: string) => {
    assertAgentReadyCallAllowed(caller.roles, c.tool, ctx);
    return adapter.call(c.tool, c.args, { eventWid });
  };

  // Re-check every step before touching Workday (roles may have changed since preview);
  // a denial here throws and is never pinned to the idempotency key.
  for (const c of [plan.open, ...plan.stage, plan.submit]) if (c) assertAgentReadyCallAllowed(caller.roles, c.tool, ctx);

  let eventWid: string | undefined;
  let result: NativeWriteResult;
  try {
    if (plan.open) {
      eventWid = adapter.eventWidFrom(await run(plan.open));
      if (!eventWid) throw new NativeWriteGuardError(`${plan.open.tool} returned no event WID.`);
    }
    for (const s of plan.stage) await run(s, eventWid);
    const submitResult = await run(plan.submit, eventWid);
    result = { replayed: false, submitted: true, flow: plan.flow, eventWid, submitResult };
  } catch (e) {
    result = {
      replayed: false,
      submitted: false,
      flow: plan.flow,
      eventWid,
      discardRequired: Boolean(eventWid),
      error: e instanceof Error ? e.message : String(e),
    };
  }
  deps.idempotency.set(caller.userId, NATIVE_WRITE_PREVIEW_KIND, input.idempotencyKey, {
    status: result.submitted ? "ok" : "error",
    body: result,
    workdayEventId: eventWid,
  });
  return result;
}
