/**
 * Runtime-discovered Workday Agent-Ready MCP tools, behind code-defined capability ceilings.
 *
 * Workday's change policy: the tools are for AI agents only, names and schemas change without versioning, and
 * prompts must not be bound to tool names. Security policy is a separate matter. This project limits what Workday
 * tools can be reached, in two layers:
 * 1. Capability ceilings, defined in code per project (for example "goals.self.read"). Each has an access kind, the
 *    project role permission it requires (role denies apply), optional consent, and an enabled flag. Writes are
 *    disabled until a scoped adapter with a tenant-verified ownership contract exists. Operator policy can narrow this, never widen it.
 * 2. The operator tool policy (from ASOR review), which binds a discovered tool to one ceiling with a contract
 *    fingerprint. Runtime discovery decides whether that tool still exists with the same contract.
 * Schemas are analysed recursively. Person fields at any depth must be bound by the server, or the tool is refused.
 * Record-id inputs: no Workday contract states which output fields are records the caller owns, so ownership cannot
 * be proven from results. Any tool whose schema takes an id-like field (by name, any scalar type) or a free-form string
 * is unavailable. Model-supplied values are limited to enums, consts, dates, and non-id numbers or booleans.
 * Reads require the server's annotations readOnlyHint === true and destructiveHint !== true; missing annotations = unavailable.
 * The manager/HR/payroll and business-process decision name denials are defence in depth only.
 */
import { createHash } from "node:crypto";
import * as AjvNs from "ajv";
import { z } from "zod";
import { isSubjectArg, PROHIBITED_UPSTREAM_TOOLS, scrub, UpstreamToolError, UpstreamUnknownError, type Upstream, type UpstreamTool } from "./upstream.js";

type AjvCtor = new (o: object) => { compile(s: object): ((d: unknown) => boolean) & { errors?: unknown }; errorsText(e?: unknown): string };
const Ajv: AjvCtor = ((AjvNs as unknown as { default: { default?: AjvCtor } & AjvCtor }).default.default ?? (AjvNs as unknown as { default: AjvCtor }).default);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
/** Contract fingerprint of a discovered tool. Description excluded (Workday rewrites descriptions routinely). */
export function fingerprint(t: UpstreamTool): string {
  return createHash("sha256").update(JSON.stringify(canon({ name: t.name, inputSchema: t.inputSchema ?? null, outputSchema: t.outputSchema ?? null, annotations: t.annotations ?? null }))).digest("hex");
}

/** Code-defined upper bound for what a policy entry may do. */
export type Ceiling = {
  capability: string; access: "read" | "write"; permission: string; description: string;
  /** Off unless a scoped adapter with a tenant-verified ownership contract has been validated for this project. */
  enabled: boolean;
  /** Consent scope the caller must have granted (store consent), if any. */
  consent?: string;
  /** Only an explicitly authorised capability may use a tool annotated destructive. */
  allowDestructive?: boolean;
};

export const IDENTITY_CEILING: Ceiling = { capability: "identity.self", access: "read", permission: "-", description: "Resolve the signed-in worker", enabled: true };

const Binding = z.enum(["caller", "me", "true"]);
export const ToolPolicyFile = z.object({
  version: z.literal(2),
  approvedBy: z.string().min(1),
  approvedAt: z.string().min(1),
  tenantAlias: z.string().min(1),
  agentClientId: z.string().min(1),
  tools: z.array(z.object({
    name: z.string().min(1),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    /** One project capability ceiling. "identity.self" for the self-identity tool. */
    capability: z.string().min(1),
    /** Dot paths (e.g. "filter.worker") to every person field, and how the server fills it. */
    subject: z.record(z.string(), Binding).default({}),
    identity: z.object({
      /** Dot path; a segment ending in [] must be an array with exactly one element. No numeric indexes. */
      workerIdPath: z.string().regex(/^[A-Za-z_][\w]*(\[\])?(\.[A-Za-z_][\w]*(\[\])?)*$/),
      /** Who checked in the tenant that this tool returns only the signed-in worker for "me", and when. */
      attestedBy: z.string().min(1), attestedAt: z.string().min(1),
    }).strict().optional(),
    note: z.string().optional(),
  }).strict()).max(200).superRefine((ts, ctx) => {
    const seen = new Set<string>();
    for (const t of ts) { const k = norm(t.name); if (seen.has(k)) ctx.addIssue({ code: "custom", message: `duplicate tool name in policy: ${t.name}` }); seen.add(k); }
  }),
}).strict();

