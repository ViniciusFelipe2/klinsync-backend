import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db, Queryable, Row } from "../src/db/index.js";
import { codigoAtual } from "../src/lib/totp.js";
import { copiarFotos, importarDoSupabase } from "../src/migracao/supabase.js";
import { chamar, configDeTeste, criarBancoDeTeste, montarAmbiente, storageEmMemoria, tokenDe, type Ambiente } from "./helpers.js";

const aqui = dirname(fileURLToPath(import.meta.url));
const SENHA_ANTIGA = "SenhaAntiga#123";
const SEGREDO_TOTP = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

const ID = {
  t1: "11111111-1111-4111-8111-111111111111",
  t2: "22222222-2222-4222-8222-222222222222",
  fCheckin: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  fGiro: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  master: "00000000-0000-4000-8000-000000000001",
  admin: "00000000-0000-4000-8000-000000000002",
  op: "00000000-0000-4000-8000-000000000003",
  semSenha: "00000000-0000-4000-8000-000000000004",
  orfao: "00000000-0000-4000-8000-000000000005",
  apagado: "00000000-0000-4000-8000-000000000006",
  mfa: "00000000-0000-4000-8000-000000000007",
  fantasma: "00000000-0000-4000-8000-0000000000ff",
  s1: "51111111-1111-4111-8111-111111111111",
  s2: "52222222-2222-4222-8222-222222222222",
  s3: "53333333-3333-4333-8333-333333333333",
};

