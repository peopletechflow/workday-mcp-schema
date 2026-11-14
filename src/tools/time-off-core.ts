/**
 * Shared time-off preview/commit core. Used by the MCP tools
 * (preview_request_time_off / commit_request_time_off) and by the approval execution
 * service, so both paths go through the same preview store, caller token, duplicate check,
 * idempotency store, and Workday client.
 */
import type { AppConfig } from "../config.js";
import { assertToolEnabled } from "../config.js";
import type { WorkdayClient } from "../workday/client.js";
import type { IdempotencyStore } from "../safety/idempotency.js";
import type { PreviewStore, TimeOffPreviewPayload } from "../safety/preview-store.js";
import type { TokenStore } from "../auth/token-store.js";
import type { PkcePair } from "../auth/oauth.js";
import { ensureFixtureSession, requireUserAccessToken } from "../session.js";
import { AbsenceTypeIdSchema } from "../schemas/common.js";
import type { TimeOffRequestInput, TimeOffRequestResult } from "../workday/types.js";
import { classifyCommitFailure, CommitUncertainError } from "../safety/commit-outcome.js";

export type TimeOffCoreDeps = {
  config: AppConfig;
  client: WorkdayClient;
  previewStore: PreviewStore;
  idempotency: IdempotencyStore;
  tokenStore: TokenStore;
  pendingPkce: Map<string, PkcePair>;
};

export type TimeOffPreviewInput = {
  startDate: string;
  endDate: string;
  unit: "HOURS" | "DAYS";
  quantity: number;
  timeOffType: { type: string; value: string };
  comment?: string;
};

export const COMMIT_TOOL = "commit_request_time_off";
export const PREVIEW_TOOL = "preview_request_time_off";

export function timeOffSummary(a: TimeOffPreviewInput): string {
  return (
    `Request ${a.quantity} ${a.unit.toLowerCase()} of ${a.timeOffType.type}:${a.timeOffType.value} ` +
    `from ${a.startDate} to ${a.endDate}` +
    (a.comment ? ` (comment: ${a.comment.slice(0, 80)})` : "")
  );
}

/** Mint a preview token for the signed-in user. Caller must already have passed RBAC. */
export async function createTimeOffPreview(
  deps: Pick<TimeOffCoreDeps, "config" | "previewStore" | "tokenStore" | "pendingPkce">,
  userId: string,
  args: TimeOffPreviewInput,
): Promise<{ previewToken: string; summary: string; willSubmit: TimeOffPreviewInput }> {
  assertToolEnabled(deps.config, PREVIEW_TOOL);
  if (args.endDate < args.startDate) throw new Error("endDate must be on or after startDate");
  await ensureFixtureSession(deps.config, deps.tokenStore, userId);
  await requireUserAccessToken(deps.config, deps.tokenStore, userId, deps.pendingPkce);
  const summary = timeOffSummary(args);
  const previewToken = deps.previewStore.create({ kind: "request_time_off", userId, ...args, summary });
  return { previewToken, summary, willSubmit: { ...args } };
}

export type TimeOffCommitBody = {
  submitted: boolean;
  reusedExisting: boolean;
  request: TimeOffRequestResult;
  summary: string;
};

export type TimeOffCommitOutcome =
  | { replayed: true; status: "ok" | "error"; body: unknown; workdayEventId?: string | undefined }
  | { replayed: false; status: "ok"; body: TimeOffCommitBody; preview: TimeOffPreviewPayload };

function requestFromPreview(preview: TimeOffPreviewPayload): TimeOffRequestInput {
  return {
    startDate: preview.startDate,
    endDate: preview.endDate,
    unit: preview.unit,
    quantity: preview.quantity,
    timeOffType: AbsenceTypeIdSchema.parse({ type: preview.timeOffType.type, value: preview.timeOffType.value }),
    ...(preview.comment ? { comment: preview.comment } : {}),
  };
}

