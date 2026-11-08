/**
 * Workday Agent Gateway / Agent System User (ASU) OAuth for a delegate-mode external agent.
 *
 * Contract, from Workday's public docs (read 2026-11-08):
 * - MCP endpoint: https://{agentGatewayRegionEndpoint}/{tenantName}/mcp
 *   (developer.workday.com, "Agent-Ready MCP Tools", GUID-949559e7-…)
 * - Authorize: GET https://{gateway}/auth/authorize/{tenant}  params client_id, redirect_uri, response_type=code
 * - Token:     POST https://{gateway}/auth/oauth2/{tenant}/token  form grant_type=authorization_code, code, client_id, client_secret
 *   response { access_token, token_type: "Bearer", refresh_token }
 *   ("Connect an External Agent with Workday MCP", GUID-03605c39-…; admin guide "Authenticate Agents to Agent Gateway")
 * - Auth "uses only OAuth 2.1 with PKCE", so S256 code_challenge/code_verifier are always sent.
 * - Access tokens expire after 60 minutes; refresh before expiry.
 * - Client ID, client secret, redirect URI and the ASU come from registering, configuring and activating the agent in
 *   ASOR (Agent Management Hub). That is an operator step in the tenant; this code never provisions anything.
 *
 * Not in the public docs, so treated as assumptions and failing closed:
 * - The refresh request shape. Standard OAuth grant_type=refresh_token is used; any failure ends the session (re-authorize), with no fallback credential.
 * - A revocation endpoint. Signing out deletes local tokens. Revoke in Workday by deactivating the agent (takes up to 1 minute to apply).
 * - Ambient-mode (JWT bearer with an x509 key) is not implemented.
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

export class AsuReauthRequired extends Error { constructor(m: string) { super(m); this.name = "AsuReauthRequired"; } }
export class AsuContextMismatch extends Error { constructor(m: string) { super(m); this.name = "AsuContextMismatch"; } }

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];
export const AsuConfigSchema = z.object({
  gatewayHost: z.string().min(1),
  tenantAlias: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
  clientId: z.string().min(1).max(512),
  clientSecret: z.string().min(1),
  redirectUri: z.string().url(),
  production: z.boolean(),
}).strict();
export type AsuConfig = z.infer<typeof AsuConfigSchema>;

/** Validates the Agent Gateway host and derives every endpoint from it, so tokens only go to Workday's gateway. */
export function asuEndpoints(cfg: AsuConfig) {
  const c = AsuConfigSchema.parse(cfg);
  const loop = LOOPBACK.includes(c.gatewayHost.split(":")[0]!);
  if (!loop && !/^[a-z0-9-]+\.agent\.workday\.com$/.test(c.gatewayHost)) throw new Error("WORKDAY_AGENT_GATEWAY must be a regional Agent Gateway host such as us.agent.workday.com.");
  if (loop && c.production) throw new Error("A loopback Agent Gateway is for tests only, not production.");
  const r = new URL(c.redirectUri);
  if (r.protocol !== "https:" && !(LOOPBACK.includes(r.hostname) && !c.production)) throw new Error("ASU redirect URI must be https (loopback http only outside production).");
  const base = `${loop ? "http" : "https"}://${c.gatewayHost}`;
  const t = encodeURIComponent(c.tenantAlias);
  return { authorize: `${base}/auth/authorize/${t}`, token: `${base}/auth/oauth2/${t}/token`, mcp: `${base}/${t}/mcp` };
}

