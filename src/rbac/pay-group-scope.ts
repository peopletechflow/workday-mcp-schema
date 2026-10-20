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
 *
 * Worker targets (payslips): verifyWorkerInPayGroupScope() mints a WorkerPayGroupProof when the
 * worker's pay group(s) intersect the pay groups listed in the session. Same caller + session,
 * same TTL, module-minted only. The worker's pay group lookup is injected by caller code (no
 * native tool in the tenant returns another worker's pay group).
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

export type WorkerPayGroupProof = {
  readonly callerWid: string;
  readonly sessionId: string;
  readonly workerWid: string;
  /** The listed pay group (or pay group detail) that made the worker eligible. */
  readonly viaPayGroupId: string;
  readonly expiresAt: number;
};

const WORKER_PROOFS = new WeakSet<WorkerPayGroupProof>();

/**
 * Mint a per-worker proof: the worker's pay group IDs (from caller code) must include one listed
 * in this session. Throws PayGroupScopeError (refuse) otherwise.
 */
export async function verifyWorkerInPayGroupScope(
  session: PayGroupSession,
  workerWid: string,
  listWorkerPayGroupIds: (workerWid: string) => Promise<string[]>,
  now: number = Date.now(),
): Promise<WorkerPayGroupProof> {
  const set = LISTED.get(session);
  if (!set || session.expiresAt < now) throw new PayGroupScopeError("Pay group session is not valid or has expired; list pay groups again.");
  const w = workerWid?.trim();
  if (!w || w === "me") throw new PayGroupScopeError("workerWid must be a resolved worker WID.");
  const via = (await listWorkerPayGroupIds(w)).map((x) => x?.trim()).find((x) => !!x && set.has(x));
  if (!via) throw new PayGroupScopeError(`Worker ${w} is not in a pay group you can view.`);
  const proof: WorkerPayGroupProof = Object.freeze({
    callerWid: session.callerWid,
    sessionId: session.sessionId,
    workerWid: w,
    viaPayGroupId: via,
    expiresAt: session.expiresAt,
  });
  WORKER_PROOFS.add(proof);
  return proof;
}

export function isWorkerInPayGroupScope(
  proof: WorkerPayGroupProof | undefined,
  workerWid: string | undefined,
  callerWid: string | undefined,
  sessionId: string | undefined,
  now: number = Date.now(),
): boolean {
  return (
    !!proof && WORKER_PROOFS.has(proof) && !!workerWid && proof.workerWid === workerWid.trim() &&
    !!callerWid && proof.callerWid === callerWid && !!sessionId && proof.sessionId === sessionId && proof.expiresAt >= now
  );
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
