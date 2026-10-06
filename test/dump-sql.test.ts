import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { TABELAS_DO_DUMP, gerarSqlDeDados } from "../tools/dump-lib.js";
import { importarDoSupabase } from "../src/migracao/supabase.js";
import { configDeTeste, criarBancoDeTeste } from "./helpers.js";

const aqui = dirname(fileURLToPath(import.meta.url));

describe("dump SQL dos dados importados", () => {
  it("ida e volta: o .sql gerado recria exatamente os mesmos dados num banco novo (já com seed)", async () => {
    // origem "Supabase" de mentira (mesmo fixture do teste de importação)
    const origem = new PGlite({ parsers: { 1082: (v: string) => v, 20: (v: string) => Number(v) } });
    await origem.exec(readFileSync(join(aqui, "fixtures", "supabase-source.sql"), "utf8"));
    await origem.exec(`
      INSERT INTO tenants (id, nome, status) VALUES ('11111111-1111-4111-8111-111111111111','H1','ativo');
      INSERT INTO features (id, chave, nome_exibicao) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','giro_de_sala','Giro');
      INSERT INTO auth.users (id, email, encrypted_password) VALUES ('00000000-0000-4000-8000-000000000001','m@x.com','$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012');
      INSERT INTO usuarios_perfil (id, nome, role) VALUES ('00000000-0000-4000-8000-000000000001','Master','master_admin');
      INSERT INTO log_acoes_sensiveis (id, acao, detalhes) VALUES (gen_random_uuid(),'x','{"a":"ç ã \\"aspas\\" e '' apóstrofo"}');
      INSERT INTO config_seguranca (id, max_tentativas) VALUES (true, 9);`);
    const comoQ = {
      async query(t: string, p: unknown[] = []) {
        const r = await origem.query(t, p);
        return { rows: r.rows as never[], rowCount: r.rows.length };
      },
    };

    const staging = await criarBancoDeTeste();
    await importarDoSupabase(comoQ, staging, configDeTeste());
    // gerarSqlDeDados precisa do PGlite cru: o banco de teste expõe só a interface Db, então usamos um novo
    const pgStaging = new PGlite();
    for (const f of ["0001_schema.sql", "0002_seed.sql"]) await pgStaging.exec(readFileSync(join(aqui, "db", f), "utf8"));
    // repete a importação direto no PGlite cru
    const wrap = (c: PGlite) => ({
      async query<T>(t: string, p: unknown[] = []) {
        const r = await c.query(t, p);
        return { rows: r.rows as T[], rowCount: r.affectedRows && r.affectedRows > 0 ? r.affectedRows : r.rows.length };
      },
    });
    const dbStaging = { ...wrap(pgStaging), tx: (fn: never) => pgStaging.transaction((t) => (fn as (q: unknown) => Promise<unknown>)(wrap(t as never))), close: async () => undefined };
    await importarDoSupabase(comoQ, dbStaging as never, configDeTeste());

    const { sql } = await gerarSqlDeDados(pgStaging);
    expect(sql).toMatch(/^-- KlinSync/);
    expect(sql).toContain("TRUNCATE");
    expect(sql).not.toContain("transaction_timeout"); // parâmetro do PG 17+, quebraria no PG 16
    expect(sql).not.toMatch(/INSERT INTO public.(refresh_tokens|rate_limits)/); // dados efêmeros não migram

    // destino novo: schema + seed (features com ids DIFERENTES), como na EC2 recém-migrada
    const destino = new PGlite();
    for (const f of ["0001_schema.sql", "0002_seed.sql"]) await destino.exec(readFileSync(join(aqui, "db", f), "utf8"));
    await destino.exec(sql);

    for (const t of TABELAS_DO_DUMP) {
      const a = (await pgStaging.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]!.n;
      const b = (await destino.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]!.n;
      expect({ t, n: b }).toEqual({ t, n: a });
    }
    const f = await destino.query<{ id: string }>("SELECT id FROM features WHERE chave = 'giro_de_sala'");
    expect(f.rows[0]!.id).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"); // id do Supabase, não o do seed
    const acao = await destino.query<{ detalhes: { a: string } }>("SELECT detalhes FROM log_acoes_sensiveis WHERE acao = 'x'");
    expect(acao.rows[0]!.detalhes.a).toBe("ç ã \"aspas\" e ' apóstrofo"); // acentos e aspas sobrevivem
    expect((await destino.query<{ m: number }>("SELECT max_tentativas AS m FROM config_seguranca")).rows[0]!.m).toBe(9);

    await Promise.all([origem.close(), staging.close(), pgStaging.close(), destino.close()]);
  });
});
