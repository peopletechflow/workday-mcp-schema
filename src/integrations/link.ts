/**
 * Account linking: admin-invited Slack user -> Workday OAuth (authorization code + PKCE) ->
 * encrypted per-user token + active identity link. State is single use, short lived, and
 * bound to the Slack team+user that started it. Verifier is stored encrypted.
 *
 * Limitation: the repo has no sandbox-validated Workday "who am I" contract, so the link
 * binds the Slack user to the admin-invited user id and stores whatever Workday account
 * signs in. All Workday calls use the "me" entry on that token, so data access is always
 * the signer's own per Workday security.
 */
import type { AppConfig } from "../config.js";
import type { Db } from "../store/db.js";
import type { KeyRing } from "../store/crypto.js";
import type { DbIdentityLinks, DbTokenStore } from "../store/repos.js";
import { buildAuthorizeUrl, createPkcePair, exchangeAuthorizationCode } from "../auth/oauth.js";

const STATE_TTL_MS = 10 * 60 * 1000;

export class LinkService {
  constructor(
    private readonly d: { db: Db; config: AppConfig; keys: KeyRing; links: DbIdentityLinks; tokens: DbTokenStore; fetchImpl?: typeof fetch },
  ) {}

  /** Returns an authorize URL for an invited Slack user, or undefined when not invited. */
  async start(slackTeamId: string, slackUserId: string): Promise<string | undefined> {
    const id = await this.d.links.invited(slackTeamId, slackUserId);
    if (!id || id.tenantId !== this.d.config.workdayTenant) return undefined;
    const pkce = createPkcePair();
    await this.d.db.query(
      "INSERT INTO oauth_states (state, tenant_id, user_id, slack_team_id, slack_user_id, verifier_enc, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' milliseconds')::interval)",
      [pkce.state, id.tenantId, id.userId, slackTeamId, slackUserId, this.d.keys.sealCompact(pkce.codeVerifier, `pkce:${pkce.state}`), String(STATE_TTL_MS)],
    );
    return buildAuthorizeUrl(this.d.config, pkce);
  }

  /** OAuth redirect handler. Returns a short status; never echoes tokens or codes. */
  async callback(query: URLSearchParams): Promise<{ status: number; message: string }> {
    const state = query.get("state") ?? "";
    const code = query.get("code") ?? "";
    if (query.get("error")) return { status: 400, message: "Sign-in was cancelled or denied." };
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(state) || !code || code.length > 2048) return { status: 400, message: "Invalid sign-in response." };
    const r = await this.d.db.query<{ tenant_id: string; user_id: string; slack_team_id: string; slack_user_id: string; verifier_enc: string }>(
      "DELETE FROM oauth_states WHERE state = $1 AND expires_at > now() RETURNING tenant_id, user_id, slack_team_id, slack_user_id, verifier_enc",
      [state],
    );
    const s = r.rows[0];
    if (!s) return { status: 400, message: "Sign-in link expired or already used. Run the link command again." };
    let verifier: string;
    try {
      verifier = this.d.keys.openCompact(s.verifier_enc, `pkce:${state}`);
    } catch {
      return { status: 400, message: "Invalid sign-in state." };
    }
    let tokens;
    try {
      tokens = await exchangeAuthorizationCode(this.d.config, code, verifier, this.d.fetchImpl);
    } catch {
      return { status: 502, message: "Workday sign-in failed. Try again." };
    }
    const ok = await this.d.db.tx(async (q) => {
      const active = await this.d.links.activate(q, s.slack_team_id, s.slack_user_id, { tenantId: s.tenant_id, userId: s.user_id });
      if (!active) return false; // invite revoked meanwhile
      await this.d.tokens.set(s.user_id, tokens, q);
      return true;
    });
    return ok ? { status: 200, message: "Workday account linked. You can close this window." } : { status: 403, message: "This invite is no longer valid." };
  }
}
