/** Redacted, size-bounded log lines for Slack traffic. Never logs message text, tokens, or secrets. */
import { createHash } from "node:crypto";

export function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export type IntakeLog = (line: Record<string, unknown>) => void;
export const defaultLog: IntakeLog = (line) => process.stderr.write(`${JSON.stringify({ src: "slack", ...line })}\n`);
