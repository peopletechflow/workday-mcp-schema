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
import type { BoundIdentity, IdentityResolver, SlackAddress } from "../identity.js";
import type { ApprovalRequest } from "../approvals/workflow.js";
import { slackErrorMessage } from "./errors.js";
import type { ApprovalExecutionService } from "../approvals/execution.js";
import { type ReplayGuard, SlackVerificationError, verifySlackRequest } from "./verify.js";
import type { Queryable } from "../../store/db.js";
import { ApprovalError } from "../approvals/workflow.js";
import { withinBudget } from "./api.js";

export const TIME_OFF_CALLBACK_ID = "wd_time_off_request";

export type FormSession = { slackTeamId: string; slackUserId: string; identity: BoundIdentity; kind: string; expiresAt: number };

export interface FormSessions {
  open(s: Omit<FormSession, "expiresAt">, ttlMs: number): string | Promise<string>;
  peek(nonce: string): FormSession | undefined | Promise<FormSession | undefined>;
  /**
   * Single use. With `q` (durable store) the delete runs in the caller's transaction, so it is
   * rolled back if creating the approval fails. The in-memory store ignores `q`.
   */
  consume(nonce: string, q?: Queryable): boolean | Promise<boolean>;
}

export class FormSessionStore implements FormSessions {
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
      { type: "input", block_id: "days", label: { type: "plain_text", text: "Days" }, hint: { type: "plain_text", text: "Count every calendar day in the range, weekends included (or half of that for half days)." }, element: { type: "number_input", action_id: "v", is_decimal_allowed: true, min_value: "0.5", max_value: "30" } },
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
    state: z.object({ values: z.record(z.string(), z.record(z.string(), z.record(z.string(), z.unknown()))) }),
  }),
});

function readValue(values: Record<string, Record<string, Record<string, unknown>>>, block: string): unknown {
  const el = values[block]?.v;
  if (!el) return undefined;
  return el.selected_date ?? (el.selected_option as { value?: string } | undefined)?.value ?? el.value ?? undefined;
}

export type FormOutcome =
  | {
      status: 200;
      body: Record<string, unknown> | "";
      approval?: ApprovalRequest;
      /** Verified submitter, for notifications. */
      slackUser?: SlackAddress;
      /** True when processing outran the ack budget and continues in the background. */
      deferred?: boolean;
      reason?: string;
    }
  | { status: 400 | 401 | 403; body: ""; reason: string };

export type FormDeps = {
  config: SlackConfig;
  identities: IdentityResolver;
  replay: ReplayGuard;
  sessions: FormSessions;
  service: ApprovalExecutionService;
  /** Slash command name, used in "run /workday link" hints. */
  commandName?: string;
  nowSec?: number;
  /**
   * Ack deadline for creating the approval. When set together with `defer`, a slower database
   * makes the handler ack with a "submitting" view and finish in the background; `onLate`
   * receives the outcome (approval or error text) so it is never lost.
   */
  budgetMs?: number;
  defer?: (label: string, task: () => Promise<unknown>, fields?: Record<string, unknown>) => boolean;
  onLate?: (outcome: { approval: ApprovalRequest } | { errorText: string }, slackUser: SlackAddress) => Promise<unknown>;
  log?: (fields: Record<string, unknown>) => void;
};

export const FORM_USED_TEXT = "This form was already submitted. Check your Slack DMs or run the status command for the request id.";

/** View shown when the request is still being created after the ack deadline. */
export function buildSubmittingView(): Record<string, unknown> {
  return {
    type: "modal",
    title: { type: "plain_text", text: "Time off request" },
    close: { type: "plain_text", text: "Close" },
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "Submitting your request. You will get a Slack message with the result and request id." } }],
  };
}

