/**
 * Approval delivery to Slack. Only runs when explicitly invoked by the caller AND
 * SLACK_APPROVAL_DELIVERY=explicit with a channel and bot token configured.
 * Intake never calls this automatically.
 */
import type { SlackConfig } from "../config.js";
import type { ApprovalRequest } from "../approvals/workflow.js";
import { APPROVE_ACTION, REJECT_ACTION } from "./interactions.js";

export function buildApprovalBlocks(r: Readonly<ApprovalRequest>): Record<string, unknown>[] {
  const value = `${r.id}|${r.changeHash}`;
  return [
    { type: "section", text: { type: "mrkdwn", text: `*Approval needed* (${r.commitTool})\n${escapeMrkdwn(r.summary)}` } },
    { type: "context", elements: [{ type: "mrkdwn", text: `Change hash \`${r.changeHash.slice(0, 16)}\` expires <!date^${Math.floor(r.expiresAt / 1000)}^{date_short_pretty} {time}|soon>` }] },
    {
      type: "actions",
      elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: APPROVE_ACTION, value },
        { type: "button", style: "danger", text: { type: "plain_text", text: "Reject" }, action_id: REJECT_ACTION, value },
      ],
    },
  ];
}

export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function deliverApprovalRequest(
  config: SlackConfig,
  r: Readonly<ApprovalRequest>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ delivered: boolean; reason?: string }> {
  if (!config.enabled || config.approvalDelivery !== "explicit") return { delivered: false, reason: "delivery_not_enabled" };
  if (!config.approvalChannelId || !config.botToken) return { delivered: false, reason: "delivery_not_configured" };
  const res = await fetchImpl("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${config.botToken}` },
    body: JSON.stringify({ channel: config.approvalChannelId, text: `Approval needed: ${r.commitTool}`, blocks: buildApprovalBlocks(r) }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  return body.ok ? { delivered: true } : { delivered: false, reason: body.error ?? `http_${res.status}` };
}
