import pg from "pg";

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface Queryable {
  query<T = Row>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}

export interface Db extends Queryable {
  /** Executa `fn` numa transação (COMMIT se resolver, ROLLBACK se lançar). */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// DATE (OID 1082) como string "YYYY-MM-DD" (sem deslocamento de fuso) e BIGINT (OID 20) como number.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));

export function createPgDb(opts: { connectionString: string; max: number }): Db {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on("error", (err) => console.error("[db] erro em conexão ociosa:", err.message));

  const wrap = (c: { query: pg.Pool["query"] }): Queryable => ({
    async query<T = Row>(text: string, params: unknown[] = []) {
      const r = await c.query(text, params as unknown[]);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? r.rows.length };
    },
  });

  return {
    ...wrap(pool),
    async tx<T>(fn: (q: Queryable) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(wrap(client as unknown as { query: pg.Pool["query"] }));
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
