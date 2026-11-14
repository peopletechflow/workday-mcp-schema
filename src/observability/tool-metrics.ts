/**
 * Per-tool counters. The sink is pluggable. The default sink keeps counts in
 * memory and writes a structured log line with no user id, token, or payload.
 */
import { createLogger, type LogFn } from "./log.js";

export type ToolMetricOutcome = "ok" | "error" | "denied" | "unknown";

export type ToolMetricEvent = {
  tool: string;
  action?: string;
  outcome: ToolMetricOutcome;
  latencyMs: number;
  errorCode?: string;
};

export interface ToolMetricsSink {
  record(event: ToolMetricEvent): void;
}

export type ToolMetricTotals = {
  calls: number;
  errors: number;
  denied: number;
  unknown: number;
  latencyMsTotal: number;
};

export class InMemoryToolMetrics implements ToolMetricsSink {
  readonly events: ToolMetricEvent[] = [];
  private readonly totals = new Map<string, ToolMetricTotals>();
  private readonly log: LogFn;

  constructor(log: LogFn = createLogger({ component: "tool-metrics" })) {
    this.log = log;
  }

  record(event: ToolMetricEvent): void {
    this.events.push(event);
    const key = event.action ? `${event.tool}:${event.action}` : event.tool;
    const row = this.totals.get(key) ?? { calls: 0, errors: 0, denied: 0, unknown: 0, latencyMsTotal: 0 };
    row.calls += 1;
    row.latencyMsTotal += event.latencyMs;
    if (event.outcome === "error") row.errors += 1;
    if (event.outcome === "denied") row.denied += 1;
    if (event.outcome === "unknown") row.unknown += 1;
    this.totals.set(key, row);
    this.log({
      evt: "tool.metric",
      tool: event.tool,
      ...(event.action ? { action: event.action } : {}),
      outcome: event.outcome,
      latencyMs: event.latencyMs,
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    });
  }

  snapshot(): ReadonlyMap<string, ToolMetricTotals> {
    return this.totals;
  }
}
