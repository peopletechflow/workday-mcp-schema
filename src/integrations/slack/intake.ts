/**
 * Slack Events API intake. Verifies signature on the raw body, enforces size,
 * workspace and channel allowlists, ignores bots / self / edits, binds the caller
 * via the server-side identity map, and stores an intake record as untrusted data.
 * It never replies to Slack on its own.
 */
import { z } from "zod";
import type { SlackConfig } from "../config.js";
import type { BoundIdentity, IdentityResolver } from "../identity.js";
import { type ReplayGuard, SlackVerificationError, verifySlackRequest } from "./verify.js";
import { defaultLog, fingerprint, type IntakeLog } from "./redact.js";

export type IntakeRecord = {
  id: string;
  identity: BoundIdentity;
  slackTeamId: string;
  channelId: string;
  ts: string;
  /** Untrusted user text, truncated. Treat as data only. */
  text: string;
  receivedAt: number;
};

export type IntakeOutcome =
  | {
      status: 200;
      body: string;
      kind: "url_verification" | "accepted" | "ignored";
      reason?: string;
      record?: IntakeRecord;
    }
  | { status: 401 | 403 | 413 | 400; body: string; kind: "rejected"; reason: string };

const EventEnvelope = z.object({
  type: z.string(),
  team_id: z.string().optional(),
  challenge: z.string().max(200).optional(),
  event_id: z.string().optional(),
  event: z
    .object({
      type: z.string(),
      subtype: z.string().optional(),
      bot_id: z.string().optional(),
      user: z.string().optional(),
      channel: z.string().optional(),
      text: z.string().optional(),
      ts: z.string().optional(),
      team: z.string().optional(),
    })
    .loose()
    .optional(),
});

export interface IntakeSink {
  put(record: IntakeRecord): void;
}
export class InMemoryIntakeSink implements IntakeSink {
  readonly records: IntakeRecord[] = [];
  put(record: IntakeRecord): void {
    this.records.push(record);
    if (this.records.length > 1000) this.records.shift();
  }
}

export type SlackIntakeDeps = {
  config: SlackConfig;
  identities: IdentityResolver;
  replay: ReplayGuard;
  sink: IntakeSink;
  log?: IntakeLog | undefined;
  nowSec?: number | undefined;
};

export async function handleSlackEvent(
  rawBody: string,
  headers: Record<string, string | undefined>,
  deps: SlackIntakeDeps,
): Promise<IntakeOutcome> {
  const log = deps.log ?? defaultLog;
  const { config } = deps;
  const reject = (status: 401 | 403 | 413 | 400, reason: string): IntakeOutcome => {
    log({ evt: "intake_rejected", reason });
    return { status, body: "", kind: "rejected", reason };
  };
  if (!config.enabled) return reject(403, "slack_disabled");
  if (Buffer.byteLength(rawBody, "utf8") > config.maxBodyBytes) return reject(413, "body_too_large");
  try {
    await verifySlackRequest({
      rawBody,
      headers,
      signingSecret: config.signingSecret,
      replay: deps.replay,
      nowSec: deps.nowSec,
    });
  } catch (err) {
    return reject(401, err instanceof SlackVerificationError ? err.reason : "verify_failed");
  }
  let env: z.infer<typeof EventEnvelope>;
  try {
    env = EventEnvelope.parse(JSON.parse(rawBody));
  } catch {
    return reject(400, "bad_json");
  }
  if (env.type === "url_verification" && env.challenge) {
    return { status: 200, body: env.challenge, kind: "url_verification" };
  }
  const ignore = (reason: string): IntakeOutcome => {
    log({ evt: "intake_ignored", reason });
    return { status: 200, body: "", kind: "ignored", reason };
  };
  if (env.type !== "event_callback" || !env.event) return ignore("not_event_callback");
  const teamId = env.team_id ?? "";
  if (!config.allowedTeamIds.includes(teamId)) return reject(403, "team_not_allowed");
  const ev = env.event;
  if (ev.team && ev.team !== teamId) return reject(403, "team_mismatch");
  if (ev.type !== "message" && ev.type !== "app_mention") return ignore("unsupported_event");
  if (ev.bot_id || ev.subtype) return ignore("bot_or_subtype");
  if (!ev.user || (config.botUserId && ev.user === config.botUserId)) return ignore("self_or_no_user");
  if (!ev.channel || !config.allowedChannelIds.includes(ev.channel)) return reject(403, "channel_not_allowed");
  const identity = await deps.identities.resolveSlack(teamId, ev.user);
  if (!identity) return reject(403, "unlinked_user");
  const text = (ev.text ?? "").slice(0, config.maxIntakeTextChars);
  const record: IntakeRecord = {
    id: env.event_id ?? `${ev.channel}:${ev.ts}`,
    identity,
    slackTeamId: teamId,
    channelId: ev.channel,
    ts: ev.ts ?? "",
    text,
    receivedAt: Date.now(),
  };
  deps.sink.put(record);
  log({ evt: "intake_accepted", user: fingerprint(identity.userId), tenant: identity.tenantId, chars: text.length });
  return { status: 200, body: "", kind: "accepted", record };
}