/** Banco "Supabase" de mentira, com dados no formato do projeto mãe (inclusive os problemáticos). */
async function criarOrigem(opts: { semDeletedAt?: boolean } = {}): Promise<PGlite> {
  const pg = new PGlite({ parsers: { 1082: (v: string) => v, 20: (v: string) => Number(v) } });
  let sql = readFileSync(join(aqui, "fixtures", "supabase-source.sql"), "utf8");
  if (opts.semDeletedAt) sql = sql.replace(", deleted_at timestamptz", "");
  await pg.exec(sql);

  const hash = bcrypt.hashSync(SENHA_ANTIGA, 10);
  const q = (s: string, p: unknown[] = []) => pg.query(s, p);

  await q("INSERT INTO tenants (id, nome, cnpj, status, limite_salas, contratado_em) VALUES ($1,'Hospital Santa Clara','12.345.678/0001-90','ativo',5,'2026-08-14'), ($2,'Hospital São Rafael',NULL,'ativo',NULL,'2026-09-01')", [ID.t1, ID.t2]);
  await q("INSERT INTO features (id, chave, nome_exibicao, descricao) VALUES ($1,'checkin_cirurgioes','Check-In Secure','d1'), ($2,'giro_de_sala','Surgical Room Flow','d2')", [ID.fCheckin, ID.fGiro]);
  await q("INSERT INTO tenant_features (id, tenant_id, feature_id, habilitada, habilitada_por) VALUES (gen_random_uuid(),$1,$2,true,$5), (gen_random_uuid(),$1,$3,true,$5), (gen_random_uuid(),$4,$3,true,$6)", [ID.t1, ID.fCheckin, ID.fGiro, ID.t2, ID.master, ID.fantasma]);
  await q("INSERT INTO tenant_features_historico (id, tenant_id, feature_id, habilitada, alterado_por) VALUES (gen_random_uuid(),$1,$2,true,$3)", [ID.t1, ID.fGiro, ID.master]);

  const user = (id: string, email: string | null, pass: string | null, extra = "NULL") =>
    opts.semDeletedAt
      ? q("INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, last_sign_in_at) VALUES ($1,$2,$3, now(), now() - interval '2 days')", [id, email, pass])
      : q(`INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, last_sign_in_at, deleted_at) VALUES ($1,$2,$3, now(), now() - interval '2 days', ${extra})`, [id, email, pass]);
  await user(ID.master, "Master@Trizion.com", hash);
  await user(ID.admin, "adm@santaclara.com", hash);
  await user(ID.op, "op@santaclara.com", hash);
  await user(ID.semSenha, "social@x.com", "");
  await user(ID.orfao, "orfao@x.com", hash);
  await user(ID.apagado, "apagado@x.com", hash, "now()");
  await user(ID.mfa, "mfa@trizion.com", hash);

  const perfil = (id: string, nome: string, role: string, tenant: string | null, feature: string | null, ativo = true) =>
    q("INSERT INTO usuarios_perfil (id, nome, email, role, tenant_id, feature_id, ativo) VALUES ($1,$2,NULL,$3,$4,$5,$6)", [id, nome, role, tenant, feature, ativo]);
  await perfil(ID.master, "Master Trizion", "master_admin", null, null);
  await perfil(ID.admin, "Admin Legado", "administrador", ID.t1, ID.fGiro); // papel legado
  await perfil(ID.op, "Operador Giro", "operador", ID.t1, ID.fGiro);
  await perfil(ID.semSenha, "Login Social", "operador", ID.t2, ID.fGiro, false);
  await perfil(ID.mfa, "Master MFA", "master_admin", null, null);
  await perfil(ID.fantasma, "Sem Conta de Login", "operador", ID.t1, ID.fGiro); // perfil sem auth.users

  await q("INSERT INTO auth.mfa_factors (id, user_id, friendly_name, factor_type, status, secret) VALUES (gen_random_uuid(),$1,'Celular','totp','verified',$2), (gen_random_uuid(),$1,'Pendente','totp','unverified','XXXX'), (gen_random_uuid(),$3,'Lixo','totp','verified','nao-e-base32!')", [ID.mfa, SEGREDO_TOTP, ID.master]);

  await q("INSERT INTO config_seguranca (id, max_tentativas, janela_minutos, bloqueio_minutos) VALUES (true, 7, 20, 30)");
  await q("INSERT INTO convites (id, email, nome, role, tenant_id, feature_id, token_hash, expira_em) VALUES (gen_random_uuid(),'novo@x.com','Novo','operador',$1,$2,'hash1', now() + interval '3 days'), (gen_random_uuid(),'adm2@x.com','Adm2','administrador',$1,NULL,'hash2', now() + interval '3 days')", [ID.t1, ID.fGiro]);
  await q("INSERT INTO ip_bloqueios (id, ip, permanente) VALUES (gen_random_uuid(),'200.1.1.1',true)");
  await q("INSERT INTO log_acessos (id, usuario_id, email_tentado, tenant_id, ip, sucesso) VALUES (gen_random_uuid(),$1,'op@santaclara.com',$2,'1.1.1.1',true), (gen_random_uuid(),$3,'apagado@x.com',NULL,'2.2.2.2',false), (gen_random_uuid(),NULL,'x@x.com',NULL,'3.3.3.3',false)", [ID.op, ID.t1, ID.apagado]);
  await q("INSERT INTO log_acoes_sensiveis (id, usuario_id, acao, detalhes) VALUES (gen_random_uuid(),$1,'criou_hospital','{\"tenant_id\":\"x\",\"nome\":\"Y\"}'), (gen_random_uuid(),$2,'resetou_senha','{}')", [ID.master, ID.fantasma]);
  await q("INSERT INTO check_ins (id, tenant_id, doctor_name, photo_path) VALUES (gen_random_uuid(),$1,'Dr. João',$2), (gen_random_uuid(),$1,'Dra. Maria',$3), (gen_random_uuid(),$1,'Dr. Sem Foto',$4)", [ID.t1, `${ID.t1}/foto1.jpg`, `${ID.t1}/foto2.png`, `${ID.t1}/ausente.jpg`]);
  await q("INSERT INTO salas (id, tenant_id, nome, status_atual, cirurgia_atual) VALUES ($1,$4,'Sala 1','desmontagem','Colecistectomia'), ($2,$4,'Sala 2','livre',NULL), ($3,$5,'Sala B1','livre',NULL), (gen_random_uuid(),NULL,'Sala Órfã','livre',NULL)", [ID.s1, ID.s2, ID.s3, ID.t1, ID.t2]);
  await q("INSERT INTO eventos_giro (id, sala_id, tipo_evento, inicio, fim, duracao_segundos, usuario_inicio_id, usuario_fim_id, cirurgia_anterior, cirurgia_proxima) VALUES (gen_random_uuid(),$1,'desmontagem', now() - interval '1 hour', NULL, NULL, $2, NULL, 'Colecistectomia', NULL), (gen_random_uuid(),$1,'limpeza', now() - interval '50 minutes', now() - interval '35 minutes', 900, $2, $3, NULL, NULL), (gen_random_uuid(),$1,'limpeza', now() - interval '3 hours', now() - interval '2 hours', 3600, $4, NULL, NULL, NULL)", [ID.s1, ID.op, ID.admin, ID.fantasma]);
  await q("INSERT INTO eventos_sala_parada (id, sala_id, inicio, fim, duracao_segundos, usuario_inicio_id) VALUES (gen_random_uuid(),$1, now() - interval '5 hours', now() - interval '4 hours', 3600, $2)", [ID.s2, ID.op]);
  await q("INSERT INTO sala_dispositivos (sala_id, device_id, user_id) VALUES ($1,'tablet-1',$2), ($3,'tablet-2',$4)", [ID.s2, ID.op, ID.s3, ID.fantasma]);
  return pg;
}