/** RFC 3339 full-date with real month lengths and leap years. */
export function isCalendarDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v); if (!m) return false;
  const y = +m[1]!, mo = +m[2]!, d = +m[3]!;
  if (mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
}
/** RFC 3339 date-time: real date, hour 00-23, minute/second 00-59, offset Z or +-HH:MM within +-23:59. */
export function isCalendarDateTime(v: string): boolean {
  const m = /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?([Zz]|[+-](\d{2}):(\d{2}))$/.exec(v); if (!m) return false;
  if (!isCalendarDate(m[1]!) || +m[2]! > 23 || +m[3]! > 59 || (m[4] !== undefined && +m[4] > 59)) return false;
  return m[6] === undefined || (+m[6] <= 23 && +m[7]! <= 59);
}
/** A field name that denotes a record or person reference, whatever its scalar type. */
export const isIdLike = (k: string) => /(id|ids|wid|wids|ref|refs|reference|references|key|keys|descriptor|token|uri|url)$/.test(norm(k));
/** Backup name denial for manager-side business-process decisions and HR changes (the ceilings and annotations are the real gates). */
const DECISION_VERB = "(approve|deny|sendback|advance|rescind|cancel|reassign|delegate|correct|reject|submitfor|skip)";
const DECISION_OBJ = "(businessprocess|eventstep|inboxtask|bpstep|step)";
const DENY_PATTERN = new RegExp(`${DECISION_VERB}.*${DECISION_OBJ}|${DECISION_OBJ}.*${DECISION_VERB}|initiate.*(changejob|termination|hire|compensation|performancereview|foremployee|forworker)|payroll|compensation`);
export const isDeniedName = (name: string) => PROHIBITED_UPSTREAM_TOOLS.map(norm).includes(norm(name)) || DENY_PATTERN.test(norm(name));
export type ToolPolicy = z.infer<typeof ToolPolicyFile>;
type Entry = ToolPolicy["tools"][number];

type Leaf = "free" | "opaque" | "id";
type Node = Record<string, unknown>;
/** Result of recursively analysing a tool's input schema. */
export type SchemaShape = { problems: string[]; subjectPaths: string[]; leaves: Map<string, Leaf> };

/** Recursively analyse a JSON schema: local $ref, properties, items, combinators. Refuses what it cannot reason about. */
export function analyzeSchema(root: Node): SchemaShape {
  const problems: string[] = []; const subjectPaths: string[] = []; const leaves = new Map<string, Leaf>();
  const deref = (n: Node, seen: Set<string>): Node | undefined => {
    let cur = n;
    while (typeof cur.$ref === "string") {
      const ref = cur.$ref;
      if (!ref.startsWith("#/")) { problems.push(`external $ref ${ref}`); return undefined; }
      if (seen.has(ref)) { problems.push(`recursive $ref ${ref}`); return undefined; }
      seen.add(ref);
      const target = ref.slice(2).split("/").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Node)[k.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined), root);
      if (!target || typeof target !== "object") { problems.push(`unresolved $ref ${ref}`); return undefined; }
      cur = target as Node;
    }
    return cur;
  };
  const walk = (raw: Node, path: string, ctx: { inArray: boolean; inUnion: boolean }, seen: Set<string>) => {
    seen = new Set(seen); const n = deref(raw, seen); if (!n) return; // seen now carries every $ref on this path
    if ("not" in n || "if" in n || "dependentSchemas" in n || "unevaluatedProperties" in n) problems.push(`${path || "(root)"}: unsupported keyword`);
    if (n.patternProperties) problems.push(`${path || "(root)"}: patternProperties`);
    if (n.additionalProperties && n.additionalProperties !== false) problems.push(`${path || "(root)"}: open additionalProperties`);
    for (const k of ["anyOf", "oneOf", "allOf"] as const) if (Array.isArray(n[k])) for (const b of n[k] as Node[]) walk(b, path, { ...ctx, inUnion: ctx.inUnion || k !== "allOf" }, seen);
    const props = n.properties as Record<string, Node> | undefined;
    if (props) for (const [k, v] of Object.entries(props)) {
      const p = path ? `${path}.${k}` : k;
      if (isSubjectArg(k)) {
        if (ctx.inArray || ctx.inUnion) problems.push(`${p}: person field inside an array or union cannot be bound safely`);
        subjectPaths.push(p);
        continue;
      }
      walk(v, p, ctx, seen);
    }
    if (n.items) {
      if (Array.isArray(n.items)) problems.push(`${path}: tuple items`);
      else walk(n.items as Node, `${path}[]`, { ...ctx, inArray: true }, seen);
    }
    if (!props && !n.items && !n.anyOf && !n.oneOf && !n.allOf && path) {
      const t = n.type; const free = t === "number" || t === "integer" || t === "boolean" || Array.isArray(n.enum) || "const" in n || (t === "string" && (n.format === "date" || n.format === "date-time"));
      const name = path.replace(/\[\]/g, "").split(".").at(-1)!;
      if (t === "object") problems.push(`${path}: object without declared properties`);
      else if (isIdLike(name) && !("const" in n)) { leaves.set(path, "id"); problems.push(`${path}: record-id input (ownership of ids cannot be proven; unavailable)`); }
      else if (!free) { leaves.set(path, "opaque"); problems.push(`${path}: free-form string input (could carry another person's id; unavailable)`); }
      else leaves.set(path, "free");
    }
  };
  walk(root, "", { inArray: false, inUnion: false }, new Set());
  return { problems, subjectPaths, leaves };
}

