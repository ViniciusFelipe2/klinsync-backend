import type { Queryable } from "../db/index.js";
import { notFound, unprocessable } from "../errors.js";

/**
 * Cria ou atualiza uma sala. Na criação, respeita `tenants.limite_salas` (a linha do hospital
 * é travada para impedir que duas criações simultâneas ultrapassem o limite).
 * Deve rodar dentro de uma transação.
 */
export async function salvarSala(
  q: Queryable,
  p: { tenantId: string; id?: string | undefined; nome: string; ativa: boolean; mensagemLimite: (limite: number) => string },
): Promise<void> {
  if (p.id) {
    const r = await q.query("UPDATE salas SET nome = $1, ativa = $2 WHERE id = $3 AND tenant_id = $4", [
      p.nome,
      p.ativa,
      p.id,
      p.tenantId,
    ]);
    if (r.rowCount === 0) throw notFound("Sala não encontrada.");
    return;
  }

  const tenant = (
    await q.query<{ limite_salas: number | null }>("SELECT limite_salas FROM tenants WHERE id = $1 FOR UPDATE", [p.tenantId])
  ).rows[0];
  if (!tenant) throw notFound("Hospital não encontrado.");
  if (tenant.limite_salas != null) {
    const { count } = (
      await q.query<{ count: number }>("SELECT count(*)::int AS count FROM salas WHERE tenant_id = $1", [p.tenantId])
    ).rows[0]!;
    if (count >= tenant.limite_salas) throw unprocessable(p.mensagemLimite(tenant.limite_salas));
  }
  await q.query("INSERT INTO salas (tenant_id, nome, ativa) VALUES ($1, $2, $3)", [p.tenantId, p.nome, p.ativa]);
}
