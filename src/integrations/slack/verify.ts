/**
 * Slack request signing (v0) over the exact raw body, with timestamp window and
 * replay cache. https://api.slack.com/authentication/verifying-requests-from-slack
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export class SlackVerificationError extends Error {
  constructor(public readonly reason: string) {
    super(`Slack request rejected: ${reason}`);
    this.name = "SlackVerificationError";
  }
}

export const SLACK_MAX_SKEW_SECONDS = 300;

/** Bounded in-memory replay cache. Use a shared store (Redis etc.) when running more than one instance. */
export class ReplayCache {
  private readonly seen = new Map<string, number>();
  constructor(private readonly max = 10_000) {}
  checkAndRemember(key: string, nowSec: number): boolean {
    for (const [k, exp] of this.seen) {
      if (exp < nowSec) this.seen.delete(k);
      else break;
    }
    if (this.seen.has(key)) return false;
    if (this.seen.size >= this.max) {
      const first = this.seen.keys().next().value;
      if (first !== undefined) this.seen.delete(first);
    }
    this.seen.set(key, nowSec + SLACK_MAX_SKEW_SECONDS * 2);
    return true;
  }
}

export function computeSlackSignature(secret: string, timestamp: string, rawBody: string): string {
  return "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
}

export function verifySlackRequest(args: {
  rawBody: string;
  headers: Record<string, string | undefined>;
  signingSecret: string | undefined;
  replay: ReplayCache;
  nowSec?: number;
}): void {
  const { rawBody, headers, signingSecret, replay } = args;
  if (!signingSecret) throw new SlackVerificationError("signing secret not configured");
  const ts = headers["x-slack-request-timestamp"];
  const sig = headers["x-slack-signature"];
  if (!ts || !sig) throw new SlackVerificationError("missing signature headers");
  if (!/^\d{1,12}$/.test(ts)) throw new SlackVerificationError("bad timestamp");
  const now = args.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > SLACK_MAX_SKEW_SECONDS) throw new SlackVerificationError("stale timestamp");
  const expected = Buffer.from(computeSlackSignature(signingSecret, ts, rawBody));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new SlackVerificationError("bad signature");
  }
  if (!replay.checkAndRemember(`${ts}:${sig}`, now)) throw new SlackVerificationError("replayed request");
}