export type AgentToolStatus = { name: string; capability: string; status: "available" | "missing" | "drifted" | "refused"; reason?: string; description?: string; inputSchema?: unknown };

export class AgentToolRegistry {
  private live = new Map<string, UpstreamTool>();
  private fetchedAt = 0;
  private stale = true;
  private readonly ajv = new Ajv({ allErrors: false, strict: false });
  private readonly ceilings: Map<string, Ceiling>;
  /** Set after a token refresh; the next call re-reads identity first. */
  identityRecheck = false;
  private boundWorker?: string;
  constructor(private readonly up: Upstream, readonly policy: ToolPolicy, ceilings: readonly Ceiling[], private readonly opts: { ttlMs?: number; now?: () => number; onIdentityMismatch?: () => void } = {}) {
    this.ceilings = new Map([IDENTITY_CEILING, ...ceilings].map((c) => [c.capability, c]));
    up.onToolsChanged(() => { this.stale = true; });
  }
  ceiling(cap: string) { return this.ceilings.get(cap); }
  private now() { return (this.opts.now ?? Date.now)(); }
  async refresh(): Promise<void> { this.live = new Map((await this.up.listTools()).map((t) => [t.name, t])); this.fetchedAt = this.now(); this.stale = false; }
  async ensureFresh(force = false) { if (force || this.stale || this.now() - this.fetchedAt > (this.opts.ttlMs ?? 5 * 60_000)) await this.refresh(); }

  /** Why an entry is unusable, or undefined. Checks the ceiling, annotations and the recursive schema. */
  private problem(e: Entry, live?: UpstreamTool): string | undefined {
    if (isDeniedName(e.name)) return "manager/HR/payroll or business-process decision tool is never exposed";
    const c = this.ceilings.get(e.capability);
    if (!c) return `capability '${e.capability}' is not defined by this project`;
    if (!c.enabled) return `capability '${e.capability}' is disabled in this project (no validated scoped adapter)`;
    if (e.identity && e.capability !== "identity.self") return "identity binding outside identity.self";
    if (e.capability === "identity.self") {
      if (!e.identity) return "identity.self needs an attested identity binding";
      const vals = Object.values(e.subject);
      if (vals.length !== 1 || !(vals[0] === "me" || vals[0] === "true")) return "identity tool must be bound to exactly one self selector (\"me\" or true)";
    }
    if (!live) return undefined;
    const ann = live.annotations ?? {};
    if (c.access === "read" && !(ann.readOnlyHint === true && ann.destructiveHint !== true)) return "read capability needs the server to annotate the tool readOnlyHint: true and not destructive";
    if (ann.destructiveHint === true && !c.allowDestructive) return "destructive tool not authorised for this capability";
    const shape = analyzeSchema((live.inputSchema ?? {}) as Node);
    if (shape.problems.length) return `schema not safely understood: ${shape.problems.slice(0, 3).join("; ")}`;
    const unbound = shape.subjectPaths.filter((p) => !(p in e.subject));
    if (unbound.length) return `person field(s) without a server binding: ${unbound.join(",")}`;
    const extra = Object.keys(e.subject).filter((p) => !shape.subjectPaths.includes(p));
    if (extra.length) return `binding for unknown path(s): ${extra.join(",")}`;
    if (e.capability === "identity.self" && [...shape.leaves.keys()].length) return "identity tool must take no other inputs";
    if (Object.values(e.subject).includes("caller") && e.capability === "identity.self") return "identity cannot use the caller";
    return undefined;
  }