const comoQueryable = (pg: PGlite): Queryable => ({
  async query<T = Row>(text: string, params: unknown[] = []) {
    const r = await pg.query(text, params);
    return { rows: r.rows as T[], rowCount: r.affectedRows && r.affectedRows > 0 ? r.affectedRows : r.rows.length };
  },
});

const contar = async (db: Queryable, tabela: string) => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${tabela}`)).rows[0]!.n;

describe("importação do Supabase", () => {
  let origem: PGlite;
  let destino: Db;
  const config = configDeTeste();

  beforeAll(async () => {
    origem = await criarOrigem();
    destino = await criarBancoDeTeste();
  });
  afterAll(async () => {
    await origem.close();
    await destino.close();
  });

  it("simulação (--dry-run) valida e relata sem gravar nada", async () => {
    const rel = await importarDoSupabase(comoQueryable(origem), destino, config, { dryRun: true });
    expect(rel.dryRun).toBe(true);
    expect(rel.tabelas["tenants"]).toEqual({ lidas: 2, importadas: 2, ignoradas: 0 });
    expect(rel.tabelas["usuarios"]!.importadas).toBe(6); // o apagado (deleted_at) não entra
    expect(await contar(destino, "tenants")).toBe(0);
    expect(await contar(destino, "usuarios")).toBe(0);
    expect((await destino.query<{ n: number }>("SELECT count(*)::int AS n FROM features")).rows[0]!.n).toBe(2); // seed intacto após o rollback
  });

  it("importa todas as tabelas, ignora órfãos e relata avisos", async () => {
    const rel = await importarDoSupabase(comoQueryable(origem), destino, config);
    expect(rel.dryRun).toBe(false);

    expect(await contar(destino, "tenants")).toBe(2);
    expect(await contar(destino, "features")).toBe(2);
    expect(await contar(destino, "usuarios")).toBe(6);
    expect(rel.tabelas["usuarios_perfil"]).toEqual({ lidas: 6, importadas: 5, ignoradas: 1 }); // perfil sem conta de login
    expect(await contar(destino, "tenant_features")).toBe(3);
    expect(await contar(destino, "tenant_features_historico")).toBe(1);
    expect(rel.tabelas["convites"]!.importadas).toBe(2);
    expect(await contar(destino, "ip_bloqueios")).toBe(1);
    expect(await contar(destino, "log_acessos")).toBe(3);
    expect(await contar(destino, "log_acoes_sensiveis")).toBe(2);
    expect(await contar(destino, "check_ins")).toBe(3);
    expect(rel.tabelas["salas"]).toEqual({ lidas: 4, importadas: 3, ignoradas: 1 }); // sala sem hospital
    expect(rel.tabelas["eventos_giro"]).toEqual({ lidas: 3, importadas: 2, ignoradas: 1 }); // autor inexistente
    expect(await contar(destino, "eventos_sala_parada")).toBe(1);
    expect(await contar(destino, "sala_dispositivos")).toBe(2);
    expect(rel.tabelas["mfa_fatores"]).toEqual({ lidas: 2, importadas: 1, ignoradas: 1 }); // segredo inválido recusado

    expect(rel.avisos.some((a) => a.includes("administrador"))).toBe(true);
    expect(rel.avisos.some((a) => a.includes("social@x.com"))).toBe(true);
    expect(rel.avisos.some((a) => a.includes("MFA"))).toBe(true);
  });

  it("preserva ids, converte papéis e normaliza e-mails", async () => {
    const f = await destino.query<{ id: string; chave: string }>("SELECT id, chave FROM features ORDER BY chave");
    expect(f.rows).toEqual([expect.objectContaining({ id: ID.fCheckin }), expect.objectContaining({ id: ID.fGiro })]); // ids do Supabase, não os do seed

    const perfis = (await destino.query<Row>("SELECT id, email, role, tenant_id, feature_id, ativo FROM usuarios_perfil ORDER BY email")).rows;
    const admin = perfis.find((p) => p["id"] === ID.admin)!;
    expect(admin).toMatchObject({ role: "hospital_admin", tenant_id: ID.t1, feature_id: null }); // 'administrador' legado
    expect(perfis.find((p) => p["id"] === ID.master)).toMatchObject({ email: "master@trizion.com", role: "master_admin", tenant_id: null, feature_id: null });
    expect(perfis.find((p) => p["id"] === ID.op)).toMatchObject({ role: "operador", feature_id: ID.fGiro });
    expect(perfis.find((p) => p["id"] === ID.semSenha)!["ativo"]).toBe(false);

    const t = (await destino.query<Row>("SELECT contratado_em, limite_salas FROM tenants WHERE id = $1", [ID.t1])).rows[0]!;
    expect(t["contratado_em"]).toBe("2026-08-14"); // date sem deslocamento de fuso
    expect(t["limite_salas"]).toBe(5);

    const conv = (await destino.query<Row>("SELECT role FROM convites ORDER BY email")).rows.map((r) => r["role"]);
    expect(conv).toEqual(["hospital_admin", "operador"]);

    const cfg = (await destino.query<Row>("SELECT max_tentativas, janela_minutos, bloqueio_minutos FROM config_seguranca")).rows[0]!;
    expect(cfg).toEqual({ max_tentativas: 7, janela_minutos: 20, bloqueio_minutos: 30 });
  });

  it("limpa referências quebradas e mantém o histórico do giro", async () => {
    const logs = (await destino.query<Row>("SELECT email_tentado, usuario_id FROM log_acessos ORDER BY email_tentado")).rows;
    expect(logs.find((l) => l["email_tentado"] === "apagado@x.com")!["usuario_id"]).toBeNull(); // usuário apagado
    expect(logs.find((l) => l["email_tentado"] === "op@santaclara.com")!["usuario_id"]).toBe(ID.op);

    const acao = (await destino.query<Row>("SELECT usuario_id, detalhes FROM log_acoes_sensiveis WHERE acao = 'criou_hospital'")).rows[0]!;
    expect(acao["usuario_id"]).toBe(ID.master);
    expect(acao["detalhes"]).toEqual({ tenant_id: "x", nome: "Y" }); // jsonb preservado
    expect((await destino.query<Row>("SELECT 1 FROM log_acoes_sensiveis WHERE acao = 'resetou_senha' AND usuario_id IS NULL")).rowCount).toBe(1);

    const salas = (await destino.query<Row>("SELECT nome, status_atual, cirurgia_atual FROM salas ORDER BY nome")).rows;
    expect(salas.find((s) => s["nome"] === "Sala 1")).toMatchObject({ status_atual: "desmontagem", cirurgia_atual: "Colecistectomia" });
    const ev = (await destino.query<Row>("SELECT tipo_evento, fim, usuario_fim_id FROM eventos_giro ORDER BY inicio")).rows;
    expect(ev).toHaveLength(2);
    expect(ev.find((e) => e["tipo_evento"] === "limpeza")!["usuario_fim_id"]).toBe(ID.admin);
    expect((await destino.query<Row>("SELECT user_id FROM sala_dispositivos WHERE device_id = 'tablet-2'")).rows[0]!["user_id"]).toBeNull();
  });

  it("recusa importar em banco que já tem dados, a menos que se peça para limpar", async () => {
    await expect(importarDoSupabase(comoQueryable(origem), destino, config)).rejects.toThrow(/já tem dados/);
    expect(await contar(destino, "tenants")).toBe(2); // nada foi alterado

    const rel = await importarDoSupabase(comoQueryable(origem), destino, config, { limparDestino: true });
    expect(rel.tabelas["usuarios"]!.importadas).toBe(6);
    expect(await contar(destino, "check_ins")).toBe(3);
    expect(await contar(destino, "features")).toBe(2);
  });

  describe("a aplicação sobre os dados migrados", () => {
    let amb: Ambiente;
    beforeAll(async () => {
      amb = await montarAmbiente(destino);
    });
    afterAll(async () => {
      await amb.app.close(); // o banco é fechado pelo bloco externo
    });

    it("usuário entra com a senha ANTIGA (bcrypt) e o hash é trocado para scrypt", async () => {
      expect((await destino.query<Row>("SELECT senha_hash FROM usuarios WHERE id = $1", [ID.op])).rows[0]!["senha_hash"]).toMatch(/^\$2[aby]\$/);

      // enquanto há contas com bcrypt pendente, a postura de segurança mostra atenção (não crítico)
      const mestre = (await chamar(amb.app, "POST", "/auth/login", { body: { email: "master@trizion.com", senha: SENHA_ANTIGA } })).body.accessToken as string;
      const antes = await chamar(amb.app, "POST", "/master/seguranca/postura", { token: mestre, body: {} });
      const hashAntes = antes.body.checagens.find((c: { id: string }) => c.id === "hash-senha");
      expect(hashAntes.status).toBe("atencao");
      expect(hashAntes.itens).toContain("op@santaclara.com");

      const errada = await chamar(amb.app, "POST", "/auth/login", { body: { email: "op@santaclara.com", senha: "Errada#123456" } });
      expect(errada.status).toBe(401);
      const r = await chamar(amb.app, "POST", "/auth/login", { body: { email: "OP@santaclara.com", senha: SENHA_ANTIGA } });
      expect(r.status).toBe(200);
      expect(r.body.user.id).toBe(ID.op);

      expect((await destino.query<Row>("SELECT senha_hash FROM usuarios WHERE id = $1", [ID.op])).rows[0]!["senha_hash"]).toMatch(/^scrypt\$/);
      expect((await chamar(amb.app, "POST", "/auth/login", { body: { email: "op@santaclara.com", senha: SENHA_ANTIGA } })).status).toBe(200); // continua valendo com scrypt
    });

    it("conta sem senha ou desativada não entra", async () => {
      expect((await chamar(amb.app, "POST", "/auth/login", { body: { email: "social@x.com", senha: "qualquer" } })).status).toBe(401);
      expect((await chamar(amb.app, "POST", "/auth/login", { body: { email: "orfao@x.com", senha: SENHA_ANTIGA } })).status).toBe(401); // sem perfil
      expect((await chamar(amb.app, "POST", "/auth/login", { body: { email: "apagado@x.com", senha: SENHA_ANTIGA } })).status).toBe(401);
    });

    it("o TOTP migrado continua valendo: mesmo app autenticador, sem recadastrar", async () => {
      const etapa1 = await chamar(amb.app, "POST", "/auth/login", { body: { email: "mfa@trizion.com", senha: SENHA_ANTIGA } });
      expect(etapa1.body.mfaRequired).toBe(true);
      const ok = await chamar(amb.app, "POST", "/auth/mfa/verify", {
        body: { mfaToken: etapa1.body.mfaToken, factorId: etapa1.body.factorId, code: codigoAtual(SEGREDO_TOTP) },
      });
      expect(ok.status).toBe(200);
      expect(ok.body.accessToken).toBeTruthy();
      // o segredo não fica em texto no banco
      expect((await destino.query<Row>("SELECT segredo_cifrado FROM mfa_fatores LIMIT 1")).rows[0]!["segredo_cifrado"]).not.toContain(SEGREDO_TOTP);
    });

    it("os painéis funcionam com os dados importados", async () => {
      const master = await tokenDe(amb.app, "master@trizion.com").catch(async () => {
        // o master também veio com bcrypt: login normal
        const r = await chamar(amb.app, "POST", "/auth/login", { body: { email: "master@trizion.com", senha: SENHA_ANTIGA } });
        return r.body.accessToken as string;
      });
      const dash = await chamar(amb.app, "GET", "/master/dashboard", { token: master });
      expect(dash.status).toBe(200);
      expect(dash.body.tenants.map((t: { nome: string }) => t.nome).sort()).toEqual(["Hospital Santa Clara", "Hospital São Rafael"]);
      expect(dash.body.tenantFeatures).toHaveLength(3);

      const adm = (await chamar(amb.app, "POST", "/auth/login", { body: { email: "adm@santaclara.com", senha: SENHA_ANTIGA } })).body.accessToken as string;
      const resumo = await chamar(amb.app, "GET", "/hospital/resumo", { token: adm });
      expect(resumo.status).toBe(200);
      expect(resumo.body.usuarios.total).toBe(2); // admin legado + operador (o perfil órfão ficou de fora)
      expect(resumo.body.salas.total).toBe(2);

      const op = (await chamar(amb.app, "POST", "/auth/login", { body: { email: "op@santaclara.com", senha: SENHA_ANTIGA } })).body.accessToken as string;
      const salas = await chamar(amb.app, "GET", "/giro/salas", { token: op });
      expect(salas.body.map((s: { nome: string }) => s.nome)).toEqual(["Sala 1", "Sala 2"]);
      const abertos = await chamar(amb.app, "GET", "/giro/eventos?abertos=true", { token: op });
      expect(abertos.body).toHaveLength(1);
      expect(abertos.body[0].tipo_evento).toBe("desmontagem");

      const postura = await chamar(amb.app, "POST", "/master/seguranca/postura", { token: master, body: {} });
      // todos que têm senha já entraram e foram convertidos; a conta sem senha ("!") não conta como hash fraco
      expect(postura.body.checagens.find((c: { id: string }) => c.id === "hash-senha").status).toBe("ok");
    });
  });

  it("funciona também com versões do Supabase Auth sem a coluna deleted_at", async () => {
    const antiga = await criarOrigem({ semDeletedAt: true });
    const alvo = await criarBancoDeTeste();
    try {
      const rel = await importarDoSupabase(comoQueryable(antiga), alvo, config);
      expect(rel.tabelas["usuarios"]!.importadas).toBe(7); // sem como saber que o 'apagado' foi excluído
    } finally {
      await antiga.close();
      await alvo.close();
    }
  });
});

describe("cópia das fotos para o S3", () => {
  it("copia com os mesmos caminhos, tolera ausentes e erros temporários, relata as falhas", async () => {
    const destino = await criarBancoDeTeste();
    const storage = storageEmMemoria();
    try {
      await destino.query("INSERT INTO tenants (id, nome) VALUES ($1, 'H')", [ID.t1]);
      const caminhos = ["a/foto1.jpg", "a/foto2.png", "a/ausente.jpg", "a/quebrada.jpg", "a/instavel.jpg"];
      for (const c of caminhos) await destino.query("INSERT INTO check_ins (tenant_id, doctor_name, photo_path) VALUES ($1, 'Dr. X', $2)", [ID.t1, c]);
      await destino.query("INSERT INTO check_ins (tenant_id, doctor_name, photo_path) VALUES ($1, 'Dr. Repetido', 'a/foto1.jpg')", [ID.t1]); // mesmo arquivo

      let tentativasInstavel = 0;
      const rel = await copiarFotos(destino, {
        storage,
        concorrencia: 3,
        baixar: async (c) => {
          if (c === "a/ausente.jpg") return null;
          if (c === "a/quebrada.jpg") throw new Error("HTTP 500");
          if (c === "a/instavel.jpg" && ++tentativasInstavel < 3) throw new Error("timeout"); // funciona na 3ª tentativa
          return { dados: Buffer.from(`conteudo:${c}`), contentType: c.endsWith(".png") ? "image/png" : "image/jpeg" };
        },
      });

      expect(rel.total).toBe(5); // caminhos distintos
      expect(rel.copiadas).toBe(3);
      expect(rel.ausentes).toEqual(["a/ausente.jpg"]);
      expect(rel.falhas).toEqual(["a/quebrada.jpg"]);
      expect([...storage.objetos.keys()].sort()).toEqual(["a/foto1.jpg", "a/foto2.png", "a/instavel.jpg"]);
      expect(storage.objetos.get("a/foto2.png")!.toString()).toBe("conteudo:a/foto2.png");
    } finally {
      await destino.close();
    }
  });
});
