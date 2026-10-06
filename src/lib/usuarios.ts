import type { Queryable } from "../db/index.js";
import { conflict } from "../errors.js";
import { hashSenha } from "./crypto.js";
import type { Role } from "./perfil.js";

export type NovoUsuario = {
  email: string;
  senha: string;
  nome: string;
  role: Role;
  tenantId: string | null;
  featureId: string | null;
};

/** Cria a credencial (usuarios) e o perfil (usuarios_perfil). Deve rodar dentro de uma transação. */
export async function criarUsuarioComPerfil(q: Queryable, u: NovoUsuario): Promise<{ id: string }> {
  const email = u.email.trim().toLowerCase();
  const existe = await q.query("SELECT 1 FROM usuarios WHERE lower(email) = $1", [email]);
  if (existe.rowCount > 0) throw conflict("Já existe uma conta com este e-mail.");

  const senhaHash = await hashSenha(u.senha);
  const criado = await q.query<{ id: string }>(
    "INSERT INTO usuarios (email, senha_hash) VALUES ($1, $2) RETURNING id",
    [email, senhaHash],
  );
  const id = criado.rows[0]!.id;
  await q.query(
    `INSERT INTO usuarios_perfil (id, nome, email, role, tenant_id, feature_id, ativo)
     VALUES ($1, $2, $3, $4, $5, $6, true)`,
    [id, u.nome, email, u.role, u.role === "master_admin" ? null : u.tenantId, u.role === "operador" ? u.featureId : null],
  );
  return { id };
}
