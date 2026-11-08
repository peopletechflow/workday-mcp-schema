/**
 * Bounded post-acknowledgement work (Slack notifications, slow form outcomes).
 *
 * Slack needs its HTTP ack within 3 s; work that can run after the ack goes here instead of
 * delaying it. Every task has a timeout, the number in flight is capped (excess tasks are
 * refused and logged, never queued without limit), failures are logged, and `drain` lets the
 * server finish in-flight tasks on shutdown before the database pool closes.
 */
import type { LogFn } from "../observability/log.js";

export const BACKGROUND_TASK_TIMEOUT_MS = 20_000;
export const BACKGROUND_MAX_IN_FLIGHT = 200;

export class BackgroundTasks {
  private readonly inFlight = new Set<Promise<void>>();
  constructor(private readonly o: { log?: LogFn; timeoutMs?: number; maxInFlight?: number } = {}) {}

  get size(): number {
    return this.inFlight.size;
  }

  /** Start `fn` now without awaiting it. Returns false (and logs) when the cap is reached. */
  run(label: string, fn: () => Promise<unknown>, fields: Record<string, unknown> = {}): boolean {
    if (this.inFlight.size >= (this.o.maxInFlight ?? BACKGROUND_MAX_IN_FLIGHT)) {
      this.o.log?.({ evt: "background_refused", task: label, ...fields });
      return false;
    }
    const timeoutMs = this.o.timeoutMs ?? BACKGROUND_TASK_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const task: Promise<void> = Promise.race([Promise.resolve().then(fn).then(() => "done" as const), timeout])
      .then((r) => {
        if (r === "timeout") this.o.log?.({ evt: "background_timeout", task: label, ...fields });
      })
      .catch((e: unknown) => this.o.log?.({ evt: "background_failed", task: label, err: e instanceof Error ? e.name : "error", ...fields }))
      .finally(() => {
        if (timer) clearTimeout(timer);
        this.inFlight.delete(task);
      });
    this.inFlight.add(task);
    return true;
  }

  /** Wait for in-flight tasks (each is already bounded by its own timeout), up to `maxMs`. */
  async drain(maxMs = BACKGROUND_TASK_TIMEOUT_MS): Promise<number> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled([...this.inFlight]), new Promise((r) => (timer = setTimeout(r, maxMs)))]);
    if (timer) clearTimeout(timer);
    return this.inFlight.size;
  }
}
