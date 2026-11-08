/**
 * Slack UI for the approval lifecycle. This module only delivers: it never decides, commits,
 * or authenticates anyone. Messages carry the request summary (type, dates, days) and ids,
 * never the free-text comment (it may hold health details).
 *
 *   proposed  DM each assigned approver (Approve / Reject buttons); fall back to the approval
 *             channel when no approver has an active Slack link; DM the requester a receipt.
 *   decided   replace the approver's message with the decision (buttons gone), then DM the
 *             requester: approved -> "Submit to Workday" button, rejected -> notice.
 *   replace / ephemeral  response_url helpers for button clicks and slow commits.
 *
 * Proactive DMs run only when SLACK_APPROVAL_DELIVERY=explicit and a bot-token client exists.
 * response_url updates run whenever a client exists (they need no token). Intake never calls this.
 */
import type { SlackConfig } from "../config.js";
import type { BoundIdentity, SlackAddress, SlackDirectory } from "../identity.js";
import type { ApprovalRequest } from "../approvals/workflow.js";
import type { LogFn } from "../../observability/log.js";
import { isSlackResponseUrl, type SlackApi } from "./api.js";

export const APPROVE_ACTION = "wd_approval_approve";
export const REJECT_ACTION = "wd_approval_reject";
export const SUBMIT_ACTION = "wd_approval_submit";

export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });
const context = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text }] });
const button = (text: string, action_id: string, value: string, style?: "primary" | "danger") => ({
  type: "button",
  text: { type: "plain_text", text },
  action_id,
  value,
  ...(style ? { style } : {}),
});
/** Slack renders this in the reader's own time zone. */
export const slackDate = (ms: number) => `<!date^${Math.floor(ms / 1000)}^{date_short_pretty} {time}|soon>`;

/** Message for an approver. Button value carries only the request id and change hash. */
export function buildApprovalBlocks(r: Readonly<ApprovalRequest>, opts: { requesterSlackUserId?: string } = {}): Record<string, unknown>[] {
  const value = `${r.id}|${r.changeHash}`;
  const who = opts.requesterSlackUserId ? ` from <@${opts.requesterSlackUserId}>` : "";
  return [
    section(`*Approval needed*${who}\n${escapeMrkdwn(r.summary)}`),
    context(`Request \`${r.id}\`, change \`${r.changeHash.slice(0, 16)}\`. Decide by ${slackDate(r.expiresAt)}.`),
    { type: "actions", block_id: `apr:${r.id}`, elements: [button("Approve", APPROVE_ACTION, value, "primary"), button("Reject", REJECT_ACTION, value, "danger")] },
  ];
}

/** Replacement for the approver's message once a decision exists (no buttons). */
export function buildDecisionBlocks(r: Readonly<ApprovalRequest>, deciderSlackUserId?: string): Record<string, unknown>[] {
  const verb = r.status === "approved" ? "Approved" : r.status === "rejected" ? "Rejected" : r.status;
  const by = deciderSlackUserId ? ` by <@${deciderSlackUserId}>` : "";
  const at = r.decidedAt ? ` at ${slackDate(r.decidedAt)}` : "";
  return [section(`*${verb}*${by}${at}\n${escapeMrkdwn(r.summary)}`), context(`Request \`${r.id}\`.`)];
}

/** What the requester sees at each step. Approved requests get a Submit button. */
export function buildRequesterBlocks(r: Readonly<ApprovalRequest>, commandName: string): Record<string, unknown>[] {
  const summary = escapeMrkdwn(r.summary);
  switch (r.status) {
    case "pending":
      return [section(`*Sent for approval*\n${summary}`), context(`Request \`${r.id}\`. Your approvers were notified. Check with \`${commandName} status ${r.id}\`.`)];
    case "approved":
      return [
        section(`*Approved*\n${summary}\nSubmit it to Workday by ${slackDate(r.expiresAt)}.`),
        { type: "actions", block_id: `sub:${r.id}`, elements: [button("Submit to Workday", SUBMIT_ACTION, r.id, "primary")] },
        context(`Or run \`${commandName} submit ${r.id}\`.`),
      ];
    case "rejected":
      return [section(`*Rejected*\n${summary}`), context(`Request \`${r.id}\`. Start a new request if you still need the time off.`)];
    default:
      return [section(`*${r.status}*\n${summary}`), context(`Request \`${r.id}\`.`)];
  }
}

/** One-line result of a commit, for the ack body or a response_url follow-up. */
export function commitResultText(result: unknown): string {
  const b = result as { request?: { status?: string; workdayEventId?: string }; reusedExisting?: boolean };
  const reused = b.reusedExisting ? " Workday already had this request, so nothing new was created." : "";
  return `Submitted to Workday (${b.request?.status ?? "ok"}, event ${b.request?.workdayEventId ?? "n/a"}).${reused}`;
}

export type Delivery = { delivered: boolean; recipients: number; reason?: string };

