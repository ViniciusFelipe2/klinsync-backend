import type { Queryable } from "../db/index.js";

/** Registra uma ação sensível (trilha de auditoria exibida no painel master). */
export async function registrarAcao(
  q: Queryable,
  usuarioId: string | null,
  acao: string,
  detalhes: Record<string, unknown> = {},
): Promise<void> {
  await q.query("INSERT INTO log_acoes_sensiveis (usuario_id, acao, detalhes) VALUES ($1, $2, $3::jsonb)", [
    usuarioId,
    acao,
    JSON.stringify(detalhes),
  ]);
}