/** Slack sends interactivity as application/x-www-form-urlencoded with a `payload` field. */
export async function handleViewSubmission(rawBody: string, headers: Record<string, string | undefined>, deps: FormDeps): Promise<FormOutcome> {
  const deny = (status: 400 | 401 | 403, reason: string): FormOutcome => ({ status, body: "", reason });
  if (!deps.config.enabled) return deny(403, "slack_disabled");
  if (Buffer.byteLength(rawBody) > deps.config.maxBodyBytes) return deny(400, "body_too_large");
  try {
    await verifySlackRequest({ rawBody, headers, signingSecret: deps.config.signingSecret, replay: deps.replay, nowSec: deps.nowSec });
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
  const session = await deps.sessions.peek(p.view.private_metadata);
  if (!session) return deny(403, "form_expired_or_unknown");
  if (session.slackTeamId !== p.team.id || session.slackUserId !== p.user.id || session.kind !== TIME_OFF_CALLBACK_ID) {
    return deny(403, "form_owner_mismatch");
  }
  const identity = await deps.identities.resolveSlack(p.team.id, p.user.id);
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
  const commandName = deps.commandName ?? "/workday";
  const slackUser: SlackAddress = { teamId: p.team.id, userId: p.user.id };
  const nonce = p.view.private_metadata;
  const fieldError = (e: unknown): FormOutcome | undefined => {
    if (e instanceof ApprovalError && e.code === "FORM_USED") {
      return { status: 200, body: { response_action: "errors", errors: { start: FORM_USED_TEXT.slice(0, 150) } }, reason: "form_already_used" };
    }
    const m = slackErrorMessage(e, commandName);
    return m ? { status: 200, body: { response_action: "errors", errors: { [m.field]: m.text.slice(0, 150) } } } : undefined;
  };
  // Checks (permissions, link, day count) run before the claim; the form nonce is consumed in
  // the same transaction that creates the approval. Any failure leaves the form usable, and a
  // second submit of the same form cannot create a second approval.
  type Done = { ok: true; approval: ApprovalRequest } | { ok: false; error: unknown };
  const work: Promise<Done> = deps.service
    .proposeTimeOff(identity, f, "slack_form", { claim: async (q) => Boolean(await deps.sessions.consume(nonce, q)) })
    .then((approval) => ({ ok: true as const, approval }), (error: unknown) => ({ ok: false as const, error }));
  const settle = (d: Done): FormOutcome => {
    if (d.ok) return { status: 200, body: { response_action: "clear" }, approval: d.approval, slackUser };
    const out = fieldError(d.error);
    if (out) return out;
    throw d.error;
  };
  if (deps.budgetMs === undefined || !deps.defer) return settle(await work);
  const res = await withinBudget(work, deps.budgetMs);
  if (res.done) return settle(res.value);
  // Too slow for the ack: hand the in-flight result to background delivery (bounded, drained
  // on shutdown). The approval itself is durable once the transaction commits.
  const late = async () => {
    const d = await work;
    if (d.ok) return deps.onLate?.({ approval: d.approval }, slackUser);
    const m = fieldError(d.error);
    deps.log?.({ evt: "form_late_error", code: d.error instanceof ApprovalError ? d.error.code : d.error instanceof Error ? d.error.name : "error" });
    const text = m && m.status === 200 && m.body !== "" ? Object.values((m.body as { errors: Record<string, string> }).errors)[0]! : "Your time-off request could not be created. Try again.";
    return deps.onLate?.({ errorText: text }, slackUser);
  };
  if (!deps.defer("form_late_outcome", late)) {
    // Background capacity exhausted: wait for the outcome rather than drop it.
    return settle(await work);
  }
  return { status: 200, body: { response_action: "update", view: buildSubmittingView() }, deferred: true, slackUser };
}

/**
 * Start a form for a verified Slack caller (for example from a signed slash command or
 * shortcut). Returns the view to pass to Slack views.open with the interaction trigger_id.
 */
export async function startTimeOffForm(deps: { config: SlackConfig; identities: IdentityResolver; sessions: FormSessions }, slackTeamId: string, slackUserId: string): Promise<Record<string, unknown>> {
  if (!deps.config.enabled) throw new Error("Slack disabled");
  if (!deps.config.allowedTeamIds.includes(slackTeamId)) throw new Error("team_not_allowed");
  const identity = await deps.identities.resolveSlack(slackTeamId, slackUserId);
  if (!identity) throw new Error("unlinked_user");
  const nonce = await deps.sessions.open({ slackTeamId, slackUserId, identity, kind: TIME_OFF_CALLBACK_ID }, deps.config.formTtlMs);
  return buildTimeOffModal(nonce);
}
