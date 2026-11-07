/**
 * Block Kit modal for a time-off request, plus a verified view_submission handler.
 *
 * private_metadata carries only an opaque random nonce. The server holds the binding
 * (Slack team+user, tenant, user, form kind, expiry) and consumes it once.
 * A valid submission creates an approval request (preview); it never commits.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { SlackConfig } from "../config.js";
import type { BoundIdentity, IdentityDirectory } from "../identity.js";
import type { ApprovalRequest, ApprovalWorkflow, RequesterAuthz } from "../approvals/workflow.js";
import { ReplayCache, SlackVerificationError, verifySlackRequest } from "./verify.js";

export const TIME_OFF_CALLBACK_ID = "wd_time_off_request";

type FormSession = { slackTeamId: string; slackUserId: string; identity: BoundIdentity; kind: string; expiresAt: number };

export class FormSessionStore {
  private readonly map = new Map<string, FormSession>();
  constructor(private readonly now: () => number = Date.now) {}
  open(s: Omit<FormSession, "expiresAt">, ttlMs: number): string {
    const nonce = randomBytes(18).toString("base64url");
    this.map.set(nonce, { ...s, expiresAt: this.now() + ttlMs });
    return nonce;
  }
  /** Read without consuming (validation errors keep the modal usable). Expired entries are removed. */
  peek(nonce: string): FormSession | undefined {
    const s = this.map.get(nonce);
    if (!s) return undefined;
    if (s.expiresAt < this.now()) {
      this.map.delete(nonce);
      return undefined;
    }
    return s;
  }
  /** Single use: consumed once a valid submission is accepted. */
  consume(nonce: string): boolean {
    return this.map.delete(nonce);
  }
}

const TIME_OFF_TYPES = ["vacation", "sick", "personal"] as const;

export function buildTimeOffModal(nonce: string): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: TIME_OFF_CALLBACK_ID,
    private_metadata: nonce,
    title: { type: "plain_text", text: "Request time off" },
    submit: { type: "plain_text", text: "Send for approval" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      { type: "input", block_id: "start", label: { type: "plain_text", text: "Start date" }, element: { type: "datepicker", action_id: "v" } },
      { type: "input", block_id: "end", label: { type: "plain_text", text: "End date" }, element: { type: "datepicker", action_id: "v" } },
      {
        type: "input",
        block_id: "type",
        label: { type: "plain_text", text: "Type" },
        element: { type: "static_select", action_id: "v", options: TIME_OFF_TYPES.map((t) => ({ text: { type: "plain_text", text: t }, value: t })) },
      },
      { type: "input", block_id: "days", label: { type: "plain_text", text: "Days" }, element: { type: "number_input", action_id: "v", is_decimal_allowed: true, min_value: "0.5", max_value: "30" } },
      { type: "input", block_id: "comment", optional: true, label: { type: "plain_text", text: "Comment" }, element: { type: "plain_text_input", action_id: "v", max_length: 300 } },
    ],
  };
}

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const TimeOffFormSchema = z
  .object({
    startDate: IsoDate,
    endDate: IsoDate,
    timeOffType: z.enum(TIME_OFF_TYPES),
    quantity: z.coerce.number().min(0.5).max(30).multipleOf(0.5),
    comment: z.string().max(300).optional(),
  })
  .refine((v) => v.endDate >= v.startDate, { message: "End date must be on or after start date", path: ["endDate"] });

const Payload = z.object({
  type: z.literal("view_submission"),
  team: z.object({ id: z.string() }),
  user: z.object({ id: z.string() }),
  view: z.object({
    callback_id: z.string(),
    private_metadata: z.string().max(64),
    state: z.object({ values: z.record(z.record(z.record(z.unknown()))) }),
  }),
});

function readValue(values: Record<string, Record<string, Record<string, unknown>>>, block: string): unknown {
  const el = values[block]?.v;
  if (!el) return undefined;
  return el.selected_date ?? (el.selected_option as { value?: string } | undefined)?.value ?? el.value ?? undefined;
}

export type FormOutcome =
  | { status: 200; body: Record<string, unknown> | ""; approval?: ApprovalRequest }
  | { status: 400 | 401 | 403; body: ""; reason: string };

