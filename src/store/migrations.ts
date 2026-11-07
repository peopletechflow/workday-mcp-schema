/** Forward-only schema migrations. Applied by `npm run db:migrate` (or at boot with DB_MIGRATE_ON_START=true). */
import type { Db } from "./db.js";

export const MIGRATIONS: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: "init",
    sql: `
CREATE TABLE IF NOT EXISTS slack_replay (
  key text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS slack_replay_exp ON slack_replay (expires_at);

CREATE TABLE IF NOT EXISTS form_sessions (
  nonce text PRIMARY KEY,
  slack_team_id text NOT NULL,
  slack_user_id text NOT NULL,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  kind text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_links (
  slack_team_id text NOT NULL,
  slack_user_id text NOT NULL,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('invited','active','revoked')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  linked_at timestamptz,
  PRIMARY KEY (slack_team_id, slack_user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS identity_links_user ON identity_links (tenant_id, user_id) WHERE status <> 'revoked';

CREATE TABLE IF NOT EXISTS role_assignments (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  roles text[] NOT NULL DEFAULT '{}',
  grants text[] NOT NULL DEFAULT '{}',
  denies text[] NOT NULL DEFAULT '{}',
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS approval_policies (
  tenant_id text NOT NULL,
  commit_tool text NOT NULL,
  approver_user_ids text[] NOT NULL,
  allow_self_approval boolean NOT NULL DEFAULT false,
  rotate boolean NOT NULL DEFAULT false,
  rotation_counter bigint NOT NULL DEFAULT 0,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, commit_tool)
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  requester_user_id text NOT NULL,
  commit_tool text NOT NULL,
  resource text NOT NULL,
  change jsonb NOT NULL,
  change_hash text NOT NULL,
  summary text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','approved','rejected','expired','committing','committed','failed','unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  assigned_approvers text[] NOT NULL,
  decided_by text,
  decided_at timestamptz,
  source text NOT NULL,
  result jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approval_requests_tenant ON approval_requests (tenant_id, status);

CREATE TABLE IF NOT EXISTS commit_ledger (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  tool text NOT NULL,
  idempotency_key text NOT NULL,
  request_id text NOT NULL REFERENCES approval_requests(id),
  state text NOT NULL CHECK (state IN ('in_flight','ok','error','unknown')),
  body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, tool, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS commit_ledger_request ON commit_ledger (request_id);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  key_id text NOT NULL,
  iv text NOT NULL,
  tag text NOT NULL,
  ciphertext text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state text PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  slack_team_id text NOT NULL,
  slack_user_id text NOT NULL,
  verifier_enc text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_audit (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  action text NOT NULL,
  detail jsonb NOT NULL
);
`,
  },
];

export async function migrate(db: Db): Promise<number[]> {
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    await db.tx(async (q) => {
      // Serialize concurrent migrators across instances.
      await q.query("SELECT pg_advisory_xact_lock(727274001)");
      const done = await q.query("SELECT 1 FROM schema_migrations WHERE version = $1", [m.version]);
      if (done.rowCount) return;
      await q.query(m.sql);
      await q.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [m.version, m.name]);
      applied.push(m.version);
    });
  }
  return applied;
}

export async function schemaVersion(db: Db): Promise<number> {
  const r = await db.query<{ v: number | null }>("SELECT max(version) AS v FROM schema_migrations");
  return Number(r.rows[0]?.v ?? 0);
}
export const LATEST_SCHEMA_VERSION = Math.max(...MIGRATIONS.map((m) => m.version));
