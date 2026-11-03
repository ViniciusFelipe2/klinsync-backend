/**
 * Cria só o usuário master_admin no banco local (sem hospital, salas ou outros usuários).
 *
 *   npm run local:master
 *
 * O `create-master` oficial fala com o PostgreSQL da EC2; este fala com o banco embutido (.local-db/).
 * Variáveis opcionais: MASTER_EMAIL, MASTER_NOME, MASTER_PASSWORD.
 */
import { senhaForte } from "../src/lib/senha.js";
import { criarUsuarioComPerfil } from "../src/lib/usuarios.js";
import { abrirBancoLocal } from "./pglite-local.js";

const email = process.env["MASTER_EMAIL"] ?? "master@klinsync.local";
const nome = process.env["MASTER_NOME"] ?? "Master KlinSync";
const senha = process.env["MASTER_PASSWORD"] ?? "Master#Local2026";

const ok = senhaForte.safeParse(senha);
if (!ok.success) throw new Error(ok.error.issues[0]?.message ?? "Senha fraca.");

const banco = await abrirBancoLocal();
try {
  await banco.db.tx((q) => criarUsuarioComPerfil(q, { email, senha, nome, role: "master_admin", tenantId: null, featureId: null }));
  console.log(`master_admin criado no banco local: ${email}`);
  console.log(`Senha: ${senha}`);
} finally {
  await banco.db.close();
}
