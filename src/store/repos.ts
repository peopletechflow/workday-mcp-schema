/**
 * Durable repositories on Postgres: Slack replay guard, form sessions, identity links,
 * role entitlements, encrypted OAuth tokens and PKCE states, admin audit.
 */
import { randomBytes } from "node:crypto";
import type { Db, Queryable } from "./db.js";
import type { KeyRing } from "./crypto.js";
import type { BoundIdentity, IdentityResolver, SlackAddress, SlackDirectory } from "../integrations/identity.js";
import type { ReplayGuard } from "../integrations/slack/verify.js";
import type { FormSession, FormSessions } from "../integrations/slack/forms.js";
import type { OAuthTokens } from "../auth/oauth.js";
import { InMemoryAssignmentStore, parseRoles, type Role } from "../rbac/index.js";
import type { AssignmentStore } from "../rbac/assignments.js";

export class DbReplayGuard implements ReplayGuard {
  constructor(private readonly db: Db) {}
  async checkAndRemember(key: string, nowSec: number): Promise<boolean> {
    const r = await this.db.query(
      "INSERT INTO slack_replay (key, expires_at) VALUES ($1, to_timestamp($2)) ON CONFLICT (key) DO NOTHING",
      [key, nowSec + 600],
    );
    return r.rowCount === 1;
  }
  async prune(): Promise<number> {
    return (await this.db.query("DELETE FROM slack_replay WHERE expires_at < now()")).rowCount;
  }
}

/** Delete expired single-use rows (replay keys, form sessions, OAuth states). Returns rows removed. */
export async function pruneExpired(db: Queryable): Promise<number> {
  let n = 0;
  for (const table of ["slack_replay", "form_sessions", "oauth_states"] as const) {
    n += (await db.query(`DELETE FROM ${table} WHERE expires_at < now()`)).rowCount;
  }
  return n;
}

export class DbFormSessions implements FormSessions {
  constructor(private readonly db: Db) {}
  async open(s: Omit<FormSession, "expiresAt">, ttlMs: number): Promise<string> {
    const nonce = randomBytes(18).toString("base64url");
    await this.db.query(
      "INSERT INTO form_sessions (nonce, slack_team_id, slack_user_id, tenant_id, user_id, kind, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' milliseconds')::interval)",
      [nonce, s.slackTeamId, s.slackUserId, s.identity.tenantId, s.identity.userId, s.kind, String(ttlMs)],
    );
    return nonce;
  }
  async peek(nonce: string): Promise<FormSession | undefined> {
    const r = await this.db.query<{ slack_team_id: string; slack_user_id: string; tenant_id: string; user_id: string; kind: string; exp: string }>(
      "SELECT slack_team_id, slack_user_id, tenant_id, user_id, kind, extract(epoch from expires_at)*1000 AS exp FROM form_sessions WHERE nonce = $1 AND expires_at > now()",
      [nonce],
    );
    const x = r.rows[0];
    return x && { slackTeamId: x.slack_team_id, slackUserId: x.slack_user_id, identity: { tenantId: x.tenant_id, userId: x.user_id }, kind: x.kind, expiresAt: Number(x.exp) };
  }
  async consume(nonce: string): Promise<boolean> {
    return (await this.db.query("DELETE FROM form_sessions WHERE nonce = $1 AND expires_at > now()", [nonce])).rowCount === 1;
  }
}

export async function adminAudit(q: Queryable, actor: string, action: string, detail: Record<string, unknown>): Promise<void> {
  await q.query("INSERT INTO admin_audit (actor, action, detail) VALUES ($1, $2, $3)", [actor, action, JSON.stringify(detail)]);
}

/**
 * Identity links. An admin invites (Slack team+user -> tenant user id); the link becomes
 * active only after that Slack user completes Workday OAuth through the signed link flow.
 * Only active links resolve.
 */
export class DbIdentityLinks implements IdentityResolver, SlackDirectory {
  constructor(private readonly db: Db) {}
  async resolveSlack(teamId: string, userId: string): Promise<BoundIdentity | undefined> {
    const r = await this.db.query<{ tenant_id: string; user_id: string }>(
      "SELECT tenant_id, user_id FROM identity_links WHERE slack_team_id = $1 AND slack_user_id = $2 AND status = 'active'",
      [teamId, userId],
    );
    const x = r.rows[0];
    return x && { tenantId: x.tenant_id, userId: x.user_id };
  }
  /** Active link for a tenant user, for notifications only (identity_links_user keeps this unique). */
  async slackFor(identity: BoundIdentity): Promise<SlackAddress | undefined> {
    const r = await this.db.query<{ slack_team_id: string; slack_user_id: string }>(
      "SELECT slack_team_id, slack_user_id FROM identity_links WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'",
      [identity.tenantId, identity.userId],
    );
    const x = r.rows[0];
    return x && { teamId: x.slack_team_id, userId: x.slack_user_id };
  }
  /** Invited (not yet active) link, used only by the link command. */
  async invited(teamId: string, userId: string): Promise<BoundIdentity | undefined> {
    const r = await this.db.query<{ tenant_id: string; user_id: string }>(
      "SELECT tenant_id, user_id FROM identity_links WHERE slack_team_id = $1 AND slack_user_id = $2 AND status IN ('invited','active')",
      [teamId, userId],
    );
    const x = r.rows[0];
    return x && { tenantId: x.tenant_id, userId: x.user_id };
  }
  async invite(actor: string, l: { slackTeamId: string; slackUserId: string; tenantId: string; userId: string }): Promise<void> {
    await this.db.tx(async (q) => {
      await q.query(
        `INSERT INTO identity_links (slack_team_id, slack_user_id, tenant_id, user_id, status, created_by)
         VALUES ($1,$2,$3,$4,'invited',$5)
         ON CONFLICT (slack_team_id, slack_user_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, user_id = EXCLUDED.user_id,
           status = 'invited', created_by = EXCLUDED.created_by, created_at = now(), linked_at = NULL`,
        [l.slackTeamId, l.slackUserId, l.tenantId, l.userId, actor],
      );
      await adminAudit(q, actor, "link.invite", l);
    });
  }
  async activate(q: Queryable, slackTeamId: string, slackUserId: string, id: BoundIdentity): Promise<boolean> {
    const r = await q.query(
      "UPDATE identity_links SET status = 'active', linked_at = now() WHERE slack_team_id = $1 AND slack_user_id = $2 AND tenant_id = $3 AND user_id = $4 AND status IN ('invited','active')",
      [slackTeamId, slackUserId, id.tenantId, id.userId],
    );
    return r.rowCount === 1;
  }
  async revoke(actor: string, slackTeamId: string, slackUserId: string): Promise<boolean> {
    return this.db.tx(async (q) => {
      const r = await q.query<{ tenant_id: string; user_id: string }>(
        "UPDATE identity_links SET status = 'revoked' WHERE slack_team_id = $1 AND slack_user_id = $2 AND status <> 'revoked' RETURNING tenant_id, user_id",
        [slackTeamId, slackUserId],
      );
      const x = r.rows[0];
      if (x) await q.query("DELETE FROM oauth_tokens WHERE tenant_id = $1 AND user_id = $2", [x.tenant_id, x.user_id]);
      await adminAudit(q, actor, "link.revoke", { slackTeamId, slackUserId });
      return Boolean(x);
    });
  }
}

