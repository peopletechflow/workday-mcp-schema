import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { isSensitiveKey, normalizeKey, scrubSensitiveText } from "./redact.js";

export { isSensitiveKey, scrubSensitiveText } from "./redact.js";

export type AuditEntry = {
  ts: string;
  userId: string;
  tool: string;
  inputs: unknown;
  result: "ok" | "error" | "denied" | "unknown";
  workdayEventId?: string | undefined;
  latencyMs: number;
  errorMessage?: string | undefined;
};

/** Deep-redact known PII / secret keys; hash long opaque IDs lightly for correlation. */
export function redactPii(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redactPii(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k)) {
        out[k] = "[REDACTED]";
      } else if (normalizeKey(k) === "value" && typeof v === "string" && v.length > 24) {
        out[k] = `[hash:${createHash("sha256").update(v).digest("hex").slice(0, 12)}]`;
      } else if (typeof v === "string") {
        out[k] = scrubSensitiveText(v);
      } else {
        out[k] = redactPii(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export class AuditLogger {
  constructor(private readonly path: string) {}

  async log(entry: AuditEntry): Promise<void> {
    const safe: AuditEntry = {
      ...entry,
      inputs: redactPii(entry.inputs),
      errorMessage: entry.errorMessage ? scrubSensitiveText(entry.errorMessage) : undefined,
    };
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await appendFile(this.path, `${JSON.stringify(safe)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch (err) {
      // Never let an audit write failure turn a finished Workday call into a tool error.
      // stderr only (stdout is the MCP channel); no entry content is printed.
      process.stderr.write(
        `${JSON.stringify({ src: "audit", evt: "write_failed", tool: entry.tool, err: (err as NodeJS.ErrnoException).code ?? "error" })}\n`,
      );
    }
  }
}