  statuses(): AgentToolStatus[] {
    return this.policy.tools.map((e) => {
      const t = this.live.get(e.name);
      const bad = this.problem(e, t);
      if (bad) return { name: e.name, capability: e.capability, status: "refused" as const, reason: bad };
      if (!t) return { name: e.name, capability: e.capability, status: "missing" as const, reason: "not in tools/list (renamed, removed, or not in this agent's ASOR registration); re-approve" };
      if (fingerprint(t) !== e.fingerprint) return { name: e.name, capability: e.capability, status: "drifted" as const, reason: "schema or annotations changed since approval; re-approve" };
      return { name: e.name, capability: e.capability, status: "available" as const, description: t.description, inputSchema: t.inputSchema };
    });
  }

  private entry(name: string, capability: string) {
    const e = this.policy.tools.find((x) => x.name === name);
    if (!e || e.capability !== capability) throw new UpstreamToolError(`'${name}' is not approved for ${capability}.`);
    const st = this.statuses().find((s) => s.name === name)!;
    if (st.status !== "available") throw new UpstreamToolError(`'${name}' is unavailable: ${st.reason}`);
    return { e, t: this.live.get(name)!, c: this.ceilings.get(capability)! };
  }

  /** Recursively check model-supplied args against the live schema; returns problems. */
  private checkArgs(v: unknown, raw: Node, path: string, root: Node): string[] {
    const n = (() => { let cur = raw; const seen = new Set<string>(); while (typeof cur.$ref === "string" && !seen.has(cur.$ref)) { seen.add(cur.$ref); cur = cur.$ref.slice(2).split("/").reduce<unknown>((o, k) => (o as Node)?.[k], root) as Node; } return cur; })();
    if (Array.isArray(n.allOf)) { const errs = (n.allOf as Node[]).flatMap((b) => this.checkArgs(v, b, path, root)); if (errs.length) return errs; }
    for (const k of ["anyOf", "oneOf"] as const) if (Array.isArray(n[k])) { const tries = (n[k] as Node[]).map((b) => this.checkArgs(v, b, path, root)); if (!tries.some((t) => !t.length)) return [`${path || "(root)"}: matches no allowed alternative`]; if (!n.properties && !n.items) return []; }
    if (Array.isArray(v)) { if (!n.items) return [`${path}: unexpected array`]; return v.flatMap((x, i) => this.checkArgs(x, n.items as Node, `${path}[${i}]`, root)); }
    if (v && typeof v === "object") {
      const props = (n.properties ?? {}) as Record<string, Node>;
      return Object.entries(v as Node).flatMap(([k, x]) => {
        const p = path ? `${path}.${k}` : k;
        if (isSubjectArg(k)) return [`${p}: person fields are set by the server`];
        if (!(k in props)) return [`${p}: unknown field`];
        return this.checkArgs(x, props[k]!, p, root);
      });
    }
    const leaf = path.replace(/\[\d+\]/g, "").split(".").at(-1) ?? "";
    if (v !== null && typeof v !== "object" && isIdLike(leaf) && !("const" in n)) return [`${path}: record ids are not accepted`];
    if (typeof v === "string") {
      // Formats are checked here, not left to Ajv (which ignores "format" without ajv-formats).
      if (n.format === "date" ? !isCalendarDate(v) : n.format === "date-time" ? !isCalendarDateTime(v) : !(Array.isArray(n.enum) || "const" in n)) return [`${path}: only enum, const, or date values are accepted`];
    }
    return [];
  }

