/**
 * Gera klinsync-dados.sql com os DADOS do banco local, para carregar no PostgreSQL da EC2 de DB.
 *
 *   npm run local:dump                 # grava klinsync-dados.sql na raiz do backend
 *
 * O arquivo APAGA os dados existentes no destino (TRUNCATE) e carrega os do dump numa transação:
 *   psql -v ON_ERROR_STOP=1 -f klinsync-dados.sql postgresql://klinsync_app:SENHA@HOST/klinsync
 * O schema deve estar aplicado antes (klinsync-db-deploy).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TABELAS_DO_DUMP, gerarSqlDeDados } from "./dump-lib.js";
import { RAIZ, abrirBancoLocal } from "./pglite-local.js";

const banco = await abrirBancoLocal();
try {
  const { sql, kb } = await gerarSqlDeDados(banco.pg);
  const saida = join(RAIZ, "klinsync-dados.sql");
  writeFileSync(saida, sql);
  const contagens = await banco.db.query<{ t: string; n: number }>(
    TABELAS_DO_DUMP.map((t) => `SELECT '${t}' AS t, count(*)::int AS n FROM ${t}`).join(" UNION ALL "),
  );
  console.log(`Dump gravado em ${saida} (${kb} KB de dados)`);
  for (const r of contagens.rows) if (r.n > 0) console.log(`  ${r.t}: ${r.n}`);
} finally {
  await banco.db.close();
}
