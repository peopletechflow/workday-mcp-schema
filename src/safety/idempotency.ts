export type IdempotentResult = {
  status: "ok" | "error";
  body: unknown;
  workdayEventId?: string;
  createdAt: string;
};

/**
 * In-memory idempotency store. Replace with durable storage before production.
 * Returns the stored result on retry so commits never double-submit.
 */
export class IdempotencyStore {
  private readonly map = new Map<string, IdempotentResult>();

  key(userId: string, tool: string, idempotencyKey: string): string {
    return `${userId}::${tool}::${idempotencyKey}`;
  }

  get(userId: string, tool: string, idempotencyKey: string): IdempotentResult | undefined {
    return this.map.get(this.key(userId, tool, idempotencyKey));
  }

  set(
    userId: string,
    tool: string,
    idempotencyKey: string,
    result: Omit<IdempotentResult, "createdAt">,
  ): IdempotentResult {
    const stored: IdempotentResult = { ...result, createdAt: new Date().toISOString() };
    this.map.set(this.key(userId, tool, idempotencyKey), stored);
    return stored;
  }
}
