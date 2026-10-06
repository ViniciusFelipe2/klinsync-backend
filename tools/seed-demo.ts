/**
 * Dados de DEMONSTRAÇÃO no banco local (só para testar o sistema no seu PC).
 *
 *   npm run local:seed
 *
 * Cria um hospital com os dois módulos, salas e um usuário de cada papel. Não roda se o banco já tem usuários.
 */
import { criarUsuarioComPerfil } from "../src/lib/usuarios.js";
import { abrirBancoLocal } from "./pglite-local.js";

export const SENHA_DEMO = "Demo#Senha2026";
export const USUARIOS_DEMO = [
  { email: "master@klinsync.local", papel: "master_admin (equipe Trizion)" },
  { email: "admin@demo.local", papel: "hospital_admin (Hospital Demo)" },
  { email: "giro@demo.local", papel: "operador — Giro de Sala" },
  { email: "checkin@demo.local", papel: "operador — Check-in de Cirurgiões" },
];

const banco = await abrirBancoLocal();
try {
  const { n } = (await banco.db.query<{ n: number }>("SELECT count(*)::int AS n FROM usuarios")).rows[0]!;
  if (n > 0) {
    console.log(`O banco local já tem ${n} usuário(s); nada foi criado. (Para recomeçar: npm run local:reset)`);
  } else {
    await banco.db.tx(async (q) => {
      const t = (await q.query<{ id: string }>("INSERT INTO tenants (nome, cnpj, status, limite_salas) VALUES ('Hospital Demo', '00.000.000/0001-00', 'ativo', 6) RETURNING id")).rows[0]!.id;
      const feats = (await q.query<{ id: string; chave: string }>("SELECT id, chave FROM features")).rows;
      for (const f of feats) await q.query("INSERT INTO tenant_features (tenant_id, feature_id, habilitada) VALUES ($1, $2, true)", [t, f.id]);
      const giro = feats.find((f) => f.chave === "giro_de_sala")!.id;
      const checkin = feats.find((f) => f.chave === "checkin_cirurgioes")!.id;
      for (const nome of ["Sala 01", "Sala 02", "Sala 03"]) await q.query("INSERT INTO salas (tenant_id, nome) VALUES ($1, $2)", [t, nome]);

      const novo = (email: string, nome: string, role: "master_admin" | "hospital_admin" | "operador", tenantId: string | null, featureId: string | null) =>
        criarUsuarioComPerfil(q, { email, senha: SENHA_DEMO, nome, role, tenantId, featureId });
      await novo("master@klinsync.local", "Master Trizion", "master_admin", null, null);
      await novo("admin@demo.local", "Admin do Hospital Demo", "hospital_admin", t, null);
      await novo("giro@demo.local", "Operador do Giro", "operador", t, giro);
      await novo("checkin@demo.local", "Operador do Check-in", "operador", t, checkin);
    });
    console.log("Dados de demonstração criados.\n");
    console.log(`Senha de todos: ${SENHA_DEMO}\n`);
    for (const u of USUARIOS_DEMO) console.log(`  ${u.email.padEnd(24)} ${u.papel}`);
  }
} finally {
  await banco.db.close();
}
