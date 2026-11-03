import type { Queryable } from "../db/index.js";

/** Para o admin do hospital: ele precisa saber o motivo para acionar a equipe KlinSync. */
export const MSG_HOSPITAL_INDISPONIVEL =
  "O acesso deste hospital está indisponível devido à desativação da conta. Entre em contato com a equipe KlinSync.";

/** Para operadores: propositalmente vaga, para não gerar especulação entre a equipe do hospital. */
export const MSG_LOGIN_NAO_REALIZADO = "Não foi possível fazer login.";

/** O usuário pertence a um hospital que não está ativo (inativo ou inadimplente)? Master não tem hospital. */
export async function hospitalDoUsuarioDesativado(q: Queryable, userId: string): Promise<boolean> {
  const r = await q.query(
    `SELECT 1 FROM usuarios_perfil p JOIN tenants t ON t.id = p.tenant_id
      WHERE p.id = $1 AND t.status <> 'ativo'`,
    [userId],
  );
  return r.rowCount > 0;
}
