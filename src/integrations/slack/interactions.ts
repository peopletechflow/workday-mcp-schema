/**
 * Approve / reject buttons. The approver identity is the signed Slack interaction's
 * team+user resolved through the server identity map. Button value carries only the
 * request id and change hash (no secrets); the workflow re-validates both.
 */
import { z } from "zod";
import type { SlackConfig } from "../config.js";
import type { IdentityDirectory } from "../identity.js";
import { ApprovalError, type ApprovalWorkflow } from "../approvals/workflow.js";
import { ReplayCache, SlackVerificationError, verifySlackRequest } from "./verify.js";

export const APPROVE_ACTION = "wd_approval_approve";
export const REJECT_ACTION = "wd_approval_reject";

const Payload = z.object({
  type: z.literal("block_actions"),
  team: z.object({ id: z.string() }),
  user: z.object({ id: z.string() }),
  actions: z.array(z.object({ action_id: z.string(), value: z.string().max(200) })).min(1).max(1),
});

export type DecisionOutcome = { status: 200 | 400 | 401 | 403; ok: boolean; reason?: string; requestStatus?: string };

export function handleApprovalAction(
  rawBody: string,
  headers: Record<string, string | undefined>,
  deps: { config: SlackConfig; identities: IdentityDirectory; replay: ReplayCache; workflow: ApprovalWorkflow; nowSec?: number },
): DecisionOutcome {
  if (!deps.config.enabled) return { status: 403, ok: false, reason: "slack_disabled" };
  try {
    verifySlackRequest({ rawBody, headers, signingSecret: deps.config.signingSecret, replay: deps.replay, nowSec: deps.nowSec });
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
  const decision = action.action_id === APPROVE_ACTION ? "approve" : action.action_id === REJECT_ACTION ? "reject" : undefined;
  if (!decision) return { status: 400, ok: false, reason: "unknown_action" };
  const [requestId, presentedHash] = action.value.split("|");
  if (!requestId || !presentedHash) return { status: 400, ok: false, reason: "bad_value" };
  const approver = deps.identities.resolveSlack(p.team.id, p.user.id);
  if (!approver) return { status: 403, ok: false, reason: "unlinked_user" };
  try {
    const r = deps.workflow.decide({ requestId, approver, decision, presentedHash });
    return { status: 200, ok: true, requestStatus: r.status };
  } catch (e) {
    if (e instanceof ApprovalError) return { status: 403, ok: false, reason: e.code };
    throw e;
  }
}
