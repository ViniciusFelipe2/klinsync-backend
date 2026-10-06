import type { PGlite } from "@electric-sql/pglite";
import { pgDump } from "@electric-sql/pglite-tools/pg_dump";

export const TABELAS_DO_DUMP = [
  "refresh_tokens", "mfa_fatores", "sala_dispositivos", "eventos_sala_parada", "eventos_giro", "salas", "check_ins",
  "log_acoes_sensiveis", "log_acessos", "rate_limits", "ip_bloqueios", "convites", "usuarios_perfil",
  "tenant_features_historico", "tenant_features", "usuarios", "features", "tenants", "config_seguranca",
];

/** Sessões e contadores de rate limit são efêmeros: não vão para produção (todos entram de novo uma vez). */
const DADOS_EFEMEROS = ["refresh_tokens", "rate_limits"];

/** SQL que substitui os dados do destino pelos deste banco (numa transação). O schema precisa existir antes. */
export async function gerarSqlDeDados(pg: PGlite): Promise<{ sql: string; kb: number }> {
  const arquivo = await pgDump({
    pg,
    args: ["--data-only", "--no-owner", "--no-privileges", ...DADOS_EFEMEROS.map((t) => `--exclude-table-data=${t}`)],
  });
  // O pg_dump 17+ emite parâmetros que o PostgreSQL 16 (Ubuntu 24.04) não conhece: removidos para o dump carregar em 14+.
  const dados = (await arquivo.text()).replace(/^SET transaction_timeout = 0;\r?\n/m, "");
  const sql = [
    "-- KlinSync: dados importados do Supabase. Gerado por `npm run local:dump`.",
    "-- ATENÇÃO: apaga os dados atuais do destino antes de carregar. O schema (migrations) deve estar aplicado.",
    "BEGIN;",
    `TRUNCATE ${TABELAS_DO_DUMP.join(", ")} RESTART IDENTITY CASCADE;`,
    dados,
    "SELECT pg_catalog.set_config('search_path', 'public', false);", // o pg_dump zera o search_path da sessão
    "COMMIT;",
    "",
  ].join("\n");
  return { sql, kb: Math.round(dados.length / 1024) };
}
