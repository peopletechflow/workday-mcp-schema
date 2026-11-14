# Database: migrations, roles, dev seed

## Migrations

Single source: `src/store/migrations.ts` (`MIGRATIONS`, numbered 1..n without gaps).

| Version | Name             | What                                                                                                                                                     |
| ------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | `init`           | All runtime tables (replay keys, form sessions, identity links, roles, policies, approvals, commit ledger, encrypted tokens, OAuth states, admin audit). |
| 2       | `expiry_indexes` | Indexes for pruning expired form sessions / OAuth states and for the reconcile query.                                                                    |

Rules:

- Forward only. Each migration runs in its own transaction under advisory lock `727274001`, so parallel migrators (several instances, CLI plus `DB_MIGRATE_ON_START`) serialize and a failing migration leaves no partial objects and no ledger row.
- Ledger `schema_migrations(version, name, applied_at, checksum)`. `checksum` is sha256 of the migration SQL. If an applied migration's SQL changes, `migrate` stops with `DRIFT`. Restore the original text and add a new version.
- A database with a version newer than the code is refused (`AHEAD`). Deploy newer code; never downgrade.
- Upgrade from ledgers written before checksums: the column is added and filled from the current SQL on the first run (status shows `unverified` until then).
- The server refuses to start, and `/readyz` returns 503, unless status is `up_to_date`.
- No automatic down migrations. Rollback policy: take a backup (`pg_dump -Fc`) before `migrate` in shared environments; to undo, restore that backup or ship a new forward migration that reverses the change. Never delete ledger rows by hand.

Commands (box or any machine with the repo built: `pnpm run build` first):

```bash
pnpm db:status                                   # read-only; exit code 2 unless up_to_date
DATABASE_MIGRATION_URL=... pnpm db:migrate       # prints applied versions, [] when nothing to do
pnpm db:export                                   # regenerate db/ SQL after changing migrations or seed
```

`pnpm run check` includes `check:migrations`, which fails when the exported SQL is stale.

psql-only environments use the generated files (no Node needed):

- `db/migrations/NNNN_<name>.sql`: one file per migration, for review.
- `db/psql/migrate.psql`: same ledger, checksums, lock and refusal rules as `pnpm db:migrate`; safe to rerun.
- `db/seed/dev-seed.sql`: the dev seed.

## Roles (least privilege)

`db/psql/bootstrap-local.psql` (hand-written, idempotent, creates only new objects):

- `<owner>` (for example `workday_mcp_owner`): owns the database and `public` schema. Used for migrations and the dev seed (`DATABASE_MIGRATION_URL`).
- `<app>` (for example `workday_mcp_app`): `CONNECT` plus `SELECT/INSERT/UPDATE/DELETE` on tables and sequence usage via default privileges. No DDL, cannot migrate. Used by the runtime (`DATABASE_URL`). It can only read `schema_migrations` (for `/readyz`): the bootstrap creates the ledger as the owner before default privileges apply, and re-runs revoke any write grant on it.
- `PUBLIC` loses all rights on that database and schema. Existing roles, other databases and server settings (`pg_hba.conf`, `postgresql.conf`) are not touched.
- With least-privilege runtime credentials keep `DB_MIGRATE_ON_START=false`; migrate with the owner credentials.

## Dev seed

`pnpm db:seed:dev` (uses `DATABASE_MIGRATION_URL` when set) or psql with `db/seed/dev-seed.sql`.

- Guard in the SQL: the database name must match `^workday_mcp_(dev|test|check)(_[a-z0-9]+)?$`, migrations must be applied, and `oauth_tokens` must be empty. Anything else is refused before a row is written.
- Content (tenant `demo-tenant`, everything marked demo): roles for `demo-alice`, `demo-bob` (commit denied), `demo-manager`; Slack links in state `invited` only (they never resolve, so nobody can act as a demo user); one approval policy; one `rejected` and one `expired` request with `[DEMO]` summaries; one audit row. No tokens, no ledger rows, nothing pending or approved, so nothing can reach Workday.
- Idempotent: rerunning leaves the same counts (role_assignments 3, identity_links 3, approval_policies 1, approval_requests 2, admin_audit 1 on a fresh database).

## Local setup on macOS (Postgres.app)

Data folder (outside any repo): `~/Library/Application Support/workday-mcp/` (mode 700)

- `sql/`: copies of `db/psql/bootstrap-local.psql`, `db/psql/migrate.psql`, `db/seed/dev-seed.sql`.
- `secrets/owner.pw`, `secrets/app.pw`: generated locally with `openssl rand`, mode 600, never printed.
- `local.env` (mode 600): `DATABASE_URL` (app role) and `DATABASE_MIGRATION_URL` (owner role) for `127.0.0.1:5432/workday_mcp_dev`.

```bash
WD="$HOME/Library/Application Support/workday-mcp"; PG=/Applications/Postgres.app/Contents/Versions/latest/bin
umask 077; mkdir -p "$WD/sql" "$WD/secrets"
[ -f "$WD/secrets/owner.pw" ] || openssl rand -base64 24 | tr -d '/+=\n' > "$WD/secrets/owner.pw"
[ -f "$WD/secrets/app.pw" ]   || openssl rand -base64 24 | tr -d '/+=\n' > "$WD/secrets/app.pw"
"$PG/psql" -X -w -v ON_ERROR_STOP=1 -d postgres -v db=workday_mcp_dev -v owner=workday_mcp_owner -v app=workday_mcp_app \
  -v owner_pw_file="$WD/secrets/owner.pw" -v app_pw_file="$WD/secrets/app.pw" -f "$WD/sql/bootstrap-local.psql"
set -a; . "$WD/local.env"; set +a
"$PG/psql" "$DATABASE_MIGRATION_URL" -X -w -v ON_ERROR_STOP=1 -f "$WD/sql/migrate.psql"
"$PG/psql" "$DATABASE_MIGRATION_URL" -X -w -v ON_ERROR_STOP=1 -1 -f "$WD/sql/dev-seed.sql"
```

Postgres.app's default `pg_hba.conf` trusts local connections, so the passwords are not enforced by that server; they matter once the same config points at a server that requires them. The app role's limits (no DDL) hold either way because they are grants, not authentication.

In a checkout, put `DATABASE_URL`, `DATABASE_MIGRATION_URL`, `TOKEN_ENCRYPTION_KEY` and `TOKEN_ENCRYPTION_KEY_ID` in `.env.local` (gitignored); `pnpm dev:serve` and `pnpm admin ...` load it outside production. Without a checkout: `set -a; . "$HOME/Library/Application Support/workday-mcp/local.env"; set +a; pnpm db:status`.
