/**
 * Banco de teste local (Postgres embutido, PGlite) em disco, com o schema do klinsync-db.
 * Só para desenvolvimento/validação: em produção o backend usa o PostgreSQL da EC2 de DB.
 */
import { existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { Db, Queryable, Row } from "../src/db/index.js";

const aqui = dirname(fileURLToPath(import.meta.url));
export const RAIZ = resolve(aqui, "..");

/** Prefere as migrations do repositório irmão (fonte da verdade); cai no espelho usado nos testes. */
export function pastaMigrations(): string {
  const irmao = resolve(RAIZ, "..", "klinsync-db", "migrations");
  return existsSync(irmao) ? irmao : join(RAIZ, "test", "db");
}

export type BancoLocal = { pg: PGlite; db: Db; dir: string; novo: boolean };

export async function abrirBancoLocal(dir = process.env["LOCAL_DB_DIR"] ?? join(RAIZ, ".local-db", "dados")): Promise<BancoLocal> {
  mkdirSync(dir, { recursive: true });
  const pg = new PGlite(dir, { parsers: { 1082: (v: string) => v, 20: (v: string) => Number(v) } });
  await pg.waitReady;

  const existe = await pg.query<{ t: string | null }>("SELECT to_regclass('public.tenants')::text AS t");
  const novo = !existe.rows[0]?.t;
  if (novo) {
    const pasta = pastaMigrations();
    for (const f of readdirSync(pasta).filter((x) => x.endsWith(".sql")).sort()) {
      await pg.exec(readFileSync(join(pasta, f), "utf8"));
    }
  }

  const wrap = (c: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }> }): Queryable => ({
    async query<T = Row>(text: string, params: unknown[] = []) {
      const r = await c.query(text, params);
      return { rows: r.rows as T[], rowCount: r.affectedRows && r.affectedRows > 0 ? r.affectedRows : r.rows.length };
    },
  });

  const db: Db = {
    ...wrap(pg as never),
    tx: (fn) => pg.transaction((t) => fn(wrap(t as never))),
    close: () => pg.close(),
  };
  return { pg, db, dir, novo };
}
