/** Test databases: PGlite (default, in-process Postgres) or a real Postgres via CHECK_DATABASE_URL. */
import { PGlite } from "@electric-sql/pglite";
import { createPgDb, type Db, type Queryable, type Row } from "../../src/store/db.js";

export async function pgliteDb(): Promise<Db> {
  const pg = await PGlite.create();
  const run = async <T extends Row>(
    q: { query: PGlite["query"]; exec: PGlite["exec"] },
    sql: string,
    params: unknown[] = [],
  ) => {
    if (
      !params.length &&
      sql.includes(";") &&
      sql
        .trim()
        .split(";")
        .filter((s) => s.trim()).length > 1
    ) {
      await q.exec(sql);
      return { rows: [] as T[], rowCount: 0 };
    }
    const r = await q.query<T>(sql, params as unknown[]);
    return { rows: r.rows, rowCount: r.affectedRows || r.rows.length };
  };
  return {
    query: <T extends Row>(sql: string, params?: unknown[]) => run<T>(pg, sql, params),
    tx: <T>(fn: (q: Queryable) => Promise<T>) =>
      pg.transaction(async (tx) =>
        fn({ query: <R extends Row>(sql: string, params?: unknown[]) => run<R>(tx as unknown as PGlite, sql, params) }),
      ),
    close: () => pg.close(),
  };
}

/** Fresh schema per call on a real Postgres (drops and recreates public schema). */
export async function realPgDb(url: string): Promise<Db> {
  const db = createPgDb(url, { max: 12 });
  await db.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  return db;
}

export async function testDb(): Promise<{ db: Db; kind: string }> {
  const url = process.env.CHECK_DATABASE_URL;
  return url ? { db: await realPgDb(url), kind: "postgres" } : { db: await pgliteDb(), kind: "pglite" };
}
