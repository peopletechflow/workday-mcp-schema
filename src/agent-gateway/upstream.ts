import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

/** Upstream said the call failed (isError). Treated as a definitive failure for writes. */
export class UpstreamToolError extends Error { constructor(m: string) { super(m); this.name = "UpstreamToolError"; } }
/** Transport failure, timeout or a response that does not match the contract. Outcome of a write is unknown. */
export class UpstreamUnknownError extends Error { constructor(m: string) { super(m); this.name = "UpstreamUnknownError"; } }
/** The capability has no verified mapping for this tenant. */
export class CapabilityGated extends Error { constructor(readonly capability: string, reason: string) { super(`'${capability}' is not available: ${reason}`); this.name = "CapabilityGated"; } }

export type UpstreamTool = { name: string; description?: string; inputSchema: { type?: string; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown }; outputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> };
export interface Upstream { listTools(): Promise<UpstreamTool[]>; onToolsChanged(cb: () => void): void; call(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<{ isError: boolean; data: unknown }>; close(): Promise<void> }

/** Upper bound on one upstream tool result after the SDK has parsed it (second line of defence). */
export const MAX_UPSTREAM_TEXT = 1_000_000;
/** Upper bound on raw bytes of any single HTTP response body from the upstream, enforced while streaming, before the SDK parses it. */
export const MAX_UPSTREAM_RESPONSE_BYTES = 2_000_000;

/**
 * fetch wrapper for the SDK transport: counts body bytes as they stream (JSON and SSE alike) and
 * aborts the response, cancelling the underlying body, once the cap is passed. Each HTTP response
 * (including a long-lived SSE stream) has its own budget.
 */
export function byteLimitedFetch(limit = MAX_UPSTREAM_RESPONSE_BYTES, base: typeof fetch = fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const res = await base(input, init);
    if (!res.body) return res;
    const declared = Number(res.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(declared) && declared > limit) { await res.body.cancel().catch(() => {}); throw new UpstreamUnknownError(`Upstream response declared ${declared} bytes, over the ${limit}-byte limit.`); }
    const reader = res.body.getReader(); let seen = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        const { done, value } = await reader.read();
        if (done) { ctrl.close(); return; }
        seen += value.byteLength;
        if (seen > limit) { await reader.cancel().catch(() => {}); ctrl.error(new UpstreamUnknownError(`Upstream response exceeded the ${limit}-byte limit.`)); return; }
        ctrl.enqueue(value);
      },
      cancel(reason) { return reader.cancel(reason); },
    });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
}

/** Official MCP SDK client. Redirects are refused so the bearer token is never replayed to another origin. The caller's own bearer token is attached to every request; there is no shared token. */
/** Bearer source: a fixed token (dev only) or a provider that returns a fresh token per request (ASU sessions). */
export type TokenSource = string | (() => Promise<string>);

export async function connectUpstream(opts: { url: string; accessToken: TokenSource } | { transport: Transport }): Promise<Upstream> {
  const client = new Client({ name: "workday-mcp-task-gateway", version: "0.2.0" });
  const transport = "transport" in opts ? opts.transport : (() => {
    const u = new URL(opts.url);
    if (u.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) throw new Error("WORKDAY_MCP_URL must use https (http only for loopback).");
    const tok = opts.accessToken;
    const authed: typeof fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const t = typeof tok === "string" ? tok : await tok();
      const h = new Headers(init?.headers); h.set("Authorization", `Bearer ${t}`);
      return fetch(input, { ...init, headers: h, redirect: "error" });
    }) as typeof fetch;
    return new StreamableHTTPClientTransport(u, { fetch: byteLimitedFetch(MAX_UPSTREAM_RESPONSE_BYTES, authed) });
  })();
  const changed: (() => void)[] = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { for (const cb of changed) cb(); });
  await client.connect(transport);
  return {
    onToolsChanged(cb) { changed.push(cb); },
    async listTools() {
      const out: UpstreamTool[] = []; let cursor: string | undefined;
      do { const r = await client.listTools(cursor ? { cursor } : undefined); out.push(...(r.tools as UpstreamTool[])); cursor = r.nextCursor; } while (cursor && out.length < 2000);
      return out;
    },
    async call(name, args, timeoutMs) {
      let r: Awaited<ReturnType<typeof client.callTool>>;
      try { r = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs }); }
      catch (e) { throw new UpstreamUnknownError(`Upstream call failed: ${scrub((e as Error).message)}`); }
      if (r.structuredContent !== undefined && JSON.stringify(r.structuredContent).length > MAX_UPSTREAM_TEXT) throw new UpstreamToolError(`Workday MCP response for ${name} is too large; refusing to use it.`);
      const data = r.structuredContent ?? (() => {
        const t = (r.content as { type: string; text?: string }[] | undefined)?.find((x) => x.type === "text")?.text;
        if (t === undefined) return undefined;
        if (t.length > MAX_UPSTREAM_TEXT) throw new UpstreamToolError(`Workday MCP response for ${name} is larger than ${MAX_UPSTREAM_TEXT} characters; refusing to parse.`);
        try { return JSON.parse(t); } catch { return r.isError ? { message: t } : undefined; }
      })();
      return { isError: Boolean(r.isError), data };
    },
    close: () => client.close(),
  };
}