export class SlackApprovalNotifier {
  constructor(
    private readonly d: {
      config: SlackConfig;
      api?: SlackApi;
      /** Reverse lookup (tenant user -> Slack user) for DMs. Without it only the fallback channel is used. */
      directory?: SlackDirectory;
      commandName: string;
      log?: LogFn;
    },
  ) {}

  /** Proactive DMs are opt-in: SLACK_APPROVAL_DELIVERY=explicit plus a bot-token client. */
  get deliveryEnabled(): boolean {
    return this.d.config.enabled && this.d.config.approvalDelivery === "explicit" && Boolean(this.d.api);
  }

  private log(fields: Record<string, unknown>): void {
    this.d.log?.({ src: "slack-notify", ...fields });
  }

  private async lookup(identity: BoundIdentity): Promise<SlackAddress | undefined> {
    try {
      return await this.d.directory?.slackFor(identity);
    } catch {
      return undefined;
    }
  }

  private async post(channel: string, text: string, blocks: Record<string, unknown>[]): Promise<boolean> {
    if (!this.d.api) return false;
    try {
      const r = await this.d.api.postMessage(channel, text, blocks);
      if (!r.ok) this.log({ evt: "post_failed", error: r.error });
      return r.ok;
    } catch (e) {
      this.log({ evt: "post_failed", error: e instanceof Error ? e.name : "error" });
      return false;
    }
  }

  private async respond(responseUrl: string | undefined, body: Record<string, unknown>): Promise<boolean> {
    if (!this.d.api || !isSlackResponseUrl(responseUrl)) return false;
    try {
      const r = await this.d.api.respond(responseUrl, body);
      if (!r.ok) this.log({ evt: "respond_failed", error: r.error });
      return r.ok;
    } catch (e) {
      this.log({ evt: "respond_failed", error: e instanceof Error ? e.name : "error" });
      return false;
    }
  }

  /** New pending request: DM assigned approvers (fallback: approval channel), DM the requester a receipt. */
  async proposed(r: Readonly<ApprovalRequest>, requester?: SlackAddress): Promise<Delivery> {
    if (!this.deliveryEnabled) return { delivered: false, recipients: 0, reason: "delivery_not_enabled" };
    if (!this.d.directory && !this.d.config.approvalChannelId) return { delivered: false, recipients: 0, reason: "delivery_not_configured" };
    const requesterAddr = requester ?? (await this.lookup({ tenantId: r.tenantId, userId: r.requesterUserId }));
    const approverIds = r.assignedApprovers.filter((u) => u !== r.requesterUserId);
    const approvers = (await Promise.all(approverIds.map((u) => this.lookup({ tenantId: r.tenantId, userId: u })))).filter((a): a is SlackAddress => Boolean(a));
    const text = `Approval needed: ${r.summary}`;
    const blocks = buildApprovalBlocks(r, { requesterSlackUserId: requesterAddr?.userId });
    let recipients = 0;
    for (const a of approvers) if (await this.post(a.userId, text, blocks)) recipients++;
    if (recipients === 0 && this.d.config.approvalChannelId && (await this.post(this.d.config.approvalChannelId, text, blocks))) recipients++;
    if (requesterAddr) await this.post(requesterAddr.userId, `Sent for approval: ${r.summary}`, buildRequesterBlocks(r, this.d.commandName));
    this.log({ evt: "proposed", req: r.id, recipients });
    return recipients ? { delivered: true, recipients } : { delivered: false, recipients: 0, reason: "no_recipients" };
  }

  /** Decision made: replace the button message, then tell the requester (Submit button when approved). */
  async decided(r: Readonly<ApprovalRequest>, o: { responseUrl?: string; deciderSlackUserId?: string }): Promise<void> {
    const verb = r.status === "approved" ? "Approved" : r.status === "rejected" ? "Rejected" : r.status;
    await this.respond(o.responseUrl, { replace_original: true, text: `${verb}: ${r.summary}`, blocks: buildDecisionBlocks(r, o.deciderSlackUserId) });
    if (!this.deliveryEnabled) return;
    const requester = await this.lookup({ tenantId: r.tenantId, userId: r.requesterUserId });
    if (requester) await this.post(requester.userId, `${verb}: ${r.summary}`, buildRequesterBlocks(r, this.d.commandName));
    this.log({ evt: "decided", req: r.id, status: r.status, requesterNotified: Boolean(requester) });
  }

  /** Replace the message a button lived on (or a slash-command ack) with a final result. */
  async replace(responseUrl: string | undefined, text: string, blocks?: Record<string, unknown>[]): Promise<boolean> {
    return this.respond(responseUrl, { replace_original: true, response_type: "ephemeral", text, ...(blocks ? { blocks } : {}) });
  }

  /** Ephemeral note to whoever clicked; the original message (and its buttons) stays. */
  async ephemeral(responseUrl: string | undefined, text: string): Promise<boolean> {
    return this.respond(responseUrl, { replace_original: false, response_type: "ephemeral", text });
  }
}
