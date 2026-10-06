import { abrirBancoLocal } from "./pglite-local.js";

const banco = await abrirBancoLocal();
try {
  const q = async <T extends object>(sql: string) => (await banco.db.query<T>(sql)).rows;
  console.log("Hospitais:");
  for (const t of await q<{ nome: string; status: string; limite_salas: number | null }>("SELECT nome, status, limite_salas FROM tenants")) console.log(`  ${t.nome} (${t.status}, limite de salas: ${t.limite_salas ?? "sem limite"})`);
  console.log("Usuários:");
  for (const u of await q<{ email: string; role: string; ativo: boolean; hospital: string | null; hash: string }>(
    `SELECT p.email, p.role::text AS role, p.ativo, t.nome AS hospital, CASE WHEN u.senha_hash LIKE '$2%' THEN 'bcrypt (troca no 1º login)' WHEN u.senha_hash = '!' THEN 'SEM SENHA' ELSE 'scrypt' END AS hash
       FROM usuarios_perfil p JOIN usuarios u ON u.id = p.id LEFT JOIN tenants t ON t.id = p.tenant_id ORDER BY p.role, p.email`,
  )) console.log(`  ${u.email}  [${u.role}]${u.hospital ? ` ${u.hospital}` : ""}  ${u.ativo ? "ativo" : "DESATIVADO"}  senha: ${u.hash}`);
  const n = async (t: string) => (await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`))[0]!.n;
  console.log("Registros:", Object.fromEntries(await Promise.all(["salas", "eventos_giro", "eventos_sala_parada", "check_ins", "log_acessos", "log_acoes_sensiveis", "sala_dispositivos", "tenant_features"].map(async (t) => [t, await n(t)] as const))));
  const periodo = (await q<{ de: string; ate: string }>("SELECT min(inicio)::date::text AS de, max(inicio)::date::text AS ate FROM eventos_giro"))[0]!;
  console.log(`Histórico de giro: ${periodo.de} a ${periodo.ate}`);
  const orf = (await q<{ n: number }>("SELECT count(*)::int AS n FROM salas s WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = s.tenant_id)"))[0]!.n;
  console.log(`Integridade: salas sem hospital = ${orf}`);
} finally {
  await banco.db.close();
}
