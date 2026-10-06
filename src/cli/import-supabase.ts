/**
 * Importa os dados do Supabase (projeto mãe) para o banco do KlinSync.
 *
 *   node --env-file=/etc/klinsync/backend.env dist/cli/import-supabase.js --dry-run
 *   node --env-file=/etc/klinsync/backend.env dist/cli/import-supabase.js --fotos
 *
 * Variáveis (além das do backend: DATABASE_URL, JWT_*, MFA_ENCRYPTION_KEY, CHECKIN_PHOTOS_BUCKET...):
 *   SUPABASE_DB_URL            string de conexão Postgres do Supabase (somente leitura; nada é alterado lá)
 *   SUPABASE_DB_SSL=false      desliga o SSL (padrão: ligado fora de localhost)
 *   SUPABASE_URL               https://<projeto>.supabase.co          (só para --fotos)
 *   SUPABASE_SERVICE_ROLE_KEY  chave service_role                      (só para --fotos)
 *
 * Opções:
 *   --dry-run          executa tudo e desfaz no final (valida os dados sem gravar)
 *   --limpar-destino   apaga TODOS os dados do destino antes de importar
 *   --fotos            depois do banco, copia as fotos do Storage do Supabase para o S3
 *   --so-fotos         só copia as fotos (banco já importado)
 *   --bucket-origem    bucket do Storage do Supabase (padrão: checkin-fotos)
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createPgDb } from "../db/index.js";
import { conectarOrigem, criarBaixador } from "../migracao/origem.js";
import { copiarFotos, importarDoSupabase } from "../migracao/supabase.js";
import { criarStorageS3 } from "../services/storage.js";

async function main() {
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
  const config = loadConfig();
  const destino = createPgDb({ connectionString: config.DATABASE_URL, max: 4 });
  let fecharOrigem: (() => Promise<void>) | undefined;

  try {
    if (!values["so-fotos"]) {
      const urlOrigem = process.env["SUPABASE_DB_URL"];
      if (!urlOrigem) throw new Error("Defina SUPABASE_DB_URL (string de conexão Postgres do Supabase).");
      const c = conectarOrigem(urlOrigem);
      fecharOrigem = c.fechar;

      log(values["dry-run"] ? "Simulação (nada será gravado):" : "Importando do Supabase:");
      const rel = await importarDoSupabase(c.origem, destino, config, {
        dryRun: !!values["dry-run"],
        limparDestino: !!values["limpar-destino"],
        log,
      });
      if (rel.avisos.length) {
        console.log(`\nAvisos (${rel.avisos.length}):`);
        for (const a of rel.avisos.slice(0, 50)) console.log(`  - ${a}`);
        if (rel.avisos.length > 50) console.log(`  ... e mais ${rel.avisos.length - 50}`);
      }
      console.log(rel.dryRun ? "\nSimulação concluída: nada foi gravado." : "\nImportação concluída.");
    }

    if (values.fotos || values["so-fotos"]) {
      if (values["dry-run"]) {
        log("(--dry-run: as fotos não são copiadas)");
      } else {
        const base = process.env["SUPABASE_URL"]?.replace(/\/+$/, "");
        const chave = process.env["SUPABASE_SERVICE_ROLE_KEY"];
        if (!base || !chave) throw new Error("Para copiar as fotos defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.");
        if (!config.CHECKIN_PHOTOS_BUCKET) throw new Error("Defina CHECKIN_PHOTOS_BUCKET (bucket S3 de destino das fotos).");
        const bucket = values["bucket-origem"] ?? "checkin-fotos";

        log(`\nCopiando fotos de ${bucket} (Supabase) para s3://${config.CHECKIN_PHOTOS_BUCKET}:`);
        const rel = await copiarFotos(destino, {
          storage: criarStorageS3(config),
          log,
          baixar: criarBaixador({ baseUrl: base, chave, bucket }),
        });
        console.log(`Fotos: ${rel.copiadas}/${rel.total} copiadas, ${rel.ausentes.length} ausentes no Storage, ${rel.falhas.length} com falha.`);
        if (rel.ausentes.length || rel.falhas.length) {
          writeFileSync("fotos-pendentes.txt", [...rel.ausentes.map((c) => `AUSENTE ${c}`), ...rel.falhas.map((c) => `FALHA ${c}`)].join("\n") + "\n");
          console.log("Lista gravada em fotos-pendentes.txt (rode de novo com --so-fotos para tentar as falhas).");
        }
      }
    }
  } finally {
    await fecharOrigem?.();
    await destino.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
