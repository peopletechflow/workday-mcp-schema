/**
 * Pay-group scope proof (payroll-viewer-skill).
 *
 * Rule (payroll-viewer-skill): "Do not attempt to retrieve a pay group or pay group detail whose
 * ID was supplied by the user but was not returned in a prior list — that is a scope violation
 * attempt." find_pay_groups / find_pay_group_details only return pay groups the caller may view
 * (Set Up: Payroll - Pay Group Specific), so an ID they returned is in scope; any other ID is not.
 *
 * openPayGroupSession() mints a PayGroupSession bound to the caller's WID and the conversation
 * session id. The IDs returned by find_pay_groups / find_pay_group_details are recorded on it with
 * recordListedPayGroups(); the set lives in a module-private WeakMap, so only this module can add
 * to it and a hand-built session object is never valid. assertAgentReadyScope() accepts a
 * payroll_viewer's pay group / pay group detail ID only when isPayGroupListed() is true for the
 * same caller and session, unexpired. admin is exempt (full read; scope "all").
 */
export const PAY_GROUP_SESSION_TTL_MS = 15 * 60 * 1000;

/** The only tools whose responses may add IDs to a session. */
export const PAY_GROUP_LISTING_TOOLS = ["find_pay_groups", "find_pay_group_details"] as const;
export type PayGroupListingTool = (typeof PAY_GROUP_LISTING_TOOLS)[number];

export type PayGroupSession = {
  readonly callerWid: string;
  readonly sessionId: string;
  readonly expiresAt: number;
};

export class PayGroupScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayGroupScopeError";
  }
}

/** session -> pay group and pay group detail IDs returned by a listing tool. Module-private. */
const LISTED = new WeakMap<PayGroupSession, Set<string>>();

export function openPayGroupSession(callerWid: string, sessionId: string, now: number = Date.now()): PayGroupSession {
  if (!callerWid?.trim() || callerWid.trim() === "me") throw new PayGroupScopeError("callerWid must be the caller's resolved WID, not 'me'.");
  if (!sessionId?.trim()) throw new PayGroupScopeError("sessionId is required.");
  const session: PayGroupSession = Object.freeze({ callerWid, sessionId, expiresAt: now + PAY_GROUP_SESSION_TTL_MS });
  LISTED.set(session, new Set());
  return session;
}

export function isValidPayGroupSession(
  session: PayGroupSession | undefined,
  callerWid: string | undefined,
  sessionId: string | undefined,
  now: number = Date.now(),
): session is PayGroupSession {
  return (
    !!session && LISTED.has(session) && session.expiresAt >= now &&
    !!callerWid && session.callerWid === callerWid && !!sessionId && session.sessionId === sessionId
  );
}

/**
 * Record the pay group / pay group detail IDs that find_pay_groups or find_pay_group_details
 * returned to this caller in this session. Any other tool is refused.
 */
export function recordListedPayGroups(
  session: PayGroupSession,
  tool: string,
  ids: Iterable<string>,
  now: number = Date.now(),
): void {
  if (!(PAY_GROUP_LISTING_TOOLS as readonly string[]).includes(tool)) {
    throw new PayGroupScopeError(`${tool} cannot add pay groups to the scope; only ${PAY_GROUP_LISTING_TOOLS.join(" / ")} can.`);
  }
  const set = LISTED.get(session);
  if (!set || session.expiresAt < now) throw new PayGroupScopeError("Pay group session is not valid or has expired; list pay groups again.");
  for (const id of ids) if (id?.trim() && id.trim() !== "me") set.add(id.trim());
}

/** True only when `id` was returned by an earlier listing call for the same caller and session. */
export function isPayGroupListed(
  session: PayGroupSession | undefined,
  id: string | undefined,
  callerWid: string | undefined,
  sessionId: string | undefined,
  now: number = Date.now(),
): boolean {
  const v = id?.trim();
  return !!v && isValidPayGroupSession(session, callerWid, sessionId, now) && LISTED.get(session)!.has(v);
}
