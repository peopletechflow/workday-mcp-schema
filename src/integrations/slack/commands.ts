/**
 * Signed slash command and global shortcut handlers.
 *
 *   /workday            or  /workday timeoff   -> open the time-off modal (views.open with trigger_id)
 *   /workday submit <apr_id>                   -> commit an approved request (requester only)
 *   /workday status <apr_id>                   -> status for requester or assigned approver
 *
 * Replies are only the HTTP acknowledgement body (ephemeral to the invoking user). Nothing is
 * posted to channels. Slack requires an ack within 3 s and trigger_id expires after 3 s, so
 * views.open and commit run with a 2.5 s budget before the ack is returned.
 */
import { z } from "zod";
import type { SlackConfig } from "../config.js";
import type { IdentityResolver } from "../identity.js";
import { ApprovalError } from "../approvals/workflow.js";
import type { ApprovalExecutionService } from "../approvals/execution.js";
import { RbacDeniedError } from "../../rbac/enforce.js";
import { type ReplayGuard, SlackVerificationError, verifySlackRequest } from "./verify.js";
import { type FormSessions, startTimeOffForm } from "./forms.js";
import { withinBudget, type SlackApi } from "./api.js";
import { defaultLog, fingerprint, type IntakeLog } from "./redact.js";

export const TIME_OFF_SHORTCUT_ID = "wd_time_off_shortcut";
export const ACK_BUDGET_MS = 2500;

export type CommandDeps = {
  config: SlackConfig;
  identities: IdentityResolver;
  replay: ReplayGuard;
  sessions: FormSessions;
  service: ApprovalExecutionService;
  slackApi?: SlackApi;
  /** Account linking (durable runtime). Absent means linking is not offered. */
  link?: { start(slackTeamId: string, slackUserId: string): Promise<string | undefined> };
  commandName: string;
  nowSec?: number;
  budgetMs?: number;
  log?: IntakeLog;
};

export type CommandAck = { status: 200 | 400 | 401 | 403; body: { response_type: "ephemeral"; text: string } | "" ; reason?: string };

const ephemeral = (text: string): CommandAck => ({ status: 200, body: { response_type: "ephemeral", text } });

const CommandSchema = z.object({
  team_id: z.string().min(1),
  user_id: z.string().min(1),
  channel_id: z.string().min(1),
  command: z.string().min(1),
  text: z.string().max(200).default(""),
  trigger_id: z.string().min(1).max(200),
});

const APR_ID = /^apr_[A-Za-z0-9_-]{16,64}$/;

async function openForm(deps: CommandDeps, teamId: string, userId: string, triggerId: string): Promise<string> {
  if (!deps.slackApi) return "Forms are not configured (no Slack API client).";
  const view = await startTimeOffForm(deps, teamId, userId);
  const res = await withinBudget(deps.slackApi.viewsOpen(triggerId, view), deps.budgetMs ?? ACK_BUDGET_MS);
  if (!res.done) return "Slack did not open the form in time. Please try again.";
  return res.value.ok ? "" : "Could not open the form. Please try again.";
}