async function reconcileUnknownTimeOff(
  deps: TimeOffCoreDeps,
  userId: string,
  idempotencyKey: string,
  subject: unknown,
): Promise<TimeOffCommitOutcome | undefined> {
  const input = subject as TimeOffRequestInput | undefined;
  if (!input?.startDate || !input.timeOffType) return undefined;
  await ensureFixtureSession(deps.config, deps.tokenStore, userId);
  const accessToken = await requireUserAccessToken(deps.config, deps.tokenStore, userId, deps.pendingPkce);
  let found: TimeOffRequestResult | undefined;
  try {
    found = await deps.client.findMatchingTimeOffRequest(accessToken, input);
  } catch (err) {
    if (classifyCommitFailure(err) === "unknown") return undefined;
    throw err;
  }
  if (!found) return undefined;
  const body: TimeOffCommitBody = {
    submitted: true,
    reusedExisting: true,
    request: found,
    summary: "Reconciled from Workday.",
  };
  deps.idempotency.resolve(userId, COMMIT_TOOL, idempotencyKey, {
    status: "ok",
    body,
    workdayEventId: found.workdayEventId,
  });
  return { replayed: true, status: "ok", body, workdayEventId: found.workdayEventId };
}

/**
 * Commit with the user's own token. Idempotent per (user, tool, key).
 * Success and definitive 4xx are pinned. Timeouts, 5xx, and network errors are
 * recorded as unknown and reconciled with a read before any retry. Sign-in and
 * preview errors are not pinned.
 */
export async function commitTimeOffPreview(
  deps: TimeOffCoreDeps,
  userId: string,
  previewToken: string,
  idempotencyKey: string,
): Promise<TimeOffCommitOutcome> {
  assertToolEnabled(deps.config, COMMIT_TOOL);
  const cached = deps.idempotency.get(userId, COMMIT_TOOL, idempotencyKey);
  if (cached?.status === "unknown") {
    const reconciled = await reconcileUnknownTimeOff(deps, userId, idempotencyKey, cached.subject);
    if (reconciled) return reconciled;
    throw new CommitUncertainError();
  }
  if (cached)
    return { replayed: true, status: cached.status, body: cached.body, workdayEventId: cached.workdayEventId };
  // Sign-in and preview problems are fixable by the caller: resolve them before consuming the
  // preview, and do not pin them to the idempotency key (a retry with the same key must work).
  await ensureFixtureSession(deps.config, deps.tokenStore, userId);
  const accessToken = await requireUserAccessToken(deps.config, deps.tokenStore, userId, deps.pendingPkce);
  const preview = deps.previewStore.consume(previewToken, userId, "request_time_off");
  const input = requestFromPreview(preview);
  try {
    const existing = await deps.client.findMatchingTimeOffRequest(accessToken, input);
    const result = existing ?? (await deps.client.submitTimeOffRequest(accessToken, input));
    const body: TimeOffCommitBody = {
      submitted: !existing,
      reusedExisting: Boolean(existing),
      request: result,
      summary: preview.summary,
    };
    deps.idempotency.set(userId, COMMIT_TOOL, idempotencyKey, {
      status: "ok",
      body,
      workdayEventId: result.workdayEventId,
      subject: input,
    });
    return { replayed: false, status: "ok", body, preview };
  } catch (err) {
    const state = classifyCommitFailure(err);
    const faultCode =
      err instanceof Error && "fault" in err ? String((err as { fault?: { code?: string } }).fault?.code ?? "") : "";
    deps.idempotency.set(userId, COMMIT_TOOL, idempotencyKey, {
      status: state,
      body: {
        error: state === "unknown" ? "COMMIT_UNCERTAIN" : faultCode || (err instanceof Error ? err.name : "error"),
      },
      subject: input,
    });
    if (state === "unknown") throw new CommitUncertainError();
    throw err;
  }
}
