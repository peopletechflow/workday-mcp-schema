/**
 * Minimal SQL abstraction over PostgreSQL. Production uses `pg` (node-postgres) Pool.
 * Offline checks use PGlite (real Postgres compiled to WASM) through the same interface,
 * so SQL, constraints, and row locks are exercised for real.
 */
import pg from "pg";

export type Row = Record<string, unknown>;
export interface Queryable {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}
export interface Db extends Queryable {
  /** Run fn in a transaction (BEGIN ... COMMIT, ROLLBACK on throw). */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createPgDb(connectionString: string, opts: { max?: number; statementTimeoutMs?: number } = {}): Db {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    statement_timeout: opts.statementTimeoutMs ?? 10_000,
    // Bound transactions that wait on the network while holding row locks (e.g. token refresh).
    idle_in_transaction_session_timeout: 30_000,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  return {
    async query<T extends Row>(sql: string, params: unknown[] = []) {
      const r = await pool.query(sql, params);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
    },
    async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const q: Queryable = {
          async query<R extends Row>(sql: string, params: unknown[] = []) {
            const r = await client.query(sql, params);
            return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
          },
        };
        const out = await fn(q);
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
