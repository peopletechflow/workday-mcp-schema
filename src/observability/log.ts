/** Structured JSON logs to stderr with key-based redaction. Never pass tokens, codes, or message text. */
const REDACT = /token|secret|password|authorization|code_verifier|^code$|cookie|email|text|comment/i;

export type LogFn = (fields: Record<string, unknown>) => void;

export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = REDACT.test(k) ? "[redacted]" : typeof v === "string" ? v.slice(0, 200) : v;
  return out;
}

export function createLogger(base: Record<string, unknown> = {}, sink: (line: string) => void = (l) => process.stderr.write(l + "\n")): LogFn {
  return (fields) => sink(JSON.stringify({ ts: new Date().toISOString(), ...base, ...redactFields(fields) }));
}
