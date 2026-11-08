/**
 * Block actions: Approve / Reject (approvers) and Submit to Workday (requester).
 *
 * The acting identity is the signed Slack interaction's team+user resolved through the
 * server identity map; button values carry only ids and the change hash (no secrets) and the
 * workflow re-validates everything. Feedback goes back through the interaction's response_url
 * (hooks.slack.com only): a decision replaces the message, an error is an ephemeral note that
 * keeps the buttons so the person can retry after fixing the cause.
 */
import { z } from "zod";
import type { SlackConfig } from "../config.js";
import type { IdentityResolver } from "../identity.js";
import { ApprovalError, type ApprovalDecider } from "../approvals/workflow.js";
import type { ApprovalExecutionService } from "../approvals/execution.js";
import { type ReplayGuard, SlackVerificationError, verifySlackRequest } from "./verify.js";
import { isSlackResponseUrl, withinBudget } from "./api.js";
import { APPROVE_ACTION, REJECT_ACTION, SUBMIT_ACTION, type SlackApprovalNotifier } from "./notify.js";
import { ACK_BUDGET_MS, submitFromSlack } from "./submit.js";
import { slackErrorMessage } from "./errors.js";
import type { IntakeLog } from "./redact.js";

const Payload = z.object({
  type: z.literal("block_actions"),
  team: z.object({ id: z.string() }),
  user: z.object({ id: z.string() }),
  response_url: z.string().max(512).optional(),
  actions: z.array(z.object({ action_id: z.string(), value: z.string().max(200) })).min(1).max(1),
});

const APR_ID = /^apr_[A-Za-z0-9_-]{16,64}$/;

export type DecisionOutcome = {
  status: 200 | 400 | 401 | 403;
  ok: boolean;
  kind?: "decision" | "submit";
  reason?: string;
  requestStatus?: string;
  /** What the person was told (ack body or response_url). */
  text?: string;
};

export type InteractionDeps = {
  config: SlackConfig;
  identities: IdentityResolver;
  replay: ReplayGuard;
  workflow: ApprovalDecider;
  /** Needed for the Submit button; absent means the button is not offered or honored. */
  service?: ApprovalExecutionService;
  notifier?: SlackApprovalNotifier;
  commandName?: string;
  nowSec?: number;
  budgetMs?: number;
  log?: IntakeLog;
};

export async function handleApprovalAction(rawBody: string, headers: Record<string, string | undefined>, deps: InteractionDeps): Promise<DecisionOutcome> {
  if (!deps.config.enabled) return { status: 403, ok: false, reason: "slack_disabled" };
  if (Buffer.byteLength(rawBody) > deps.config.maxBodyBytes) return { status: 400, ok: false, reason: "body_too_large" };
  try {
    await verifySlackRequest({ rawBody, headers, signingSecret: deps.config.signingSecret, replay: deps.replay, nowSec: deps.nowSec });
  } catch (e) {
    return { status: 401, ok: false, reason: e instanceof SlackVerificationError ? e.reason : "verify_failed" };
  }
  let p: z.infer<typeof Payload>;
  try {
    p = Payload.parse(JSON.parse(new URLSearchParams(rawBody).get("payload") ?? ""));
  } catch {
    return { status: 400, ok: false, reason: "bad_payload" };
  }
  if (!deps.config.allowedTeamIds.includes(p.team.id)) return { status: 403, ok: false, reason: "team_not_allowed" };
  const action = p.actions[0]!;
  const responseUrl = isSlackResponseUrl(p.response_url) ? p.response_url : undefined;
  const budget = deps.budgetMs ?? ACK_BUDGET_MS;
  const commandName = deps.commandName ?? "/workday";
  const tell = (pr: Promise<unknown> | undefined) => withinBudget(pr ?? Promise.resolve(), budget);

  if (action.action_id === SUBMIT_ACTION) {
    if (!deps.service) return { status: 400, ok: false, kind: "submit", reason: "submit_not_configured" };
    if (!APR_ID.test(action.value)) return { status: 400, ok: false, kind: "submit", reason: "bad_value" };
    const caller = await deps.identities.resolveSlack(p.team.id, p.user.id);
    if (!caller) return { status: 403, ok: false, kind: "submit", reason: "unlinked_user" };
    const out = await submitFromSlack({ service: deps.service, commandName, budgetMs: budget, log: deps.log }, caller, action.value, (late) =>
      deps.notifier?.replace(responseUrl, late.ok ? late.text : `${late.text} Run \`${commandName} submit ${action.value}\` to retry.`) ?? Promise.resolve(),
    );
    // Success or "still running" replaces the button message; a fixable failure keeps the button.
    await tell(out.ok ? deps.notifier?.replace(responseUrl, out.text) : deps.notifier?.ephemeral(responseUrl, out.text));
    return { status: 200, ok: out.ok, kind: "submit", text: out.text, ...(out.ok ? {} : { reason: "commit_failed" }) };
  }

  const decision = action.action_id === APPROVE_ACTION ? "approve" : action.action_id === REJECT_ACTION ? "reject" : undefined;
  if (!decision) return { status: 400, ok: false, reason: "unknown_action" };
  const [requestId, presentedHash] = action.value.split("|");
  if (!requestId || !presentedHash) return { status: 400, ok: false, reason: "bad_value" };
  const approver = await deps.identities.resolveSlack(p.team.id, p.user.id);
  if (!approver) return { status: 403, ok: false, reason: "unlinked_user" };
  try {
    const r = await deps.workflow.decide({ requestId, approver, decision, presentedHash });
    await tell(deps.notifier?.decided(r, { responseUrl, deciderSlackUserId: p.user.id }));
    return { status: 200, ok: true, kind: "decision", requestStatus: r.status };
  } catch (e) {
    if (e instanceof ApprovalError) {
      const text = slackErrorMessage(e, commandName)?.text ?? `Not done: ${e.code}.`;
      await tell(deps.notifier?.ephemeral(responseUrl, text));
      return { status: 403, ok: false, kind: "decision", reason: e.code, text };
    }
    throw e;
  }
}
