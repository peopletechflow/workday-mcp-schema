export type IdempotentStatus = "ok" | "error" | "unknown";

export type IdempotentResult = {
  status: IdempotentStatus;
  body: unknown;
  workdayEventId?: string | undefined;
  createdAt: string;
  /** Payload needed to reconcile an unknown write. Not a second submit. */
  subject?: unknown;
};

export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_IDEMPOTENCY_MAX_ENTRIES = 5_000;

export class IdempotencyCapacityError extends Error {
  constructor() {
    super("Idempotency store is full of unknown results. Reconcile them before new commits.");
    this.name = "IdempotencyCapacityError";
  }
}

export type IdempotencyOptions = {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
};

/**
 * In-memory idempotency store with a TTL and a size cap.
 * Unknown results are kept until reconciled: dropping them would allow a second submit.
 * Definitive ok and error rows expire and are evicted first when the cap is hit.
 */
export class IdempotencyStore {
  private readonly map = new Map<string, IdempotentResult>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: IdempotencyOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_IDEMPOTENCY_MAX_ENTRIES;
    this.now = opts.now ?? (() => Date.now());
  }

  key(userId: string, tool: string, idempotencyKey: string): string {
    return `${userId}::${tool}::${idempotencyKey}`;
  }

  get(userId: string, tool: string, idempotencyKey: string): IdempotentResult | undefined {
    this.purge();
    return this.map.get(this.key(userId, tool, idempotencyKey));
  }

  set(
    userId: string,
    tool: string,
    idempotencyKey: string,
    result: Omit<IdempotentResult, "createdAt">,
  ): IdempotentResult {
    this.purge();
    const id = this.key(userId, tool, idempotencyKey);
    if (!this.map.has(id) && this.map.size >= this.maxEntries) {
      if (!this.evictOldestDefinitive()) throw new IdempotencyCapacityError();
    }
    const stored: IdempotentResult = { ...result, createdAt: new Date(this.now()).toISOString() };
    this.map.set(id, stored);
    return stored;
  }

  /** Replace an unknown row after a read-only reconcile. */
  resolve(
    userId: string,
    tool: string,
    idempotencyKey: string,
    result: Omit<IdempotentResult, "createdAt">,
  ): IdempotentResult {
    const existing = this.get(userId, tool, idempotencyKey);
    if (!existing || existing.status !== "unknown") {
      throw new Error("Only an unknown idempotency record can be reconciled.");
    }
    return this.set(userId, tool, idempotencyKey, result);
  }

  size(): number {
    this.purge();
    return this.map.size;
  }

  private purge(): void {
    const now = this.now();
    for (const [key, value] of this.map) {
      if (value.status === "unknown") continue;
      if (now - Date.parse(value.createdAt) > this.ttlMs) this.map.delete(key);
    }
  }

  private evictOldestDefinitive(): boolean {
    let oldest: { key: string; createdAt: string } | undefined;
    for (const [key, value] of this.map) {
      if (value.status === "unknown") continue;
      if (!oldest || value.createdAt < oldest.createdAt) oldest = { key, createdAt: value.createdAt };
    }
    if (!oldest) return false;
    this.map.delete(oldest.key);
    return true;
  }
}