/**
 * Role entitlements managed by admins through the CLI (audited). Roles are a coarse
 * pre-filter; Workday security on the user's own token stays authoritative.
 */
export class DbEntitlements {
  constructor(private readonly db: Db) {}
  async authzFor(identity: BoundIdentity): Promise<{ roles: Role[]; assignments: AssignmentStore }> {
    const r = await this.db.query<{ roles: string[]; grants: string[]; denies: string[]; updated_by: string; updated_at: Date }>(
      "SELECT roles, grants, denies, updated_by, updated_at FROM role_assignments WHERE tenant_id = $1 AND user_id = $2",
      [identity.tenantId, identity.userId],
    );
    const store = new InMemoryAssignmentStore();
    const x = r.rows[0];
    if (!x) return { roles: [], assignments: store };
    const roles = parseRoles(x.roles.join(","));
    store.set({ userId: identity.userId, roles, grants: x.grants, denies: x.denies, updatedAt: new Date(x.updated_at).toISOString(), updatedBy: x.updated_by });
    return { roles, assignments: store };
  }
  async set(actor: string, identity: BoundIdentity, v: { roles: string[]; grants?: string[]; denies?: string[] }): Promise<void> {
    const roles = parseRoles(v.roles.join(","));
    // Validate permission ids by normalizing through the existing store (throws on unknown ids).
    new InMemoryAssignmentStore().set({ userId: identity.userId, roles, grants: v.grants ?? [], denies: v.denies ?? [], updatedAt: new Date().toISOString() });
    await this.db.tx(async (q) => {
      await q.query(
        `INSERT INTO role_assignments (tenant_id, user_id, roles, grants, denies, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET roles = EXCLUDED.roles, grants = EXCLUDED.grants, denies = EXCLUDED.denies, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [identity.tenantId, identity.userId, roles, v.grants ?? [], v.denies ?? [], actor],
      );
      await adminAudit(q, actor, "roles.set", { ...identity, roles, grants: v.grants ?? [], denies: v.denies ?? [] });
    });
  }
}

/** Per-user encrypted OAuth tokens. AAD binds ciphertext to tenant+user. */
export class DbTokenStore {
  constructor(private readonly db: Db, private readonly keys: KeyRing, private readonly tenantId: string) {}
  private aad(userId: string) {
    return `oauth:${this.tenantId}:${userId}`;
  }
  async get(userId: string, q: Queryable = this.db, forUpdate = false): Promise<OAuthTokens | undefined> {
    const r = await q.query<{ key_id: string; iv: string; tag: string; ciphertext: string }>(
      `SELECT key_id, iv, tag, ciphertext FROM oauth_tokens WHERE tenant_id = $1 AND user_id = $2${forUpdate ? " FOR UPDATE" : ""}`,
      [this.tenantId, userId],
    );
    const x = r.rows[0];
    if (!x) return undefined;
    return JSON.parse(this.keys.open({ keyId: x.key_id, iv: x.iv, tag: x.tag, ciphertext: x.ciphertext }, this.aad(userId))) as OAuthTokens;
  }
  async set(userId: string, tokens: OAuthTokens, q: Queryable = this.db): Promise<void> {
    const s = this.keys.seal(JSON.stringify(tokens), this.aad(userId));
    await q.query(
      `INSERT INTO oauth_tokens (tenant_id, user_id, key_id, iv, tag, ciphertext) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET key_id = EXCLUDED.key_id, iv = EXCLUDED.iv, tag = EXCLUDED.tag, ciphertext = EXCLUDED.ciphertext, updated_at = now()`,
      [this.tenantId, userId, s.keyId, s.iv, s.tag, s.ciphertext],
    );
  }
  async delete(userId: string, q: Queryable = this.db): Promise<void> {
    await q.query("DELETE FROM oauth_tokens WHERE tenant_id = $1 AND user_id = $2", [this.tenantId, userId]);
  }
}