export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** Builds the browser authorize URL. Keep state and verifier server-side until the callback. */
export function authorizeUrl(cfg: AsuConfig, state: string, challenge: string): string {
  const u = new URL(asuEndpoints(cfg).authorize);
  u.searchParams.set("client_id", cfg.clientId); u.searchParams.set("redirect_uri", cfg.redirectUri); u.searchParams.set("response_type", "code");
  u.searchParams.set("state", state); u.searchParams.set("code_challenge", challenge); u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

const TokenResponse = z.object({
  access_token: z.string().min(1).max(16_384),
  token_type: z.string().regex(/^bearer$/i),
  refresh_token: z.string().min(1).max(16_384).optional(),
  expires_in: z.union([z.number(), z.string().regex(/^\d+$/)]).optional(),
}).passthrough();

/** One user's delegate session. Bound to the gateway, tenant, agent client and (after identity) the worker. */
export type AsuSession = { gatewayHost: string; tenantAlias: string; clientId: string; workerId?: string; accessToken: string; refreshToken?: string; expiresAt: number };

const DEFAULT_TTL_S = 60 * 60; // documented 60-minute access token lifetime

async function tokenRequest(cfg: AsuConfig, form: Record<string, string>, f: typeof fetch, now: () => number): Promise<Omit<AsuSession, "workerId">> {
  let res: Response;
  try {
    res = await f(asuEndpoints(cfg).token, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ ...form, client_id: cfg.clientId, client_secret: cfg.clientSecret }), redirect: "error", signal: AbortSignal.timeout(15_000) });
  } catch { throw new AsuReauthRequired("Agent Gateway token endpoint unreachable; sign in again."); }
  if (!res.ok) throw new AsuReauthRequired(`Agent Gateway token request failed (HTTP ${res.status}); sign in again.`);
  const text = await res.text();
  if (text.length > 65_536) throw new AsuReauthRequired("Token response too large.");
  let body: unknown; try { body = JSON.parse(text); } catch { throw new AsuReauthRequired("Token response was not JSON."); }
  const p = TokenResponse.safeParse(body);
  if (!p.success) throw new AsuReauthRequired("Token response did not match the documented shape (access_token, token_type Bearer).");
  const ttl = p.data.expires_in === undefined ? DEFAULT_TTL_S : Number(p.data.expires_in);
  return { gatewayHost: cfg.gatewayHost, tenantAlias: cfg.tenantAlias, clientId: cfg.clientId, accessToken: p.data.access_token, refreshToken: p.data.refresh_token, expiresAt: now() + Math.min(ttl, DEFAULT_TTL_S * 24) * 1000 };
}

export function exchangeCode(cfg: AsuConfig, code: string, verifier: string, f: typeof fetch = fetch, now: () => number = Date.now) {
  return tokenRequest(cfg, { grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri, code_verifier: verifier }, f, now);
}

/**
 * Supplies a current ASU access token for one bound session. Refreshes 5 minutes before expiry, one request at a time.
 * On refresh failure the session is cleared and AsuReauthRequired is thrown: no retry with other credentials.
 */
export class AsuTokenProvider {
  private inflight?: Promise<string>;
  constructor(private readonly cfg: AsuConfig, private session: AsuSession | undefined, private readonly opts: { fetch?: typeof fetch; now?: () => number; onChange?: (s: AsuSession | undefined) => void; onRefreshed?: () => void } = {}) {
    if (session) this.assertContext(session);
  }
  private assertContext(s: AsuSession) {
    if (s.gatewayHost !== this.cfg.gatewayHost) throw new AsuContextMismatch("ASU session belongs to a different Agent Gateway.");
    if (s.tenantAlias !== this.cfg.tenantAlias) throw new AsuContextMismatch("ASU session belongs to a different tenant.");
    if (s.clientId !== this.cfg.clientId) throw new AsuContextMismatch("ASU session belongs to a different registered agent.");
  }
  /** Binds the session to the worker the upstream identity tool resolved. A later different worker is refused. */
  bindWorker(workerId: string) {
    if (!this.session) throw new AsuReauthRequired("No ASU session.");
    if (this.session.workerId && this.session.workerId !== workerId) throw new AsuContextMismatch("ASU session is bound to a different worker.");
    this.session = { ...this.session, workerId }; this.opts.onChange?.(this.session);
  }
  assertWorker(workerId: string) { if (this.session?.workerId !== workerId) throw new AsuContextMismatch("Caller does not match the worker bound to this ASU session."); }
  signOut() { this.session = undefined; this.opts.onChange?.(undefined); }
  readonly token = (): Promise<string> => {
    const now = (this.opts.now ?? Date.now)();
    const s = this.session;
    if (!s) return Promise.reject(new AsuReauthRequired("No ASU session; sign in through the Agent Gateway authorize URL."));
    if (s.expiresAt - now > 5 * 60_000) return Promise.resolve(s.accessToken);
    if (!s.refreshToken) { this.signOut(); return Promise.reject(new AsuReauthRequired("ASU access token expired and no refresh token was issued; sign in again.")); }
    this.inflight ??= tokenRequest(this.cfg, { grant_type: "refresh_token", refresh_token: s.refreshToken }, this.opts.fetch ?? fetch, this.opts.now ?? Date.now)
      .then((n) => { this.session = { ...n, workerId: s.workerId, refreshToken: n.refreshToken ?? s.refreshToken }; this.opts.onChange?.(this.session); this.opts.onRefreshed?.(); return n.accessToken; })
      .catch((e) => { this.signOut(); throw e instanceof AsuReauthRequired ? e : new AsuReauthRequired("ASU refresh failed; sign in again."); })
      .finally(() => { this.inflight = undefined; });
    return this.inflight;
  };
}