/** Tenant mapping file: which upstream Workday MCP tool serves each capability and how arguments map. */
/** from: a capability input; const: a fixed value; caller: the authenticated worker resolved at startup (never model or query input). */
const ArgSpec = z.union([z.object({ from: z.string() }).strict(), z.object({ const: z.union([z.string(), z.number(), z.boolean()]) }).strict(), z.object({ caller: z.literal("workerId") }).strict()]);
export const MappingFile = z.object({
  version: z.literal(1),
  verifiedAgainst: z.string().optional(),
  capabilities: z.record(z.string(), z.object({ tool: z.string().min(1), args: z.record(z.string(), ArgSpec).default({}), resultPath: z.string().optional(), fieldMap: z.record(z.string(), z.string().min(1)).optional() }).strict()),
}).strict();
export type Mapping = z.infer<typeof MappingFile>;

export type CapabilityDef = { kind: "read" | "write"; inputs: readonly string[]; output: z.ZodTypeAny; description: string;
  /** Upstream tools that must never back this capability (for example manager/HR actions behind a self-service write). */
  denyTools?: readonly string[];
  /**
   * Inputs that legitimately name another person (an object of the action, such as a feedback recipient).
   * Value documents the server-side approved source; the tool must resolve it from that source, never from free model text.
   */
  objectInputs?: Readonly<Record<string, string>> };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/**
 * Upstream argument names that select whose data is read or written. Record ids such as goalId,
 * eventId or reviewId are not subjects; the upstream authorizes those under the caller's own token.
 */
export function isSubjectArg(name: string): boolean {
  const n = norm(name);
  return n === "me" || n === "wid" || /(worker|employee|person|subject|target|user|manager|contextinstance|instance|recipient|reviewee|reviewer|owner)/.test(n);
}
/** Writes that belong to managers, HR or payroll. Never allowed behind these employee capabilities, whatever the mapping says. Not a proof about unknown tools: the explicit mapping allowlist and contract checks still apply. */
export const PROHIBITED_UPSTREAM_TOOLS = ["initiate_change_job", "approve_business_process_event_step", "request_payroll_input", "initiate_performance_review_for_employee"] as const;

/** Why a subject argument mapping is unsafe, or undefined if it is allowed. */
function subjectProblem(cap: string, def: CapabilityDef, k: string, a: z.infer<typeof ArgSpec>): string | undefined {
  if (!isSubjectArg(k)) return undefined;
  if ("const" in a) {
    const n = norm(k);
    if ((n === "contextinstanceid" && a.const === "me") || (n === "me" && a.const === true)) return undefined;
    return `${k} is pinned to a constant; only contextInstanceId:"me" or me:true are allowed`;
  }
  if ("caller" in a) return cap === "identity" ? `${k} cannot use the caller before identity is resolved` : undefined;
  if (def.objectInputs && a.from in def.objectInputs) return undefined;
  return `${k} is fed from caller input '${a.from}'; subject arguments must use {"caller":"workerId"} or an approved object input`;
}
export type CapabilityStatus = { capability: string; kind: "read" | "write"; status: "available" | "gated"; upstreamTool?: string; reason?: string };

/** Remove bearer tokens, long opaque strings, emails and control characters from upstream error text. */
export function scrub(msg: string): string {
  return msg.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/[A-Za-z0-9_\-+/=]{40,}/g, "[redacted]").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]").replace(/[\u0000-\u001f]/g, " ").slice(0, 300);
}
/** Upstream said the caller lacks access (as opposed to an empty result). */
export const isAccessDenied = (e: unknown) => e instanceof UpstreamToolError && /\b(403|forbidden|not authori[sz]ed|permission|access denied|security)\b/i.test(e.message);

/** Inputs the upstream may legitimately not accept: date windows are re-applied locally; idempotency falls back to our durable commit table. */
const OPTIONAL_INPUTS = new Set(["from", "to", "idempotencyKey"]);

const pick = (v: unknown, path?: string) => (path ? path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), v) : v);

/**
 * Allowlisted task gateway over an upstream Workday MCP server. Only capabilities with a mapping
 * whose tool exists upstream and whose arguments match the advertised input schema are callable.
 * Responses are validated strictly against the capability's output schema.
 */
export class Gateway {
  private readonly status = new Map<string, CapabilityStatus>();
  private constructor(private readonly up: Upstream | undefined, private readonly mapping: Mapping | undefined, private readonly defs: Record<string, CapabilityDef>, private readonly timeoutMs: number) {}

