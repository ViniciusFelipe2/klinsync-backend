import pg from "pg";

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface Queryable {
  query<T = Row>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}

export interface Db extends Queryable {
  /** Executa `fn` numa transação (COMMIT se resolver, ROLLBACK se lançar). */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /**
   * Escuta um canal LISTEN/NOTIFY do Postgres (entrega entre todos os processos da API). Reconecta sozinho.
   * Devolve a função que encerra a escuta. Ausente em bancos que não suportam (o barramento então entrega só no processo).
   */
  escutar?(canal: string, aoReceber: (payload: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

// DATE (OID 1082) como string "YYYY-MM-DD" (sem deslocamento de fuso) e BIGINT (OID 20) como number.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));

export type OpcoesSsl = { modo: "disable" | "require" | "verify"; ca?: string | undefined };

/** Opção `ssl` do driver pg para cada modo (undefined = sem TLS). */
export function sslDoPg(o: OpcoesSsl | undefined): pg.ClientConfig["ssl"] {
  if (!o || o.modo === "disable") return undefined;
  if (o.modo === "require") return { rejectUnauthorized: false };
  return { rejectUnauthorized: true, ...(o.ca ? { ca: o.ca } : {}) };
}

export function createPgDb(opts: { connectionString: string; max: number; ssl?: OpcoesSsl }): Db {
  const ssl = sslDoPg(opts.ssl);
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    ...(ssl ? { ssl } : {}),
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

  function escutar(canal: string, aoReceber: (payload: string) => void) {
    let encerrado = false;
    let cliente: pg.Client | undefined;
    let espera: NodeJS.Timeout | undefined;
    let tentativa = 0;

    const conectar = async (): Promise<void> => {
      if (encerrado) return;
      const c = new pg.Client({ connectionString: opts.connectionString, keepAlive: true, ...(ssl ? { ssl } : {}) });
      const reconectar = () => {
        if (encerrado || espera) return;
        c.removeAllListeners();
        c.end().catch(() => undefined);
        espera = setTimeout(() => {
          espera = undefined;
          void conectar();
        }, Math.min(30_000, 500 * 2 ** tentativa++));
        espera.unref();
      };
      c.on("error", reconectar);
      c.on("end", reconectar);
      c.on("notification", (m) => {
        if (m.channel === canal && m.payload) aoReceber(m.payload);
      });
      try {
        await c.connect();
        await c.query(`LISTEN ${canal}`);
        cliente = c;
        tentativa = 0;
      } catch {
        reconectar();
      }
    };

    return conectar().then(() => async () => {
      encerrado = true;
      if (espera) clearTimeout(espera);
      await cliente?.end().catch(() => undefined);
    });
  }

  return {
    ...wrap(pool),
    escutar,
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
