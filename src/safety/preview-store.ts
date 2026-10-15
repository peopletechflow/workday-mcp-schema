import { randomBytes } from "node:crypto";

export type TimeOffPreviewPayload = {
  kind: "request_time_off";
  userId: string;
  startDate: string;
  endDate: string;
  unit: "HOURS" | "DAYS";
  quantity: number;
  timeOffType: { type: string; value: string };
  comment?: string;
  summary: string;
  expiresAt: number;
};

export type PreviewPayload = TimeOffPreviewPayload;

const DEFAULT_TTL_MS = 15 * 60 * 1000;

/**
 * Short-lived preview tokens. Commit tools require a valid, unexpired token
 * that matches the calling user — human-in-the-loop gate.
 */
export class PreviewStore {
  private readonly map = new Map<string, PreviewPayload>();

  create(payload: Omit<PreviewPayload, "expiresAt">, ttlMs = DEFAULT_TTL_MS): string {
    const token = randomBytes(24).toString("base64url");
    this.map.set(token, { ...payload, expiresAt: Date.now() + ttlMs });
    return token;
  }

  consume(token: string, userId: string, kind: PreviewPayload["kind"]): PreviewPayload {
    const payload = this.map.get(token);
    if (!payload) {
      throw new Error("Invalid or already-used preview token. Run the matching preview_* tool again.");
    }
    if (payload.expiresAt < Date.now()) {
      this.map.delete(token);
      throw new Error("Preview token expired. Run the matching preview_* tool again.");
    }
    if (payload.userId !== userId) {
      throw new Error("Preview token does not belong to the signed-in user.");
    }
    if (payload.kind !== kind) {
      throw new Error(`Preview token is for '${payload.kind}', not '${kind}'.`);
    }
    this.map.delete(token);
    return payload;
  }
}