  static async create(up: Upstream | undefined, mapping: Mapping | undefined, defs: Record<string, CapabilityDef>, opts: { timeoutMs?: number; disabled?: readonly string[]; agentReadyEndpoint?: boolean } = {}): Promise<Gateway> {
    const g = new Gateway(up, mapping, defs, opts.timeoutMs ?? 15_000);
    const tools = up ? new Map((await up.listTools()).map((t) => [t.name, t])) : new Map<string, UpstreamTool>();
    for (const [cap, def] of Object.entries(defs)) {
      const set = (status: "available" | "gated", reason?: string, upstreamTool?: string) => g.status.set(cap, { capability: cap, kind: def.kind, status, reason, upstreamTool });
      const m = mapping?.capabilities[cap];
      if (opts.disabled?.includes(cap)) { set("gated", "disabled by operator (kill switch)"); continue; }
      if (opts.agentReadyEndpoint) { set("gated", "Workday Agent-Ready tools are for AI agent use only and change without versioning; fixed capability mappings are off. Use the workday_* agent tools."); continue; }
      if (!up) { set("gated", "no upstream Workday MCP server configured"); continue; }
      if (!m) { set("gated", "no tenant mapping configured"); continue; }
      if (/^REPLACE/i.test(m.tool)) { set("gated", "placeholder tool name from the example mapping; set the real upstream tool name", m.tool); continue; }
      const deny = new Set([...PROHIBITED_UPSTREAM_TOOLS, ...(def.denyTools ?? [])].map(norm));
      if (deny.has(norm(m.tool))) { set("gated", `upstream tool '${m.tool}' is a manager/HR/payroll action and is not allowed for this employee capability`, m.tool); continue; }
      const problems = Object.entries(m.args).flatMap(([k, a]) => { const p = subjectProblem(cap, def, k, a); return p ? [p] : []; });
      if (problems.length) { set("gated", `unsafe subject mapping: ${problems.join("; ")}`, m.tool); continue; }
      const t = tools.get(m.tool);
      if (!t) { set("gated", `upstream tool '${m.tool}' not found in tools/list`); continue; }
      const props = Object.keys(t.inputSchema?.properties ?? {});
      const extra = Object.keys(m.args).filter((a) => !props.includes(a));
      const missing = (t.inputSchema?.required ?? []).filter((r) => !(r in m.args));
      const badFrom = Object.values(m.args).flatMap((a) => ("from" in a && !def.inputs.includes(a.from) ? [a.from] : []));
      const mappedFrom = new Set(Object.values(m.args).flatMap((a) => ("from" in a ? [a.from] : [])));
      const unmappedInputs = def.inputs.filter((i) => !OPTIONAL_INPUTS.has(i) && !mappedFrom.has(i));
      if (unmappedInputs.length) { set("gated", `inputs not mapped to an upstream argument: ${unmappedInputs.join(",")} (see tools/list inputSchema for '${m.tool}')`, m.tool); continue; }
      if (extra.length || missing.length || badFrom.length) { set("gated", `mapping does not match upstream schema (unknown args: ${extra.join(",") || "-"}; missing required: ${missing.join(",") || "-"}; invalid sources: ${badFrom.join(",") || "-"})`, m.tool); continue; }
      set("available", undefined, m.tool);
    }
    for (const cap of Object.keys(mapping?.capabilities ?? {})) if (!defs[cap]) throw new Error(`Mapping names unknown capability '${cap}'.`);
    return g;
  }

  capabilities(): CapabilityStatus[] { return [...this.status.values()]; }
  isAvailable(cap: string): boolean { return this.status.get(cap)?.status === "available"; }

  /** caller: the authenticated identity (absent only for the startup identity call). */
  async invoke<T>(cap: string, input: Record<string, unknown>, caller?: { userId: string }): Promise<T> {
    const st = this.status.get(cap); const def = this.defs[cap];
    if (!st || !def || st.status !== "available") throw new CapabilityGated(cap, st?.reason ?? "unknown capability");
    const m = this.mapping!.capabilities[cap]!;
    const args: Record<string, unknown> = {};
    for (const [k, spec] of Object.entries(m.args)) {
      let v: unknown;
      if ("const" in spec) v = spec.const;
      else if ("caller" in spec) { if (!caller) throw new CapabilityGated(cap, "needs the authenticated caller"); v = caller.userId; }
      else v = input[spec.from];
      if (v !== undefined) args[k] = v;
    }
    const r = await this.up!.call(m.tool, args, this.timeoutMs);
    if (r.isError) throw new UpstreamToolError(`Workday MCP returned an error for ${cap}: ${scrub(String((r.data as { message?: unknown })?.message ?? "no detail"))}`);
    const picked = pick(r.data, m.resultPath);
    const shaped = m.fieldMap ? Object.fromEntries(Object.entries(m.fieldMap).map(([ours, path]) => [ours, pick(picked, path)])) : picked;
    const parsed = def.output.safeParse(shaped);
    if (!parsed.success) throw new UpstreamUnknownError(`Workday MCP response for ${cap} does not match the expected contract: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    return parsed.data as T;
  }
}

/** Identity contract every tenant mapping must provide: who the token belongs to, per Workday. */
export const IDENTITY_CAPABILITY: CapabilityDef = { kind: "read", inputs: [], description: "Signed-in worker identity", output: z.object({ tenantId: z.string().min(1).max(128).optional(), workerId: z.string().min(1).max(128) }).strip() };
