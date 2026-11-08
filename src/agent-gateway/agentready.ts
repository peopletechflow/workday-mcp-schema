/**
 * Runtime-discovered Workday Agent-Ready MCP tools, exposed to the LLM only inside an operator-approved policy.
 *
 * Workday's Developer Guidelines & Change Policy say these tools are for AI agents only, change names and schemas
 * without versioning, and must not be hard-coded into deterministic integrations. So:
 * - Tools are discovered with paginated tools/list on startup, after notifications/tools/list_changed, and when the
 *   cached list is older than the TTL. Every call is checked against the fresh list first.
 * - Only tools in the approved policy whose live fingerprint (name + input/output schema + annotations) still matches
 *   are exposed. A rename, schema change or removal turns the tool off until the operator re-approves it. Descriptions
 *   are excluded from the fingerprint because Workday rewrites them routinely; they are shown live, as untrusted text.
 * - The LLM chooses among exposed tools and fills arguments from the live schema. Subject (person) arguments are
 *   filled by the server from the authenticated worker. Writes need a preview of the exact call, explicit confirmation
 *   and an unchanged fingerprint at commit.
 * Nothing here passes arbitrary tool names through.
 */
import { createHash } from "node:crypto";
import * as AjvNs from "ajv";
import { z } from "zod";
import { isSubjectArg, PROHIBITED_UPSTREAM_TOOLS, scrub, UpstreamToolError, UpstreamUnknownError, type Upstream, type UpstreamTool } from "./upstream.js";

type AjvCtor = new (o: object) => { compile(s: object): ((d: unknown) => boolean) & { errors?: unknown }; errorsText(e?: unknown): string };
const Ajv: AjvCtor = ((AjvNs as unknown as { default: { default?: AjvCtor } & AjvCtor }).default.default ?? (AjvNs as unknown as { default: AjvCtor }).default);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
/** Contract fingerprint of a discovered tool. Description excluded on purpose (see header). */
export function fingerprint(t: UpstreamTool): string {
  return createHash("sha256").update(JSON.stringify(canon({ name: t.name, inputSchema: t.inputSchema ?? null, outputSchema: t.outputSchema ?? null, annotations: t.annotations ?? null }))).digest("hex");
}

export const ToolPolicyFile = z.object({
  version: z.literal(1),
  approvedBy: z.string().min(1),
  approvedAt: z.string().min(1),
  /** The ASOR agent registration this policy was reviewed against (tenant alias and agent client id). */
  tenantAlias: z.string().min(1),
  agentClientId: z.string().min(1),
  tools: z.array(z.object({
    name: z.string().min(1),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    access: z.enum(["read", "write"]),
    /** How each subject argument is filled. "caller" = authenticated worker id; "me" = the literal "me"; true = boolean true. */
    subject: z.record(z.string(), z.enum(["caller", "me", "true"])).default({}),
    /** Person arguments the LLM may set because they name the object of the action (for example a feedback recipient). */
    objectArgs: z.array(z.string()).default([]),
    /** Marks the tool that resolves the signed-in worker. workerIdPath is a dot path into its result. */
    identity: z.object({ workerIdPath: z.string().min(1) }).strict().optional(),
    note: z.string().optional(),
  }).strict()).max(200),
}).strict();
export type ToolPolicy = z.infer<typeof ToolPolicyFile>;
type Entry = ToolPolicy["tools"][number];

export type AgentToolStatus = { name: string; access: "read" | "write"; status: "available" | "missing" | "drifted" | "refused"; reason?: string; description?: string; inputSchema?: unknown };

/** Policy problems that make an entry unusable regardless of what the server lists. */
function policyProblem(e: Entry, live?: UpstreamTool): string | undefined {
  if (PROHIBITED_UPSTREAM_TOOLS.map(norm).includes(norm(e.name))) return "manager/HR/payroll tool is never exposed";
  if (e.identity && e.access !== "read") return "identity tool must be read";
  if (!live) return undefined;
  const ann = live.annotations ?? {};
  if (e.access === "read" && (ann.readOnlyHint === false || ann.destructiveHint === true)) return "approved as read but the server marks it as writing";
  const props = Object.keys(live.inputSchema?.properties ?? {});
  for (const k of Object.keys(e.subject)) if (!props.includes(k)) return `subject binding '${k}' is not in the live schema`;
  const unbound = props.filter((k) => isSubjectArg(k) && !(k in e.subject) && !e.objectArgs.includes(k));
  if (unbound.length) return `person argument(s) without a binding: ${unbound.join(",")}`;
  return undefined;
}

