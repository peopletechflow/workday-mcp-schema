/**
 * Forward-only, versioned schema migrations (docs/DATABASE.md).
 *
 * - Ordered integer versions; each migration runs in its own transaction under a shared
 *   advisory lock, so concurrent migrators (several app instances, CLI + boot) serialize.
 * - The ledger `schema_migrations` stores name and a sha256 checksum of the SQL. A changed
 *   SQL text for an applied version is drift and stops `migrate` (fix forward with a new
 *   version instead). Ledgers written before checksums existed are backfilled once.
 * - A database with versions newer than this code is refused (no silent downgrade).
 * - No automatic down migrations. Rollback = restore a backup or ship a new forward version.
 * - The same SQL is exported to db/migrations/*.sql and db/psql/migrate.psql
 *   (`pnpm db:export`) for environments that apply migrations with psql only.
 */
import { createHash } from "node:crypto";
import type { Db, Queryable } from "./db.js";

export type Migration = { version: number; name: string; sql: string };

export const MIGRATIONS: Migration[] = [
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
  {
    version: 2,
    name: "expiry_indexes",
    sql: `
CREATE INDEX IF NOT EXISTS form_sessions_exp ON form_sessions (expires_at);
CREATE INDEX IF NOT EXISTS oauth_states_exp ON oauth_states (expires_at);
CREATE INDEX IF NOT EXISTS approval_requests_reconcile ON approval_requests (status, updated_at) WHERE status IN ('committing','unknown');
`,
  },
];

export const MIGRATION_LOCK_KEY = 727274001;
export const LATEST_SCHEMA_VERSION = Math.max(...MIGRATIONS.map((m) => m.version));

export const checksumOf = (sql: string): string => createHash("sha256").update(sql, "utf8").digest("hex");

export class MigrationError extends Error {
  constructor(readonly code: "DRIFT" | "AHEAD" | "ORDER", message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

export const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version int PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  checksum text
);
ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text;`;

function assertOrdered(list: readonly Migration[]): void {
  list.forEach((m, i) => {
    if (m.version !== i + 1) throw new MigrationError("ORDER", `Migrations must be numbered 1..n without gaps (found ${m.version} at position ${i + 1}).`);
  });
}

type LedgerRow = { version: number; name: string; checksum: string | null; applied_at: unknown };

async function ledger(q: Queryable): Promise<LedgerRow[]> {
  const r = await q.query<LedgerRow>("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version");
  return r.rows.map((x) => ({ ...x, version: Number(x.version) }));
}

function checkLedger(rows: LedgerRow[], list: readonly Migration[]): void {
  const latest = list.length;
  const ahead = rows.filter((r) => r.version > latest);
  if (ahead.length) throw new MigrationError("AHEAD", `Database has migration(s) ${ahead.map((r) => r.version).join(",")} newer than this code (latest ${latest}). Deploy the newer code; never downgrade the schema.`);
  for (const r of rows) {
    const m = list[r.version - 1]!;
    if (r.checksum !== null && r.checksum !== checksumOf(m.sql)) {
      throw new MigrationError("DRIFT", `Migration ${r.version} (${m.name}) changed after it was applied (checksum mismatch). Restore the original SQL and add a new forward migration.`);
    }
  }
}

/**
 * Apply pending migrations. Returns the versions applied by this call ([] when up to date).
 * Throws MigrationError on drift, a newer database, or a malformed list; a failing migration
 * rolls back completely and leaves the ledger unchanged.
 */
export async function migrate(db: Db, list: readonly Migration[] = MIGRATIONS): Promise<number[]> {
  assertOrdered(list);
  await db.tx(async (q) => {
    await q.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
    await q.query(LEDGER_DDL);
    const rows = await ledger(q);
    checkLedger(rows, list);
    // Ledgers from before checksums: record the current checksum once (trust on first upgrade).
    for (const r of rows) if (r.checksum === null) await q.query("UPDATE schema_migrations SET checksum = $2 WHERE version = $1 AND checksum IS NULL", [r.version, checksumOf(list[r.version - 1]!.sql)]);
  });
  const applied: number[] = [];
  for (const m of list) {
    await db.tx(async (q) => {
      await q.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
      const done = await q.query<{ checksum: string | null }>("SELECT checksum FROM schema_migrations WHERE version = $1", [m.version]);
      if (done.rows.length) {
        if (done.rows[0]!.checksum !== checksumOf(m.sql)) throw new MigrationError("DRIFT", `Migration ${m.version} (${m.name}) checksum mismatch.`);
        return;
      }
      await q.query(m.sql);
      await q.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [m.version, m.name, checksumOf(m.sql)]);
      applied.push(m.version);
    });
  }
  return applied;
}

export type MigrationStatus = {
  current: number;
  latest: number;
  state: "up_to_date" | "pending" | "drift" | "ahead" | "uninitialized";
  migrations: Array<{ version: number; name: string; status: "applied" | "pending" | "drift" | "unverified"; appliedAt?: string }>;
  problem?: string;
};

/** Read-only status: per-version applied / pending / drift. Never writes. */
export async function migrationStatus(db: Queryable, list: readonly Migration[] = MIGRATIONS): Promise<MigrationStatus> {
  const exists = await db.query<{ t: string | null }>("SELECT to_regclass('schema_migrations')::text AS t");
  const latest = list.length;
  if (!exists.rows[0]?.t) return { current: 0, latest, state: "uninitialized", migrations: list.map((m) => ({ version: m.version, name: m.name, status: "pending" })) };
  const hasChecksum = await db.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'schema_migrations' AND column_name = 'checksum' AND table_schema = current_schema()");
  const rows = hasChecksum.rows.length
    ? await ledger(db)
    : (await db.query<LedgerRow>("SELECT version, name, NULL::text AS checksum, applied_at FROM schema_migrations ORDER BY version")).rows.map((x) => ({ ...x, version: Number(x.version) }));
  const byVersion = new Map(rows.map((r) => [r.version, r]));
  const migrations = list.map((m) => {
    const r = byVersion.get(m.version);
    if (!r) return { version: m.version, name: m.name, status: "pending" as const };
    const status = r.checksum === null ? ("unverified" as const) : r.checksum === checksumOf(m.sql) ? ("applied" as const) : ("drift" as const);
    return { version: m.version, name: m.name, status, appliedAt: (r.applied_at instanceof Date ? r.applied_at : new Date(String(r.applied_at))).toISOString() };
  });
  const current = rows.length ? Math.max(...rows.map((r) => r.version)) : 0;
  const ahead = rows.filter((r) => r.version > latest).map((r) => r.version);
  const state = ahead.length ? "ahead" : migrations.some((m) => m.status === "drift") ? "drift" : migrations.some((m) => m.status === "pending") ? "pending" : "up_to_date";
  return { current, latest, state, migrations, ...(ahead.length ? { problem: `database has newer migration(s) ${ahead.join(",")}` } : {}) };
}

/** Highest applied version (0 when the ledger does not exist yet). */
export async function schemaVersion(db: Queryable): Promise<number> {
  const exists = await db.query<{ t: string | null }>("SELECT to_regclass('schema_migrations')::text AS t");
  if (!exists.rows[0]?.t) return 0;
  const r = await db.query<{ v: number | null }>("SELECT max(version) AS v FROM schema_migrations");
  return Number(r.rows[0]?.v ?? 0);
}
