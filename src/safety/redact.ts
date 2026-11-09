/**
 * Shared redaction for audit logs, stderr logs, and Workday fault text.
 * Keys are matched after lowercasing and stripping non-alphanumeric characters,
 * so preferredName and preferred_name are the same key.
 */
import { categoryOfKey } from "./sensitive-fields.js";

/** Normalized names the schemas mark as PII, secrets, or free text that may carry health detail. */
const PII_NORMALIZED = new Set([
  "email",
  "name",
  "fullname",
  "firstname",
  "lastname",
  "legalname",
  "preferredname",
  "displayname",
  "descriptor",
  "phone",
  "ssn",
  "nationalid",
  "dateofbirth",
  "dob",
  "birthdate",
  "hiredate",
  "terminationdate",
  "address",
  "homeaddress",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authorization",
  "password",
  "secret",
  "code",
  "codeverifier",
  "cookie",
  "text",
  "comment",
  "comments",
  "reason",
  "note",
  "notes",
  "grossamount",
  "netamount",
  "coveragelevel",
]);

export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** True when a field name is PII, a secret, or a national-id, bank, or passport pattern. */
export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (!normalized) return false;
  if (PII_NORMALIZED.has(normalized)) return true;
  if (normalized.includes("token") || normalized.includes("secret")) return true;
  return categoryOfKey(key) !== null;
}

/** Remove bearer tokens and email addresses from a string that is otherwise kept. */
export function scrubSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]");
}
