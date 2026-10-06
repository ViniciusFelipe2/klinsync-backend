/**
 * Importa o Supabase para o banco de teste LOCAL (em disco) e valida.
 *
 *   npm run local:import -- --dry-run
 *   npm run local:import -- --limpar-destino --fotos
 *
 * Lê SUPABASE_DB_URL (e, para fotos, SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) de .env.import.
 * Opções: --dry-run, --limpar-destino, --fotos, --so-fotos, --bucket-origem <nome>
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { conectarOrigem, criarBaixador } from "../src/migracao/origem.js";
import { copiarFotos, importarDoSupabase } from "../src/migracao/supabase.js";
import { criarStorageS3 } from "../src/services/storage.js";
import { abrirBancoLocal } from "./pglite-local.js";
import { segredosLocais } from "./segredos.js";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean" },
    "limpar-destino": { type: "boolean" },
    fotos: { type: "boolean" },
    "so-fotos": { type: "boolean" },
    "bucket-origem": { type: "string" },
  },
});
const log = (m: string) => console.log(m);

const { jwtAccess, jwtRefresh } = segredosLocais();
const config = loadConfig({
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://local/local",
  JWT_ACCESS_SECRET: jwtAccess,
  JWT_REFRESH_SECRET: jwtRefresh,
  CHECKIN_PHOTOS_BUCKET: process.env["CHECKIN_PHOTOS_BUCKET"] ?? "",
  AWS_REGION: process.env["AWS_REGION"] ?? "us-east-2",
});

const banco = await abrirBancoLocal();
let fechar: (() => Promise<void>) | undefined;
try {
  if (!values["so-fotos"]) {
    const url = process.env["SUPABASE_DB_URL"];
    if (!url) throw new Error("Defina SUPABASE_DB_URL no arquivo .env.import");
    const c = conectarOrigem(url);
    fechar = c.fechar;
    log(values["dry-run"] ? "Simulação no banco local (nada será gravado):" : "Importando do Supabase para o banco local:");
    const rel = await importarDoSupabase(c.origem, banco.db, config, { dryRun: !!values["dry-run"], limparDestino: !!values["limpar-destino"], log });
    if (rel.avisos.length) {
      console.log(`\nAvisos (${rel.avisos.length}):`);
      for (const a of rel.avisos.slice(0, 60)) console.log(`  - ${a}`);
      if (rel.avisos.length > 60) console.log(`  ... e mais ${rel.avisos.length - 60}`);
    }
    console.log(rel.dryRun ? "\nSimulação concluída: nada foi gravado." : "\nImportação concluída.");
  }

  if ((values.fotos || values["so-fotos"]) && !values["dry-run"]) {
    const base = process.env["SUPABASE_URL"];
    const chave = process.env["SUPABASE_SERVICE_ROLE_KEY"];
    if (!base || !chave) throw new Error("Para as fotos defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env.import");
    if (!config.CHECKIN_PHOTOS_BUCKET) throw new Error("Defina CHECKIN_PHOTOS_BUCKET (ex.: klinsync-checkin-fotos)");
    log(`\nCopiando fotos para s3://${config.CHECKIN_PHOTOS_BUCKET}:`);
    const rel = await copiarFotos(banco.db, {
      storage: criarStorageS3(config),
      log,
      baixar: criarBaixador({ baseUrl: base, chave, bucket: values["bucket-origem"] ?? "checkin-fotos" }),
    });
    console.log(`Fotos: ${rel.copiadas}/${rel.total} copiadas, ${rel.ausentes.length} ausentes no Storage, ${rel.falhas.length} com falha.`);
    if (rel.ausentes.length) console.log(`  ausentes (primeiras): ${rel.ausentes.slice(0, 5).join(", ")}`);
    if (rel.falhas.length) console.log(`  falhas (primeiras): ${rel.falhas.slice(0, 5).join(", ")}`);
  }
} finally {
  await fechar?.();
  await banco.db.close();
}