export async function handleSlashCommand(rawBody: string, headers: Record<string, string | undefined>, deps: CommandDeps): Promise<CommandAck> {
  const log = deps.log ?? defaultLog;
  const deny = (status: 400 | 401 | 403, reason: string): CommandAck => {
    log({ evt: "command_rejected", reason });
    return { status, body: "", reason };
  };
  if (!deps.config.enabled) return deny(403, "slack_disabled");
  if (Buffer.byteLength(rawBody) > deps.config.maxBodyBytes) return deny(400, "body_too_large");
  try {
    await verifySlackRequest({ rawBody, headers, signingSecret: deps.config.signingSecret, replay: deps.replay, nowSec: deps.nowSec });
  } catch (e) {
    return deny(401, e instanceof SlackVerificationError ? e.reason : "verify_failed");
  }
  const parsed = CommandSchema.safeParse(Object.fromEntries(new URLSearchParams(rawBody)));
  if (!parsed.success) return deny(400, "bad_command");
  const c = parsed.data;
  if (c.command !== deps.commandName) return deny(400, "unknown_command");
  if (!deps.config.allowedTeamIds.includes(c.team_id)) return deny(403, "team_not_allowed");
  if (!deps.config.allowedChannelIds.includes(c.channel_id)) return deny(403, "channel_not_allowed");
  if (c.text.trim() === "link") {
    if (!deps.link) return ephemeral("Account linking is not configured.");
    const url = await deps.link.start(c.team_id, c.user_id);
    if (!url) return ephemeral("You have not been invited to link a Workday account. Ask an administrator.");
    log({ evt: "link_started" });
    return ephemeral(`Sign in to Workday to link your account (expires in 10 minutes): ${url}`);
  }
  const identity = await deps.identities.resolveSlack(c.team_id, c.user_id);
  if (!identity) return ephemeral(`Your Slack account is not linked. Run \`${deps.commandName} link\` if an administrator invited you.`);

  const [sub = "", arg = "", ...rest] = c.text.trim().split(/\s+/).filter(Boolean);
  log({ evt: "command", sub: sub || "timeoff", user: fingerprint(identity.userId) });
  try {
    if ((sub === "" || sub === "timeoff") && !arg) {
      const msg = await openForm(deps, c.team_id, c.user_id, c.trigger_id);
      return msg ? ephemeral(msg) : { status: 200, body: "" };
    }
    if ((sub === "submit" || sub === "status") && APR_ID.test(arg) && rest.length === 0) {
      if (sub === "status") {
        const s = await deps.service.status(identity, arg);
        return ephemeral(`Request ${arg}: ${s.status}. ${s.summary}`);
      }
      // Deterministic key: Slack retries of the same submit do not double-commit.
      const run = deps.service.commitApproved(identity, arg, `slack-submit-${arg}`);
      run.catch((e: unknown) => log({ evt: "commit_failed", code: e instanceof ApprovalError ? e.code : e instanceof RbacDeniedError ? "rbac" : "error" }));
      const res = await withinBudget(run, deps.budgetMs ?? ACK_BUDGET_MS);
      if (!res.done) return ephemeral(`Submitting ${arg} to Workday. Check with \`${deps.commandName} status ${arg}\`.`);
      const body = res.value as { request?: { workdayEventId?: string; status?: string } };
      return ephemeral(`Submitted to Workday (${body.request?.status ?? "ok"}, event ${body.request?.workdayEventId ?? "n/a"}).`);
    }
    return ephemeral(`Usage: \`${deps.commandName}\` (time off form), \`${deps.commandName} submit apr_...\`, \`${deps.commandName} status apr_...\``);
  } catch (e) {
    if (e instanceof ApprovalError) return ephemeral(`Not done: ${e.code}.`);
    if (e instanceof RbacDeniedError) return ephemeral("Not done: permission denied.");
    log({ evt: "command_error" });
    return ephemeral("Not done: internal error.");
  }
}

const ShortcutSchema = z.object({
  type: z.literal("shortcut"),
  callback_id: z.string(),
  trigger_id: z.string().min(1).max(200),
  team: z.object({ id: z.string() }),
  user: z.object({ id: z.string() }),
});

/** Global shortcut via the interactivity endpoint (signed, allowlisted, mapped caller). */
export async function handleShortcut(rawBody: string, headers: Record<string, string | undefined>, deps: CommandDeps): Promise<{ status: 200 | 400 | 401 | 403; reason?: string }> {
  if (!deps.config.enabled) return { status: 403, reason: "slack_disabled" };
  if (Buffer.byteLength(rawBody) > deps.config.maxBodyBytes) return { status: 400, reason: "body_too_large" };
  try {
    await verifySlackRequest({ rawBody, headers, signingSecret: deps.config.signingSecret, replay: deps.replay, nowSec: deps.nowSec });
  } catch (e) {
    return { status: 401, reason: e instanceof SlackVerificationError ? e.reason : "verify_failed" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new URLSearchParams(rawBody).get("payload") ?? "");
  } catch {
    return { status: 400, reason: "bad_payload" };
  }
  const p = ShortcutSchema.safeParse(payload);
  if (!p.success || p.data.callback_id !== TIME_OFF_SHORTCUT_ID) return { status: 400, reason: "bad_shortcut" };
  if (!deps.config.allowedTeamIds.includes(p.data.team.id)) return { status: 403, reason: "team_not_allowed" };
  if (!(await deps.identities.resolveSlack(p.data.team.id, p.data.user.id))) return { status: 403, reason: "unlinked_user" };
  const msg = await openForm(deps, p.data.team.id, p.data.user.id, p.data.trigger_id);
  return msg ? { status: 200, reason: msg } : { status: 200 };
}
