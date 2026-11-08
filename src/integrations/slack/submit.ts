/**
 * Shared "commit an approved request from Slack" path for `/workday submit` and the Submit
 * button. The caller identity comes from the signed Slack request; commitApproved only lets
 * the requester commit. The idempotency key is derived from the request id, so Slack retries
 * and double clicks never double-commit.
 *
 * Slack needs an ack within 3 s and trigger ids expire after 3 s. The commit waits up to
 * budgetMs inside the ack; a slower Workday call finishes in the background and `onLate`
 * delivers the result (through the interaction's response_url, valid for 30 minutes).
 */
import type { BoundIdentity } from "../identity.js";
import { ApprovalError } from "../approvals/workflow.js";
import type { ApprovalExecutionService } from "../approvals/execution.js";
import { RbacDeniedError } from "../../rbac/enforce.js";
import { withinBudget } from "./api.js";
import { commitResultText } from "./notify.js";
import { slackErrorMessage } from "./errors.js";
import { defaultLog, type IntakeLog } from "./redact.js";

export const ACK_BUDGET_MS = 2500;

export type SubmitResult = { ok: boolean; text: string };
export type SubmitOutcome = SubmitResult & { done: boolean };

export type SubmitDeps = {
  service: ApprovalExecutionService;
  commandName: string;
  budgetMs?: number;
  log?: IntakeLog;
};

export async function submitFromSlack(
  deps: SubmitDeps,
  caller: BoundIdentity,
  requestId: string,
  onLate?: (result: SubmitResult) => Promise<unknown>,
): Promise<SubmitOutcome> {
  const log = deps.log ?? defaultLog;
  const settled: Promise<SubmitResult> = deps.service.commitApproved(caller, requestId, `slack-submit-${requestId}`).then(
    (result) => ({ ok: true, text: commitResultText(result) }),
    (e: unknown) => {
      log({ evt: "commit_failed", code: e instanceof ApprovalError ? e.code : e instanceof RbacDeniedError ? "rbac" : e instanceof Error ? e.name : "error" });
      return { ok: false, text: slackErrorMessage(e, deps.commandName)?.text ?? "Not done: internal error." };
    },
  );
  const res = await withinBudget(settled, deps.budgetMs ?? ACK_BUDGET_MS);
  if (res.done) return { done: true, ...res.value };
  if (onLate) void settled.then((v) => onLate(v)).catch((e: unknown) => log({ evt: "late_report_failed", err: e instanceof Error ? e.name : "error" }));
  return { done: false, ok: true, text: `Submitting ${requestId} to Workday. The result will appear here; or check \`${deps.commandName} status ${requestId}\`.` };
}
