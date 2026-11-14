/** Structured JSON logs to stderr. Nested objects use the same key predicate as the audit log. */
import { isSensitiveKey, scrubSensitiveText } from "../safety/redact.js";

export type LogFn = (fields: Record<string, unknown>) => void;

export function redactFields(fields: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = redactLogValue(k, v, depth);
  return out;
}

function redactLogValue(key: string, value: unknown, depth: number): unknown {
  if (isSensitiveKey(key)) return "[redacted]";
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return scrubSensitiveText(value).slice(0, 200);
  if (Array.isArray(value)) return value.map((item) => redactLogValue("", item, depth + 1));
  if (value !== null && typeof value === "object") return redactFields(value as Record<string, unknown>, depth + 1);
  return value;
}

export function createLogger(
  base: Record<string, unknown> = {},
  sink: (line: string) => void = (l) => process.stderr.write(l + "\n"),
): LogFn {
  return (fields) => sink(JSON.stringify({ ts: new Date().toISOString(), ...base, ...redactFields(fields) }));
}
