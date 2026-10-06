import type { Queryable } from "../db/index.js";
import { forbidden, unauthorized } from "../errors.js";

export type Role = "master_admin" | "hospital_admin" | "operador";

export type Perfil = {
  id: string;
  nome: string;
  email: string | null;
  role: Role;
  tenant_id: string | null;
  feature_id: string | null;
  ativo: boolean;
  created_at: string;
  updated_at: string;
};

export async function perfilDe(q: Queryable, userId: string): Promise<Perfil | null> {
  const r = await q.query<Perfil>("SELECT * FROM usuarios_perfil WHERE id = $1", [userId]);
  return r.rows[0] ?? null;
}

/** Perfil existente e ativo; caso contrário a sessão é considerada inválida. */
export async function exigirPerfilAtivo(q: Queryable, userId: string): Promise<Perfil> {
  const perfil = await perfilDe(q, userId);
  if (!perfil || !perfil.ativo) throw unauthorized("Sessão inválida.");
  return perfil;
}

export async function exigirMaster(q: Queryable, userId: string): Promise<Perfil> {
  const perfil = await perfilDe(q, userId);
  if (!perfil || !perfil.ativo || perfil.role !== "master_admin") {
    throw forbidden("Acesso restrito à equipe master do KlinSync.");
  }
  return perfil;
}

export async function exigirHospitalAdmin(q: Queryable, userId: string): Promise<Perfil & { tenant_id: string }> {
  const perfil = await perfilDe(q, userId);
  if (!perfil || !perfil.ativo || perfil.role !== "hospital_admin" || !perfil.tenant_id) {
    throw forbidden("Acesso restrito ao administrador do hospital.");
  }
  return perfil as Perfil & { tenant_id: string };
}

/** Perfil ativo vinculado a um hospital (check-in e demais operações do módulo). */
export async function exigirTenant(q: Queryable, userId: string): Promise<Perfil & { tenant_id: string }> {
  const perfil = await perfilDe(q, userId);
  if (!perfil || !perfil.ativo || !perfil.tenant_id) throw forbidden("Acesso não autorizado.");
  return perfil as Perfil & { tenant_id: string };
}

/** Escopo de leitura: `null` = todos os hospitais (master); senão o hospital do chamador. */
export async function escopoTenant(q: Queryable, userId: string): Promise<{ perfil: Perfil; tenantId: string | null }> {
  const perfil = await exigirPerfilAtivo(q, userId);
  if (perfil.role === "master_admin") return { perfil, tenantId: null };
  if (!perfil.tenant_id) throw forbidden("Acesso não autorizado.");
  return { perfil, tenantId: perfil.tenant_id };
}