export class AgentToolRegistry {
  private live = new Map<string, UpstreamTool>();
  private fetchedAt = 0;
  private stale = true;
  private readonly ajv = new Ajv({ allErrors: false, strict: false });
  constructor(private readonly up: Upstream, readonly policy: ToolPolicy, private readonly opts: { ttlMs?: number; now?: () => number } = {}) {
    up.onToolsChanged(() => { this.stale = true; });
  }
  private now() { return (this.opts.now ?? Date.now)(); }
  /** Paginated tools/list (handled by Upstream.listTools). */
  async refresh(): Promise<void> { this.live = new Map((await this.up.listTools()).map((t) => [t.name, t])); this.fetchedAt = this.now(); this.stale = false; }
  async ensureFresh(force = false) { if (force || this.stale || this.now() - this.fetchedAt > (this.opts.ttlMs ?? 5 * 60_000)) await this.refresh(); }

  statuses(): AgentToolStatus[] {
    return this.policy.tools.map((e) => {
      const t = this.live.get(e.name);
      const bad = policyProblem(e, t);
      if (bad) return { name: e.name, access: e.access, status: "refused" as const, reason: bad };
      if (!t) return { name: e.name, access: e.access, status: "missing" as const, reason: "not in tools/list (renamed, removed, or not in this agent's ASOR registration); re-approve" };
      if (fingerprint(t) !== e.fingerprint) return { name: e.name, access: e.access, status: "drifted" as const, reason: "schema or annotations changed since approval; re-approve" };
      return { name: e.name, access: e.access, status: "available" as const, description: t.description, inputSchema: t.inputSchema };
    });
  }

  private entry(name: string, access: "read" | "write"): { e: Entry; t: UpstreamTool } {
    const e = this.policy.tools.find((x) => x.name === name);
    if (!e || e.access !== access) throw new UpstreamToolError(`'${name}' is not an approved ${access} tool.`);
    const st = this.statuses().find((s) => s.name === name)!;
    if (st.status !== "available") throw new UpstreamToolError(`'${name}' is unavailable: ${st.reason}`);
    return { e, t: this.live.get(name)! };
  }

  /** Server-side argument assembly: LLM args minus any subject keys, plus bindings from the authenticated worker. */
  buildArgs(name: string, access: "read" | "write", llmArgs: Record<string, unknown>, workerId: string | undefined) {
    const { e, t } = this.entry(name, access);
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(llmArgs)) {
      if (k in e.subject) throw new UpstreamToolError(`'${k}' is set by the server from your own identity.`);
      if (isSubjectArg(k) && !e.objectArgs.includes(k)) throw new UpstreamToolError(`'${k}' names a person and is not allowed for '${name}'.`);
      args[k] = v;
    }
    for (const [k, how] of Object.entries(e.subject)) {
      if (how === "caller") { if (!workerId) throw new UpstreamToolError(`'${name}' needs the authenticated worker.`); args[k] = workerId; }
      else args[k] = how === "me" ? "me" : true;
    }
    const props = Object.keys(t.inputSchema?.properties ?? {});
    const extra = Object.keys(args).filter((k) => !props.includes(k));
    if (extra.length) throw new UpstreamToolError(`Unknown argument(s) for '${name}': ${extra.join(",")}`);
    const validate = this.ajv.compile((t.inputSchema ?? { type: "object" }) as object);
    if (!validate(args)) throw new UpstreamToolError(`Arguments do not match the live schema of '${name}': ${this.ajv.errorsText(validate.errors).slice(0, 300)}`);
    return { args, fingerprint: e.fingerprint };
  }

  async call(name: string, args: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> {
    const r = await this.up.call(name, args, timeoutMs);
    if (r.isError) throw new UpstreamToolError(`Workday MCP returned an error for ${name}: ${scrub(String((r.data as { message?: unknown })?.message ?? "no detail"))}`);
    if (r.data === undefined) throw new UpstreamUnknownError(`Workday MCP returned no data for ${name}.`);
    return r.data;
  }

  /** Read: fresh discovery, approved + unchanged, server-bound subject args, live-schema validation. */
  async read(name: string, llmArgs: Record<string, unknown>, workerId: string | undefined): Promise<unknown> {
    await this.ensureFresh();
    const { args } = this.buildArgs(name, "read", llmArgs, workerId);
    return this.call(name, args);
  }

  /** Commit-time check: forced re-discovery; the fingerprint recorded in the preview must still be current. */
  async assertUnchanged(name: string, previewFingerprint: string): Promise<void> {
    await this.ensureFresh(true);
    const { e } = this.entry(name, "write");
    if (fingerprint(this.live.get(name)!) !== previewFingerprint || e.fingerprint !== previewFingerprint) throw new UpstreamToolError(`The contract of '${name}' changed since the preview. Nothing was sent; preview again after re-approval.`);
  }

  /** Startup identity through the policy's identity tool. */
  async resolveWorkerId(): Promise<string> {
    await this.ensureFresh(true);
    const e = this.policy.tools.find((x) => x.identity);
    if (!e) throw new UpstreamToolError("The tool policy has no identity tool.");
    const { args } = this.buildArgs(e.name, "read", {}, undefined);
    const out = await this.call(e.name, args);
    const id = e.identity!.workerIdPath.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), out);
    if (typeof id !== "string" || !id || id.length > 128) throw new UpstreamUnknownError("Identity tool did not return a worker id at the configured path.");
    return id;
  }
}
