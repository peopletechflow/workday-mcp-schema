/**
 * Development-only demo seed (docs/DATABASE.md). Idempotent: every row uses a fixed key with
 * ON CONFLICT, so running it again changes nothing. All identities are fictitious and marked
 * DEMO; there are no OAuth tokens, no active Slack links (links stay 'invited', so nobody
 * resolves to these identities), no approved or committing requests, and no ledger rows, so
 * nothing in the seed can lead to a Workday write.
 *
 * Guard (inside the SQL, so psql and the CLI behave the same): refuses unless the database
 * name is on the dev allowlist and the database holds no OAuth tokens.
 * Exported to db/seed/dev-seed.sql by `pnpm db:export`.
 */
import type { Db } from "./db.js";

export const DEV_DB_NAME_PATTERN = "^workday_mcp_(dev|test|check)(_[a-z0-9]+)?$";
export const DEMO_TENANT = "demo-tenant";

export const DEV_SEED_SQL = `
DO $guard$
BEGIN
  IF current_database() !~ '${DEV_DB_NAME_PATTERN}' THEN
    RAISE EXCEPTION 'dev seed refused: database % is not on the dev allowlist (${DEV_DB_NAME_PATTERN})', current_database();
  END IF;
  IF to_regclass('schema_migrations') IS NULL OR (SELECT max(version) FROM schema_migrations) IS NULL THEN
    RAISE EXCEPTION 'dev seed refused: run migrations first';
  END IF;
  IF EXISTS (SELECT 1 FROM oauth_tokens) THEN
    RAISE EXCEPTION 'dev seed refused: database holds OAuth tokens (looks like real use)';
  END IF;
END
$guard$;

INSERT INTO role_assignments (tenant_id, user_id, roles, grants, denies, updated_by) VALUES
  ('${DEMO_TENANT}', 'demo-alice', '{worker_self}', '{}', '{}', 'dev-seed'),
  ('${DEMO_TENANT}', 'demo-bob', '{worker_self}', '{}', '{tool:commit_request_time_off}', 'dev-seed'),
  ('${DEMO_TENANT}', 'demo-manager', '{worker_self,manager}', '{}', '{}', 'dev-seed')
ON CONFLICT (tenant_id, user_id) DO UPDATE SET roles = EXCLUDED.roles, grants = EXCLUDED.grants, denies = EXCLUDED.denies, updated_by = EXCLUDED.updated_by;

INSERT INTO identity_links (slack_team_id, slack_user_id, tenant_id, user_id, status, created_by) VALUES
  ('TDEMO00000', 'UDEMOALICE', '${DEMO_TENANT}', 'demo-alice', 'invited', 'dev-seed'),
  ('TDEMO00000', 'UDEMOBOB00', '${DEMO_TENANT}', 'demo-bob', 'invited', 'dev-seed'),
  ('TDEMO00000', 'UDEMOMGR00', '${DEMO_TENANT}', 'demo-manager', 'invited', 'dev-seed')
ON CONFLICT (slack_team_id, slack_user_id) DO NOTHING;

INSERT INTO approval_policies (tenant_id, commit_tool, approver_user_ids, allow_self_approval, rotate, updated_by) VALUES
  ('${DEMO_TENANT}', 'commit_request_time_off', '{demo-manager}', false, false, 'dev-seed')
ON CONFLICT (tenant_id, commit_tool) DO NOTHING;

INSERT INTO approval_requests (id, tenant_id, requester_user_id, commit_tool, resource, change, change_hash, summary, status, created_at, expires_at, assigned_approvers, decided_by, decided_at, source) VALUES
  ('apr_demo_rejected_000000000001', '${DEMO_TENANT}', 'demo-alice', 'commit_request_time_off', 'worker:demo-alice:self',
   '{"kind":"request_time_off","demo":true,"willSubmit":{"startDate":"2030-01-07","endDate":"2030-01-08","quantity":2,"unit":"Days","timeOffType":{"type":"Time_Off_Type_ID","value":"DEMO_VACATION"}}}',
   'demo-not-a-real-hash-rejected', '[DEMO] Time off vacation 2030-01-07 to 2030-01-08 (2 days)', 'rejected',
   '2030-01-01T09:00:00Z', '2030-01-04T09:00:00Z', '{demo-manager}', 'demo-manager', '2030-01-01T10:00:00Z', 'api'),
  ('apr_demo_expired_0000000000001', '${DEMO_TENANT}', 'demo-alice', 'commit_request_time_off', 'worker:demo-alice:self',
   '{"kind":"request_time_off","demo":true,"willSubmit":{"startDate":"2030-02-04","endDate":"2030-02-04","quantity":1,"unit":"Days","timeOffType":{"type":"Time_Off_Type_ID","value":"DEMO_VACATION"}}}',
   'demo-not-a-real-hash-expired', '[DEMO] Time off vacation 2030-02-04 to 2030-02-04 (1 days)', 'expired',
   '2025-01-01T09:00:00Z', '2025-01-04T09:00:00Z', '{demo-manager}', NULL, NULL, 'api')
ON CONFLICT (id) DO NOTHING;

INSERT INTO admin_audit (actor, action, detail)
SELECT 'dev-seed', 'seed.dev', '{"demo":true,"note":"fictitious demo data"}'
WHERE NOT EXISTS (SELECT 1 FROM admin_audit WHERE actor = 'dev-seed' AND action = 'seed.dev');
`;

/** Apply the dev seed in one transaction. The SQL guard refuses non-dev databases. */
export async function seedDev(db: Db): Promise<void> {
  await db.tx(async (q) => {
    await q.query(DEV_SEED_SQL);
  });
}

export const SEED_TABLES = [
  "role_assignments",
  "identity_links",
  "approval_policies",
  "approval_requests",
  "admin_audit",
] as const;
