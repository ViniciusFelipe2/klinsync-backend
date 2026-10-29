import type { Queryable } from "../db/index.js";
import { forbidden } from "../errors.js";
import { escopoTenant, type Perfil } from "./perfil.js";

export type ChaveModulo = "checkin_cirurgioes" | "giro_de_sala";

/**
 * Mesma regra de `/modulos/acesso`, aplicada em cada rota do módulo (e não só na tela):
 * hospital ativo, feature habilitada e, para operador, login vinculado àquela feature.
 * Master (suporte) passa sem vínculo com hospital.
 */
export async function exigirModulo(
  q: Queryable,
  userId: string,
  chave: ChaveModulo,
): Promise<{ perfil: Perfil; tenantId: string | null }> {
  const escopo = await escopoTenant(q, userId);
  const { perfil, tenantId } = escopo;
  if (perfil.role === "master_admin") return escopo;

  const r = await q.query<{ feature_id: string; habilitada: boolean; status: string }>(
    `SELECT f.id AS feature_id, COALESCE(tf.habilitada, false) AS habilitada, t.status
       FROM features f
       JOIN tenants t ON t.id = $1
       LEFT JOIN tenant_features tf ON tf.feature_id = f.id AND tf.tenant_id = t.id
      WHERE f.chave = $2`,
    [tenantId, chave],
  );
  const l = r.rows[0];
  const negado = () => forbidden("Seu acesso a este módulo não está liberado.");
  if (!l || l.status !== "ativo" || !l.habilitada) throw negado();
  if (perfil.role === "operador" && perfil.feature_id !== l.feature_id) throw negado();
  return escopo;
}
