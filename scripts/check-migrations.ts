/**
 * Migration and dev-seed checks. PGlite by default; with CHECK_DATABASE_URL (a superuser on a
 * scratch server) it also runs concurrency on real connections, the psql runner
 * (db/psql/migrate.psql) interoperating with the TS runner, the dev seed on an allowlisted
 * database, and the least-privilege bootstrap. Run: pnpm run check:migrations
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createPgDb, type Db } from "../src/store/db.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, MigrationError, checksumOf, migrate, migrationStatus, schemaVersion, type Migration } from "../src/store/migrations.js";
import { SEED_TABLES, seedDev } from "../src/store/seed.js";
import { pgliteDb, realPgDb } from "./lib/test-db.js";

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}
const url = process.env.CHECK_DATABASE_URL;
const fresh = async (): Promise<Db> => (url ? realPgDb(url) : pgliteDb());
const tables = async (db: Db) => (await db.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = current_schema() ORDER BY 1")).rows.map((r) => r.t);
const counts = async (db: Db) => Object.fromEntries(await Promise.all(SEED_TABLES.map(async (t) => [t, Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t}`)).rows[0]!.n)])));
const code = (c: string) => (e: unknown) => e instanceof MigrationError && e.code === c;
console.log(`# database: ${url ? "postgres" : "pglite"}`);

await check("fresh migrate applies 1..latest in order; second run is a no-op; status up_to_date", async () => {
  const db = await fresh();
  assert.equal((await migrationStatus(db)).state, "uninitialized");
  assert.deepEqual(await migrate(db), MIGRATIONS.map((m) => m.version));
  assert.deepEqual(await migrate(db), []);
  const st = await migrationStatus(db);
  assert.equal(st.state, "up_to_date");
  assert.equal(st.current, LATEST_SCHEMA_VERSION);
  assert.ok(st.migrations.every((m) => m.status === "applied"));
  const led = await db.query<{ version: number; checksum: string }>("SELECT version, checksum FROM schema_migrations ORDER BY version");
  assert.deepEqual(led.rows.map((r) => r.checksum), MIGRATIONS.map((m) => checksumOf(m.sql)));
  for (const t of ["approval_requests", "commit_ledger", "identity_links", "oauth_tokens", "schema_migrations"]) assert.ok((await tables(db)).includes(t));
  await db.close();
});

await check("drift: an applied migration whose SQL changed stops migrate and shows in status", async () => {
  const db = await fresh();
  await migrate(db);
  const edited: Migration[] = MIGRATIONS.map((m) => (m.version === 1 ? { ...m, sql: m.sql + "\n-- edited" } : m));
  await assert.rejects(migrate(db, edited), code("DRIFT"));
  assert.equal((await migrationStatus(db, edited)).state, "drift");
  assert.equal((await migrationStatus(db, edited)).migrations[0]!.status, "drift");
  await db.close();
});

await check("bad migration rolls back completely: no partial objects, ledger unchanged, fix-forward works", async () => {
  const db = await fresh();
  await migrate(db);
  const bad: Migration[] = [...MIGRATIONS, { version: LATEST_SCHEMA_VERSION + 1, name: "broken", sql: "CREATE TABLE half_done (id int); SELECT * FROM table_that_does_not_exist;" }];
  await assert.rejects(migrate(db, bad));
  assert.ok(!(await tables(db)).includes("half_done"), "partial DDL survived");
  assert.equal(await schemaVersion(db), LATEST_SCHEMA_VERSION);
  const fixed: Migration[] = [...MIGRATIONS, { version: LATEST_SCHEMA_VERSION + 1, name: "fixed", sql: "CREATE TABLE half_done (id int);" }];
  assert.deepEqual(await migrate(db, fixed), [LATEST_SCHEMA_VERSION + 1]);
  await db.close();
});

await check("ordering and downgrade guards: gaps refused; a database newer than the code is refused", async () => {
  const db = await fresh();
  await assert.rejects(migrate(db, [MIGRATIONS[0]!, { version: 3, name: "gap", sql: "SELECT 1" }]), code("ORDER"));
  await migrate(db);
  await db.query("INSERT INTO schema_migrations (version, name, checksum) VALUES (99, 'future', 'x')");
  await assert.rejects(migrate(db), code("AHEAD"));
  assert.equal((await migrationStatus(db)).state, "ahead");
  await db.close();
});

await check("upgrade from the previous ledger (v1 applied, no checksum column): backfills checksum, applies v2, keeps data", async () => {
  const db = await fresh();
  await db.query("CREATE TABLE schema_migrations (version int PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
  await db.query(MIGRATIONS[0]!.sql);
  await db.query("INSERT INTO schema_migrations (version, name) VALUES (1, 'init')");
  await db.query("INSERT INTO admin_audit (actor, action, detail) VALUES ('old', 'kept', '{}')");
  const before = await migrationStatus(db);
  assert.equal(before.migrations[0]!.status, "unverified");
  assert.equal(before.state, "pending");
  assert.deepEqual(await migrate(db), MIGRATIONS.slice(1).map((m) => m.version));
  const st = await migrationStatus(db);
  assert.equal(st.state, "up_to_date");
  assert.ok(st.migrations.every((m) => m.status === "applied"));
  assert.equal((await db.query("SELECT 1 FROM admin_audit WHERE actor = 'old'")).rows.length, 1);
  await db.close();
});

await check("concurrent migrators serialize: every migration applied exactly once", async () => {
  const db = await fresh();
  const others = url ? [db, createPgDb(url, { max: 2 }), createPgDb(url, { max: 2 }), createPgDb(url, { max: 2 })] : [db, db, db, db];
  const results = await Promise.all(others.map((d) => migrate(d)));
  assert.deepEqual(results.flat().sort(), MIGRATIONS.map((m) => m.version));
  assert.equal((await db.query("SELECT 1 FROM schema_migrations")).rows.length, LATEST_SCHEMA_VERSION);
  for (const d of new Set(others)) await d.close();
});

await check("dev seed refuses a database that is not on the dev allowlist, and an unmigrated one", async () => {
  const db = await fresh(); // 'postgres' / scratch name: not allowlisted
  await migrate(db);
  await assert.rejects(seedDev(db), /dev seed refused: database .* not on the dev allowlist/);
  assert.equal((await db.query("SELECT 1 FROM role_assignments")).rows.length, 0);
  await db.close();
});

if (url && psqlAvailable()) {
  const admin = createPgDb(url, { max: 1 });
  const dbName = "workday_mcp_check";
  const owner = `wdmcp_owner_${randomBytes(3).toString("hex")}`;
  const app = `wdmcp_app_${randomBytes(3).toString("hex")}`;
  const u = new URL(url);
  const dir = mkdtempSync(join(tmpdir(), "wdmcp-"));
  const ownerPw = randomBytes(18).toString("base64url");
  const appPw = randomBytes(18).toString("base64url");
  writeFileSync(join(dir, "owner.pw"), ownerPw, { mode: 0o600 });
  writeFileSync(join(dir, "app.pw"), appPw, { mode: 0o600 });
  const asRole = (role: string, pw: string) => { const x = new URL(url); x.username = role; x.password = pw; x.pathname = `/${dbName}`; return x.toString(); };
  const psql = (target: string, args: string[]) => execFileSync("psql", [target, "-X", "-q", "-v", "ON_ERROR_STOP=1", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    const adminPostgres = new URL(url); adminPostgres.pathname = "/postgres";

    await check("bootstrap creates owner + app roles and a locked-down database; re-run leaves them unchanged", async () => {
      for (let i = 0; i < 2; i++) {
        psql(adminPostgres.toString(), ["-v", `db=${dbName}`, "-v", `owner=${owner}`, "-v", `app=${app}`, "-v", `owner_pw_file=${join(dir, "owner.pw")}`, "-v", `app_pw_file=${join(dir, "app.pw")}`, "-f", "db/psql/bootstrap-local.psql"]);
      }
      const r = await admin.query<{ rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean }>("SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = ANY($1)", [[owner, app]]);
      assert.equal(r.rows.length, 2);
      assert.ok(r.rows.every((x) => !x.rolsuper && !x.rolcreaterole && !x.rolcreatedb));
    });

    await check("psql runner applies the same ledger as the TS runner; re-run no-op; TS runner sees up_to_date", async () => {
      const out1 = psql(asRole(owner, ownerPw), ["-f", "db/psql/migrate.psql"]);
      assert.match(out1, /migration 1 init: applied/);
      const out2 = psql(asRole(owner, ownerPw), ["-f", "db/psql/migrate.psql"]);
      assert.match(out2, /migration 2 expiry_indexes: already applied/);
      const ownerDb = createPgDb(asRole(owner, ownerPw), { max: 1 });
      assert.equal((await migrationStatus(ownerDb)).state, "up_to_date");
      assert.deepEqual(await migrate(ownerDb), []);
      await ownerDb.close();
      assert.ok(!out1.includes(ownerPw) && !out2.includes(ownerPw));
    });

    await check("psql runner refuses drift", async () => {
      const ownerDb = createPgDb(asRole(owner, ownerPw), { max: 1 });
      await ownerDb.query("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 2");
      assert.throws(() => psql(asRole(owner, ownerPw), ["-f", "db/psql/migrate.psql"]), /checksum drift/);
      await ownerDb.query("UPDATE schema_migrations SET checksum = $1 WHERE version = 2", [checksumOf(MIGRATIONS[1]!.sql)]);
      await ownerDb.close();
    });

    await check("dev seed on the allowlisted database: twice via psql and CLI path, stable counts, no tokens/active links/approvable requests", async () => {
      psql(asRole(owner, ownerPw), ["-1", "-f", "db/seed/dev-seed.sql"]);
      const ownerDb = createPgDb(asRole(owner, ownerPw), { max: 1 });
      const c1 = await counts(ownerDb);
      await seedDev(ownerDb);
      psql(asRole(owner, ownerPw), ["-1", "-f", "db/seed/dev-seed.sql"]);
      assert.deepEqual(await counts(ownerDb), c1);
      assert.deepEqual(c1, { role_assignments: 3, identity_links: 3, approval_policies: 1, approval_requests: 2, admin_audit: 1 });
      assert.equal((await ownerDb.query("SELECT 1 FROM oauth_tokens")).rows.length, 0);
      assert.equal((await ownerDb.query("SELECT 1 FROM identity_links WHERE status = 'active'")).rows.length, 0);
      assert.equal((await ownerDb.query("SELECT 1 FROM approval_requests WHERE status IN ('pending','approved','committing','unknown')")).rows.length, 0);
      assert.equal((await ownerDb.query("SELECT 1 FROM commit_ledger")).rows.length, 0);
      assert.ok((await ownerDb.query<{ s: string }>("SELECT summary AS s FROM approval_requests")).rows.every((r) => r.s.startsWith("[DEMO]")));
      await ownerDb.close();
    });

    psql(adminPostgres.toString(), ["-v", `db=${dbName}`, "-v", `owner=${owner}`, "-v", `app=${app}`, "-v", `owner_pw_file=${join(dir, "owner.pw")}`, "-v", `app_pw_file=${join(dir, "app.pw")}`, "-f", "db/psql/bootstrap-local.psql"]);
    await check("app role: row reads/writes allowed; DDL, migrations and ledger writes refused (also after a bootstrap re-run)", async () => {
      const appDb = createPgDb(asRole(app, appPw), { max: 1 });
      assert.equal((await appDb.query("SELECT count(*) FROM approval_requests")).rows.length, 1);
      await appDb.query("INSERT INTO slack_replay (key, expires_at) VALUES ('app-role-check', now())");
      await appDb.query("DELETE FROM slack_replay WHERE key = 'app-role-check'");
      await assert.rejects(appDb.query("CREATE TABLE app_should_not (id int)"), /permission denied/);
      await assert.rejects(appDb.query("DROP TABLE approval_requests"), /must be owner|permission denied/);
      await assert.rejects(migrate(appDb, [...MIGRATIONS, { version: LATEST_SCHEMA_VERSION + 1, name: "x", sql: "CREATE TABLE x (id int)" }]), /permission denied/);
      await assert.rejects(appDb.query("INSERT INTO schema_migrations (version, name) VALUES (99, 'x')"), /permission denied/);
      await assert.rejects(appDb.query("UPDATE schema_migrations SET checksum = 'x'"), /permission denied/);
      await assert.rejects(appDb.query("DELETE FROM schema_migrations"), /permission denied/);
      assert.equal((await migrationStatus(appDb)).state, "up_to_date", "app role can read status for readyz");
      await appDb.close();
    });
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${owner}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${app}`).catch(() => {});
    await admin.close();
    rmSync(dir, { recursive: true, force: true });
    void u;
  }
} else {
  console.log("# skipped psql/bootstrap/seed-count checks (need CHECK_DATABASE_URL and psql)");
}

function psqlAvailable(): boolean {
  try {
    execFileSync("psql", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

console.log(`\n${passed} migration checks passed (${url ? "postgres" : "pglite"})`);