export type FormDeps = {
  config: SlackConfig;
  identities: IdentityDirectory;
  replay: ReplayCache;
  sessions: FormSessionStore;
  workflow: ApprovalWorkflow;
  authzFor: (identity: BoundIdentity) => RequesterAuthz;
  nowSec?: number;
};

/** Slack sends interactivity as application/x-www-form-urlencoded with a `payload` field. */
export function handleViewSubmission(rawBody: string, headers: Record<string, string | undefined>, deps: FormDeps): FormOutcome {
  const deny = (status: 400 | 401 | 403, reason: string): FormOutcome => ({ status, body: "", reason });
  if (!deps.config.enabled) return deny(403, "slack_disabled");
  if (Buffer.byteLength(rawBody) > deps.config.maxBodyBytes) return deny(400, "body_too_large");
  try {
    verifySlackRequest({ rawBody, headers, signingSecret: deps.config.signingSecret, replay: deps.replay, nowSec: deps.nowSec });
  } catch (e) {
    return deny(401, e instanceof SlackVerificationError ? e.reason : "verify_failed");
  }
  let p: z.infer<typeof Payload>;
  try {
    p = Payload.parse(JSON.parse(new URLSearchParams(rawBody).get("payload") ?? ""));
  } catch {
    return deny(400, "bad_payload");
  }
  if (!deps.config.allowedTeamIds.includes(p.team.id)) return deny(403, "team_not_allowed");
  if (p.view.callback_id !== TIME_OFF_CALLBACK_ID) return deny(400, "unknown_form");
  const session = deps.sessions.peek(p.view.private_metadata);
  if (!session) return deny(403, "form_expired_or_unknown");
  if (session.slackTeamId !== p.team.id || session.slackUserId !== p.user.id || session.kind !== TIME_OFF_CALLBACK_ID) {
    return deny(403, "form_owner_mismatch");
  }
  const identity = deps.identities.resolveSlack(p.team.id, p.user.id);
  if (!identity || identity.tenantId !== session.identity.tenantId || identity.userId !== session.identity.userId) {
    return deny(403, "identity_changed");
  }
  const v = p.view.state.values;
  const parsed = TimeOffFormSchema.safeParse({
    startDate: readValue(v, "start"),
    endDate: readValue(v, "end"),
    timeOffType: readValue(v, "type"),
    quantity: readValue(v, "days"),
    comment: readValue(v, "comment") ?? undefined,
  });
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    const map: Record<string, string> = { startDate: "start", endDate: "end", timeOffType: "type", quantity: "days", comment: "comment" };
    for (const issue of parsed.error.issues) errors[map[String(issue.path[0])] ?? "start"] = issue.message.slice(0, 150);
    return { status: 200, body: { response_action: "errors", errors } };
  }
  const f = parsed.data;
  if (!deps.sessions.consume(p.view.private_metadata)) return deny(403, "form_already_used");
  const approval = deps.workflow.propose({
    requester: identity,
    authz: deps.authzFor(identity),
    commitTool: "commit_request_time_off",
    resource: `worker:${identity.userId}`,
    change: { kind: "request_time_off", ...f, unit: "DAYS" },
    summary: `Time off ${f.timeOffType} ${f.startDate} to ${f.endDate} (${f.quantity} days)`,
    source: "slack_form",
  });
  return { status: 200, body: { response_action: "clear" }, approval };
}

/**
 * Start a form for a verified Slack caller (for example from a signed slash command or
 * shortcut). Returns the view to pass to Slack views.open with the interaction trigger_id.
 */
export function startTimeOffForm(deps: { config: SlackConfig; identities: IdentityDirectory; sessions: FormSessionStore }, slackTeamId: string, slackUserId: string): Record<string, unknown> {
  if (!deps.config.enabled) throw new Error("Slack disabled");
  if (!deps.config.allowedTeamIds.includes(slackTeamId)) throw new Error("team_not_allowed");
  const identity = deps.identities.resolveSlack(slackTeamId, slackUserId);
  if (!identity) throw new Error("unlinked_user");
  const nonce = deps.sessions.open({ slackTeamId, slackUserId, identity, kind: TIME_OFF_CALLBACK_ID }, deps.config.formTtlMs);
  return buildTimeOffModal(nonce);
}
