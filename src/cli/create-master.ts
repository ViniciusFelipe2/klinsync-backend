/**
 * Cria o primeiro usuário master_admin (ou mais um).
 *
 *   node --env-file=/etc/klinsync/backend.env dist/cli/create-master.js --email voce@empresa.com --nome "Seu Nome"
 *
 * A senha vem da variável MASTER_PASSWORD; se não for informada, uma senha forte é gerada e exibida uma única vez.
 */
import { randomInt } from "node:crypto";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createPgDb } from "../db/index.js";
import { registrarAcao } from "../lib/auditoria-log.js";
import { senhaForte } from "../lib/senha.js";
import { criarUsuarioComPerfil } from "../lib/usuarios.js";

function senhaAleatoria(): string {
  const grupos = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%&*?-_"];
  const todos = grupos.join("");
  const chars = grupos.map((g) => g[randomInt(g.length)]!);
  while (chars.length < 20) chars.push(todos[randomInt(todos.length)]!);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

async function main() {
  const { values } = parseArgs({ options: { email: { type: "string" }, nome: { type: "string" } } });
  if (!values.email || !values.nome) {
    console.error('Uso: create-master --email voce@empresa.com --nome "Seu Nome"   (senha em MASTER_PASSWORD, opcional)');
    process.exit(2);
  }

  const config = loadConfig();
  const db = createPgDb({ connectionString: config.DATABASE_URL, max: 2 });
  try {
    const gerada = !process.env["MASTER_PASSWORD"];
    const senha = process.env["MASTER_PASSWORD"] ?? senhaAleatoria();
    const ok = senhaForte.safeParse(senha);
    if (!ok.success) throw new Error(ok.error.issues[0]?.message ?? "Senha fraca.");

    const { id } = await db.tx(async (q) => {
      const criado = await criarUsuarioComPerfil(q, {
        email: values.email!,
        senha,
        nome: values.nome!,
        role: "master_admin",
        tenantId: null,
        featureId: null,
      });
      await registrarAcao(q, criado.id, "criou_usuario", { usuario: criado.id, email: values.email, role: "master_admin", origem: "cli" });
      return criado;
    });

    console.log(`master_admin criado: ${values.email} (id ${id})`);
    if (gerada) console.log(`Senha gerada (anote agora, ela não será exibida de novo): ${senha}`);
    console.log("Ative a verificação em duas etapas no primeiro acesso (Painel Master > MFA).");
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