  private setPath(obj: Node, path: string, value: unknown) {
    const ks = path.split("."); let cur = obj;
    for (const k of ks.slice(0, -1)) { if (!cur[k] || typeof cur[k] !== "object") cur[k] = {}; cur = cur[k] as Node; }
    cur[ks.at(-1)!] = value;
  }

  buildArgs(name: string, capability: string, llmArgs: Record<string, unknown>, workerId: string | undefined, callerKey: string) {
    const { e, t } = this.entry(name, capability);
    const schema = (t.inputSchema ?? { type: "object" }) as Node;
    const errs = this.checkArgs(llmArgs, schema, "", schema); void callerKey;
    if (errs.length) throw new UpstreamToolError(`Refused arguments for '${name}': ${errs.slice(0, 3).join("; ")}`);
    const args = structuredClone(llmArgs) as Node;
    for (const [p, how] of Object.entries(e.subject)) {
      if (how === "caller") { if (!workerId) throw new UpstreamToolError(`'${name}' needs the authenticated worker.`); this.setPath(args, p, workerId); }
      else this.setPath(args, p, how === "me" ? "me" : true);
    }
    const validate = this.ajv.compile(schema);
    if (!validate(args)) throw new UpstreamToolError(`Arguments do not match the live schema of '${name}': ${this.ajv.errorsText(validate.errors).slice(0, 300)}`);
    return { args, fingerprint: e.fingerprint };
  }

  async call(name: string, args: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> {
    const r = await this.up.call(name, args, timeoutMs);
    if (r.isError) throw new UpstreamToolError(`Workday MCP returned an error for ${name}: ${scrub(String((r.data as { message?: unknown })?.message ?? "no detail"))}`);
    if (r.data === undefined) throw new UpstreamUnknownError(`Workday MCP returned no data for ${name}.`);
    return r.data;
  }

  /** Before any call after a token refresh: re-read the self identity and require the same worker. */
  private async recheckIdentity() {
    if (!this.identityRecheck) return;
    const w = await this.resolveWorkerId();
    if (w !== this.boundWorker) { this.opts.onIdentityMismatch?.(); throw new UpstreamToolError("Signed-in worker changed; session ended."); }
    this.identityRecheck = false;
  }

  async read(name: string, capability: string, llmArgs: Record<string, unknown>, workerId: string, callerKey: string): Promise<unknown> {
    await this.recheckIdentity();
    await this.ensureFresh();
    const { args } = this.buildArgs(name, capability, llmArgs, workerId, callerKey);
    return this.call(name, args);
  }

  async assertUnchanged(name: string, capability: string, previewFingerprint: string): Promise<void> {
    await this.recheckIdentity();
    await this.ensureFresh(true);
    const { e } = this.entry(name, capability);
    if (fingerprint(this.live.get(name)!) !== previewFingerprint || e.fingerprint !== previewFingerprint) throw new UpstreamToolError(`The contract of '${name}' changed since the preview. Nothing was sent; preview again after re-approval.`);
  }

  /** Self identity via the attested identity.self tool: one self selector, no other inputs, exactly one record. */
  async resolveWorkerId(): Promise<string> {
    await this.ensureFresh(true);
    const ids = this.policy.tools.filter((x) => x.capability === "identity.self");
    if (ids.length !== 1) throw new UpstreamToolError("The tool policy needs exactly one identity.self tool.");
    const e = ids[0]!;
    const { args } = this.buildArgs(e.name, "identity.self", {}, undefined, "-");
    let cur: unknown = await this.call(e.name, args);
    for (const seg of e.identity!.workerIdPath.split(".")) {
      const arr = seg.endsWith("[]"); const k = arr ? seg.slice(0, -2) : seg;
      cur = cur && typeof cur === "object" ? (cur as Node)[k] : undefined;
      if (arr) { if (!Array.isArray(cur) || cur.length !== 1) throw new UpstreamUnknownError("Identity tool did not return exactly one record; refusing to guess."); cur = cur[0]; }
    }
    if (typeof cur !== "string" || !cur || cur.length > 128) throw new UpstreamUnknownError("Identity tool did not return a worker id at the configured path.");
    this.boundWorker ??= cur;
    return cur;
  }
}
