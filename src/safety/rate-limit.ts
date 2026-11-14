/**
 * Per-user, per-tool sliding window. Keys stay in memory and are never logged.
 * Write actions use a tighter default than reads.
 */
export type RateLimitKind = "read" | "write";

export type RateLimitSettings = {
  readLimit: number;
  writeLimit: number;
  windowMs: number;
};

export const DEFAULT_RATE_LIMIT: RateLimitSettings = {
  readLimit: 60,
  writeLimit: 10,
  windowMs: 60_000,
};

export class RateLimitError extends Error {
  constructor(
    readonly tool: string,
    readonly retryAfterMs: number,
  ) {
    super(`Rate limit exceeded for this tool. Retry after ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s.`);
    this.name = "RateLimitError";
  }
}

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly settings: RateLimitSettings = DEFAULT_RATE_LIMIT) {}

  consume(userId: string, tool: string, kind: RateLimitKind, now = Date.now()): void {
    const limit = kind === "write" ? this.settings.writeLimit : this.settings.readLimit;
    const key = `${userId}::${tool}`;
    const windowStart = now - this.settings.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((ts) => ts > windowStart);
    if (recent.length >= limit) {
      const oldest = recent[0] ?? now;
      throw new RateLimitError(tool, oldest + this.settings.windowMs - now);
    }
    recent.push(now);
    this.hits.set(key, recent);
  }
}
