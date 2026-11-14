/**
 * Sensitive field gate (admin-skill Rule 5).
 *
 * "Do not display national IDs, bank account details, or passport numbers unless the user
 * explicitly asks for that specific field for a single named worker. When you do show the data,
 * prepend: '⚠️ Note: access to this field is logged by Workday.'"
 *
 * No equivalent response guard existed (src/safety/audit.ts redactPii only scrubs audit-log
 * inputs), so this module is new; it follows the same deep-walk-by-key approach.
 *   - default: every national ID / bank / passport field anywhere in the response is replaced
 *     with HIDDEN (keys stay, values never leave)
 *   - a field is shown only when the request is explicit, names exactly ONE category, and the
 *     response is about exactly ONE worker who is the named worker. Other categories stay hidden.
 *   - when a field is shown, the response carries LOGGED_ACCESS_NOTICE and an accessLog record
 *     that the caller must write to the audit log (AuditLogger).
 * Applies to any role's native-tool response (admin-skill reads in particular).
 */
export type SensitiveFieldCategory = "national_id" | "bank_account" | "passport";

export const SENSITIVE_FIELD_PATTERNS: Readonly<Record<SensitiveFieldCategory, RegExp>> = {
  national_id:
    /national.?id|national.?identifier|government.?id|ssn|social.?security|tax.?id|\btin\b|\bsin\b|\bbsn\b|\bnino\b/i,
  bank_account: /bank|iban|account.?number|routing|swift|\bbic\b|sort.?code|payment.?election/i,
  // visa numbers are hidden with passports (same identity-document class)
  passport: /passport|visa/i,
};

export const HIDDEN = "[hidden: sensitive field]";
export const LOGGED_ACCESS_NOTICE = "⚠️ Note: access to this field is logged by Workday.";

export type SensitiveFieldRequest = {
  /** The single field category the user explicitly asked for in this request. */
  explicitField?: SensitiveFieldCategory;
  /** The single worker the user named (WID; resolved, never "me"-ambiguous). */
  namedWorkerId?: string;
};

export type GatedResponse<T> = {
  data: T;
  /** Prepend to the answer whenever a sensitive field is shown. */
  notice: string | null;
  hiddenCategories: SensitiveFieldCategory[];
  /** Write this to the audit log when present. */
  accessLog: { category: SensitiveFieldCategory; workerId: string } | null;
};

export function categoryOfKey(key: string): SensitiveFieldCategory | null {
  for (const [c, re] of Object.entries(SENSITIVE_FIELD_PATTERNS) as [SensitiveFieldCategory, RegExp][]) {
    if (re.test(key)) return c;
  }
  return null;
}

function walk(
  value: unknown,
  show: SensitiveFieldCategory | null,
  found: Set<SensitiveFieldCategory>,
  depth: number,
): unknown {
  if (depth > 12) return HIDDEN; // fail closed on very deep payloads
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => walk(v, show, found, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const c = categoryOfKey(k);
    if (c) {
      found.add(c);
      out[k] = c === show ? walk(v, show, found, depth + 1) : HIDDEN;
    } else {
      out[k] = walk(v, show, found, depth + 1);
    }
  }
  return out;
}

/**
 * Gate a response. `subjectWorkerIds` = the distinct workers whose data the response holds
 * (resolved by caller code from the request/response).
 */
export function gateSensitiveFields<T>(
  data: T,
  subjectWorkerIds: readonly string[],
  request: SensitiveFieldRequest = {},
): GatedResponse<T> {
  const subjects = [...new Set(subjectWorkerIds.map((s) => s.trim()).filter(Boolean))];
  const named = request.namedWorkerId?.trim();
  const show: SensitiveFieldCategory | null =
    request.explicitField && named && named !== "me" && subjects.length === 1 && subjects[0] === named
      ? request.explicitField
      : null;
  const found = new Set<SensitiveFieldCategory>();
  const gated = walk(data, show, found, 0) as T;
  const shown = show !== null && found.has(show);
  return {
    data: gated,
    notice: shown ? LOGGED_ACCESS_NOTICE : null,
    hiddenCategories: [...found].filter((c) => c !== show || !shown).sort(),
    accessLog: shown && show && named ? { category: show, workerId: named } : null,
  };
}
