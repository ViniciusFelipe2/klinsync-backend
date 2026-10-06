import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SENHA, chamar, criarAmbiente, criarHospital, criarUsuarioDireto, habilitarFeature, login, tokenDe, type Ambiente } from "./helpers.js";

let amb: Ambiente;
let master: string;
let tenantA: string;
let tenantB: string;
let featureGiro: string;
let admA: string;
let opA: string;
let admB: string;

beforeAll(async () => {
  amb = await criarAmbiente();
  tenantA = await criarHospital(amb.db, "Hospital A", 2);
  tenantB = await criarHospital(amb.db, "Hospital B");
  featureGiro = await habilitarFeature(amb.db, tenantA, "giro_de_sala");
  await habilitarFeature(amb.db, tenantB, "giro_de_sala");
  await criarUsuarioDireto(amb.db, { email: "master@t.com", role: "master_admin" });
  await criarUsuarioDireto(amb.db, { email: "adm-a@t.com", role: "hospital_admin", tenantId: tenantA });
  await criarUsuarioDireto(amb.db, { email: "adm-b@t.com", role: "hospital_admin", tenantId: tenantB });
  await criarUsuarioDireto(amb.db, { email: "op-a@t.com", role: "operador", tenantId: tenantA, featureId: featureGiro });
  master = await tokenDe(amb.app, "master@t.com");
  admA = await tokenDe(amb.app, "adm-a@t.com");
  admB = await tokenDe(amb.app, "adm-b@t.com");
  opA = await tokenDe(amb.app, "op-a@t.com");
});
afterAll(() => amb.fechar());

describe("controle de acesso por papel", () => {
  it("rotas master recusam hospital_admin e operador (403)", async () => {
    for (const token of [admA, opA]) {
      expect((await chamar(amb.app, "GET", "/master/dashboard", { token })).status).toBe(403);
      expect((await chamar(amb.app, "GET", "/master/usuarios", { token })).status).toBe(403);
      expect((await chamar(amb.app, "POST", "/master/seguranca/ips", { token, body: {} })).status).toBe(403);
    }
  });

  it("rotas do hospital recusam operador e master (somente hospital_admin)", async () => {
    expect((await chamar(amb.app, "GET", "/hospital/resumo", { token: opA })).status).toBe(403);
    expect((await chamar(amb.app, "GET", "/hospital/resumo", { token: master })).status).toBe(403);
    expect((await chamar(amb.app, "GET", "/hospital/resumo", { token: admA })).status).toBe(200);
  });

  it("validação devolve 422 com mensagem em português", async () => {
    const r = await chamar(amb.app, "POST", "/master/hospitais/salvar", { token: master, body: { nome: "X", status: "ativo" } });
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/inválidos/i);
  });
});

describe("hospitais, módulos e dashboard (master)", () => {
  it("cria e atualiza hospital, alterna feature e registra auditoria", async () => {
    const novo = await chamar(amb.app, "POST", "/master/hospitais/salvar", {
      token: master,
      body: { nome: "Hospital Novo", cnpj: "00.000.000/0001-00", status: "ativo", limite_salas: 3 },
    });
    expect(novo.status).toBe(200);
    const id = novo.body.id as string;

    const upd = await chamar(amb.app, "POST", "/master/hospitais/salvar", {
      token: master,
      body: { id, nome: "Hospital Novo 2", status: "inadimplente", limite_salas: 5 },
    });
    expect(upd.body.id).toBe(id);
    const linha = await amb.db.query("SELECT nome, status, limite_salas, contratado_em FROM tenants WHERE id = $1", [id]);
    expect(linha.rows[0]).toMatchObject({ nome: "Hospital Novo 2", status: "inadimplente", limite_salas: 5 });
    expect(linha.rows[0]!["contratado_em"]).toMatch(/^\d{4}-\d{2}-\d{2}$/); // date como string, sem fuso

    const feat = (await amb.db.query<{ id: string }>("SELECT id FROM features WHERE chave = 'checkin_cirurgioes'")).rows[0]!.id;
    const alt = await chamar(amb.app, "POST", "/master/features/alternar", { token: master, body: { tenantId: id, featureId: feat, habilitada: true } });
    expect(alt.status).toBe(200);
    await chamar(amb.app, "POST", "/master/features/alternar", { token: master, body: { tenantId: id, featureId: feat, habilitada: false } });
    const hist = await amb.db.query("SELECT habilitada FROM tenant_features_historico WHERE tenant_id = $1 ORDER BY created_at", [id]);
    expect(hist.rows.map((h) => h["habilitada"])).toEqual([true, false]);

    const dash = await chamar(amb.app, "GET", "/master/dashboard", { token: master });
    expect(dash.status).toBe(200);
    expect(dash.body.tenants.length).toBeGreaterThanOrEqual(3);
    expect(dash.body.features).toHaveLength(2);

    const aud = await chamar(amb.app, "POST", "/auditoria", { token: master, body: { dias: 30 } });
    const titulos = aud.body.eventos.map((e: { titulo: string }) => e.titulo);
    expect(titulos).toEqual(expect.arrayContaining(["Cadastrou hospital", "Atualizou hospital", "Alterou feature do hospital"]));
  });

  it("hospital_admin só enxerga a própria auditoria", async () => {
    const aud = await chamar(amb.app, "POST", "/auditoria", { token: admA, body: {} });
    expect(aud.status).toBe(200);
    expect(aud.body.hospitais).toEqual(["Hospital A"]);
    expect(aud.body.eventos.every((e: { hospital: string | null }) => e.hospital === "Hospital A")).toBe(true);
    expect((await chamar(amb.app, "POST", "/auditoria", { token: opA, body: {} })).status).toBe(403);
  });
});

describe("salas e limite contratado", () => {
  it("master cria salas até o limite e bloqueia a excedente; exclusão respeita histórico", async () => {
    const cria = (nome: string) => chamar(amb.app, "POST", "/master/salas/salvar", { token: master, body: { tenantId: tenantA, nome } });
    expect((await cria("Sala 1")).status).toBe(200);
    expect((await cria("Sala 2")).status).toBe(200);
    const excedeu = await cria("Sala 3");
    expect(excedeu.status).toBe(422);
    expect(excedeu.body.message).toMatch(/Limite de 2 sala/);

    const lista = await chamar(amb.app, "POST", "/master/salas/listar", { token: master, body: { tenantId: tenantA } });
    expect(lista.body.limite).toBe(2);
    expect(lista.body.salas.map((s: { nome: string }) => s.nome)).toEqual(["Sala 1", "Sala 2"]);

    // hospital_admin respeita o mesmo limite, com a mensagem própria
    const adm = await chamar(amb.app, "POST", "/hospital/salas/salvar", { token: admA, body: { nome: "Sala 3" } });
    expect(adm.status).toBe(422);
    expect(adm.body.message).toMatch(/contratado/);

    // sala com histórico de giro não pode ser excluída
    const sala = lista.body.salas[0].id as string;
    const op = (await amb.db.query<{ id: string }>("SELECT id FROM usuarios WHERE email = 'op-a@t.com'")).rows[0]!.id;
    await amb.db.query("INSERT INTO eventos_giro (sala_id, tipo_evento, usuario_inicio_id) VALUES ($1, 'desmontagem', $2)", [sala, op]);
    const del = await chamar(amb.app, "POST", "/master/salas/excluir", { token: master, body: { tenantId: tenantA, id: sala } });
    expect(del.status).toBe(422);
    const outra = lista.body.salas[1].id as string;
    expect((await chamar(amb.app, "POST", "/master/salas/excluir", { token: master, body: { tenantId: tenantA, id: outra } })).status).toBe(200);
  });

  it("hospital_admin edita sala do próprio hospital e não toca em sala de outro", async () => {
    const sala = (await amb.db.query<{ id: string }>("SELECT id FROM salas WHERE tenant_id = $1 LIMIT 1", [tenantA])).rows[0]!.id;
    const ok = await chamar(amb.app, "POST", "/hospital/salas/salvar", { token: admA, body: { id: sala, nome: "Sala Renomeada", ativa: true } });
    expect(ok.status).toBe(200);
    const negado = await chamar(amb.app, "POST", "/hospital/salas/salvar", { token: admB, body: { id: sala, nome: "Invasão" } });
    expect(negado.status).toBe(404);
    expect((await amb.db.query("SELECT nome FROM salas WHERE id = $1", [sala])).rows[0]!["nome"]).toBe("Sala Renomeada");
  });
});

describe("usuários (master)", () => {
  it("cria, valida duplicidade/senha, reseta, desativa e atualiza", async () => {
    const corpo = { email: "novo@t.com", senha: SENHA, nome: "Novo Operador", role: "operador", tenantId: tenantB, featureId: featureGiro };

    // feature não habilitada no hospital B? (está habilitada) -> cria
    const featB = (await amb.db.query<{ id: string }>("SELECT id FROM features WHERE chave = 'giro_de_sala'")).rows[0]!.id;
    const ok = await chamar(amb.app, "POST", "/master/usuarios/criar", { token: master, body: { ...corpo, featureId: featB } });
    expect(ok.status).toBe(200);

    expect((await chamar(amb.app, "POST", "/master/usuarios/criar", { token: master, body: { ...corpo, featureId: featB } })).status).toBe(409);
    const fraca = await chamar(amb.app, "POST", "/master/usuarios/criar", { token: master, body: { ...corpo, email: "fraca@t.com", senha: "abc" } });
    expect(fraca.status).toBe(422);
    expect(fraca.body.message).toMatch(/no mínimo 10 caracteres/);
    const semHosp = await chamar(amb.app, "POST", "/master/usuarios/criar", { token: master, body: { ...corpo, email: "s@t.com", tenantId: null } });
    expect(semHosp.status).toBe(422);

    // novo usuário consegue entrar; reset de senha derruba a sessão antiga
    const sessao = (await login(amb.app, "novo@t.com")).body;
    const reset = await chamar(amb.app, "POST", "/master/usuarios/resetar-senha", { token: master, body: { usuarioId: ok.body.id, senha: "Outra#Senha456" } });
    expect(reset.status).toBe(200);
    expect((await chamar(amb.app, "POST", "/auth/refresh", { body: { refreshToken: sessao.refreshToken } })).status).toBe(401);
    expect((await login(amb.app, "novo@t.com", SENHA)).status).toBe(401);
    expect((await login(amb.app, "novo@t.com", "Outra#Senha456")).status).toBe(200);

    // desativar bloqueia o login; não pode desativar a si mesmo
    await chamar(amb.app, "POST", "/master/usuarios/alternar-ativo", { token: master, body: { usuarioId: ok.body.id, ativo: false } });
    expect((await login(amb.app, "novo@t.com", "Outra#Senha456")).status).toBe(401);
    const meuId = (await chamar(amb.app, "GET", "/auth/me", { token: master })).body.id;
    expect((await chamar(amb.app, "POST", "/master/usuarios/alternar-ativo", { token: master, body: { usuarioId: meuId, ativo: false } })).status).toBe(422);

    // atualizar nome/e-mail (e-mail duplicado é recusado)
    const upd = await chamar(amb.app, "POST", "/master/usuarios/atualizar", { token: master, body: { usuarioId: ok.body.id, nome: "Nome Novo", email: "Renomeado@T.com" } });
    expect(upd.status).toBe(200);
    expect((await login(amb.app, "renomeado@t.com", "Outra#Senha456")).status).toBe(401); // continua desativado
    const dup = await chamar(amb.app, "POST", "/master/usuarios/atualizar", { token: master, body: { usuarioId: ok.body.id, nome: "Nome Novo", email: "master@t.com" } });
    expect(dup.status).toBe(409);

    const lista = await chamar(amb.app, "GET", "/master/usuarios", { token: master });
    expect(lista.body.some((u: { email: string }) => u.email === "renomeado@t.com")).toBe(true);
  });

  it("senha vazada é recusada (HIBP)", async () => {
    const env = await criarAmbiente({ externos: { senhaFoiVazada: async () => true } });
    try {
      await criarUsuarioDireto(env.db, { email: "m@t.com", role: "master_admin" });
      const t = await tokenDe(env.app, "m@t.com");
      const r = await chamar(env.app, "POST", "/master/usuarios/criar", {
        token: t,
        body: { email: "x@t.com", senha: SENHA, nome: "Fulano", role: "master_admin" },
      });
      expect(r.status).toBe(422);
      expect(r.body.message).toMatch(/vazamentos/);
    } finally {
      await env.fechar();
    }
  });
});

describe("convites", () => {
  it("fluxo completo: criar → validar → aceitar → login, com token só no momento da criação", async () => {
    const criado = await chamar(amb.app, "POST", "/convites/criar", {
      token: admA,
      body: { nome: "Maria Operadora", email: "maria@t.com", role: "operador", featureId: featureGiro },
    });
    expect(criado.status).toBe(200);
    const token = criado.body.token as string;
    expect(token).toMatch(/^[A-Za-z0-9]{32}$/);

    // o hash nunca é exposto na listagem
    const lista = await chamar(amb.app, "GET", "/convites", { token: admA });
    expect(lista.body).toHaveLength(1);
    expect(lista.body[0].token_hash).toBeUndefined();

    const val = await chamar(amb.app, "POST", "/convites/validar", { body: { token } });
    expect(val.body).toMatchObject({ valido: true, nome: "Maria Operadora", email: "maria@t.com", role: "operador", hospital: "Hospital A", feature: "Surgical Room Flow" });

    const fraca = await chamar(amb.app, "POST", "/convites/aceitar", { body: { token, nome: "Maria", senha: "fraca" } });
    expect(fraca.status).toBe(422);

    const aceito = await chamar(amb.app, "POST", "/convites/aceitar", { body: { token, nome: "Maria Operadora", senha: SENHA } });
    expect(aceito.status).toBe(200);
    expect(aceito.body.email).toBe("maria@t.com");
    expect((await login(amb.app, "maria@t.com")).status).toBe(200);

    // reuso do link: indisponível (resposta genérica) e aceite recusado
    expect((await chamar(amb.app, "POST", "/convites/validar", { body: { token } })).body).toEqual({ valido: false, motivo: "indisponivel" });
    expect((await chamar(amb.app, "POST", "/convites/aceitar", { body: { token, nome: "Maria", senha: SENHA } })).status).toBe(422);
  });

  it("hospital_admin só convida operadores do próprio hospital; e-mail existente é recusado", async () => {
    const naoOperador = await chamar(amb.app, "POST", "/convites/criar", {
      token: admA,
      body: { nome: "Chefe", email: "chefe@t.com", role: "hospital_admin", tenantId: tenantA },
    });
    expect(naoOperador.status).toBe(403);

    const existente = await chamar(amb.app, "POST", "/convites/criar", {
      token: admA,
      body: { nome: "Dup", email: "master@t.com", role: "operador", featureId: featureGiro },
    });
    expect(existente.status).toBe(409);

    // mesmo informando outro hospital, o convite fica no hospital do admin
    const outro = await chamar(amb.app, "POST", "/convites/criar", {
      token: admA,
      body: { nome: "Ana", email: "ana@t.com", role: "operador", tenantId: tenantB, featureId: featureGiro },
    });
    expect(outro.status).toBe(200);
    const linha = await amb.db.query("SELECT tenant_id FROM convites WHERE email = 'ana@t.com'");
    expect(linha.rows[0]!["tenant_id"]).toBe(tenantA);

    expect((await chamar(amb.app, "POST", "/convites/criar", { token: opA, body: { nome: "Xavier", email: "xavier@t.com", role: "operador" } })).status).toBe(403);
  });

  it("regerar invalida o link anterior; revogar impede o aceite; admin de outro hospital não mexe", async () => {
    const c1 = await chamar(amb.app, "POST", "/convites/criar", {
      token: master,
      body: { nome: "Carlos", email: "carlos@t.com", role: "hospital_admin", tenantId: tenantA },
    });
    const id = c1.body.id as string;
    expect((await chamar(amb.app, "POST", "/convites/revogar", { token: admB, body: { conviteId: id } })).status).toBe(403);

    const novo = await chamar(amb.app, "POST", "/convites/regerar", { token: master, body: { conviteId: id } });
    expect(novo.status).toBe(200);
    expect((await chamar(amb.app, "POST", "/convites/validar", { body: { token: c1.body.token } })).body.valido).toBe(false);
    expect((await chamar(amb.app, "POST", "/convites/validar", { body: { token: novo.body.token } })).body.valido).toBe(true);

    expect((await chamar(amb.app, "POST", "/convites/revogar", { token: master, body: { conviteId: id } })).status).toBe(200);
    expect((await chamar(amb.app, "POST", "/convites/aceitar", { body: { token: novo.body.token, nome: "Carlos", senha: SENHA } })).status).toBe(422);
    expect((await chamar(amb.app, "POST", "/convites/validar", { body: { token: "curto" } })).status).toBe(422);
  });

  it("convite expirado fica indisponível", async () => {
    const c = await chamar(amb.app, "POST", "/convites/criar", { token: master, body: { nome: "Exp", email: "exp@t.com", role: "master_admin" } });
    await amb.db.query("UPDATE convites SET expira_em = now() - interval '1 minute' WHERE id = $1", [c.body.id]);
    expect((await chamar(amb.app, "POST", "/convites/validar", { body: { token: c.body.token } })).body).toEqual({ valido: false, motivo: "indisponivel" });
  });
});

describe("segurança (master)", () => {
  it("config, bloqueio/desbloqueio de IP, painel, postura e expurgo", async () => {
    const cfg = await chamar(amb.app, "POST", "/master/seguranca/config", { token: master, body: { max_tentativas: 4, janela_minutos: 10, bloqueio_minutos: 20 } });
    expect(cfg.status).toBe(200);
    expect((await chamar(amb.app, "POST", "/master/seguranca/config", { token: master, body: { max_tentativas: 0, janela_minutos: 10, bloqueio_minutos: 20 } })).status).toBe(422);

    expect((await chamar(amb.app, "POST", "/master/seguranca/ips/bloquear", { token: master, body: { ip: "200.1.1.1", minutos: 60 } })).status).toBe(200);
    const ips = await chamar(amb.app, "POST", "/master/seguranca/ips", { token: master, body: { dias: 7 } });
    expect(ips.body.politica).toEqual({ max_tentativas: 4, janela_minutos: 10, bloqueio_minutos: 20 });
    expect(ips.body.bloqueios.find((b: { ip: string }) => b.ip === "200.1.1.1").ativo).toBe(true);
    expect(ips.body.indicadores.tentativas).toBeGreaterThan(0);
    expect((await chamar(amb.app, "POST", "/master/seguranca/ips/desbloquear", { token: master, body: { ip: "200.1.1.1" } })).status).toBe(200);

    const painel = await chamar(amb.app, "GET", "/master/seguranca/painel", { token: master });
    expect(painel.body.config.max_tentativas).toBe(4);
    expect(painel.body.acessos.length).toBeGreaterThan(0);

    const postura = await chamar(amb.app, "POST", "/master/seguranca/postura", { token: master, body: { dias: 30 } });
    expect(postura.status).toBe(200);
    expect(postura.body.pontuacao).toBeGreaterThan(0);
    expect(postura.body.checagens.find((c: { id: string }) => c.id === "hash-senha").status).toBe("ok");
    expect(postura.body.usuarios.length).toBeGreaterThan(0);
    expect(postura.body.resumoTabelas.total).toBeGreaterThan(10);

    await amb.db.query("INSERT INTO log_acessos (email_tentado, sucesso, created_at) VALUES ('velho@x.com', false, now() - interval '400 days')");
    const purga = await chamar(amb.app, "POST", "/master/seguranca/purgar-logs", { token: master, body: { dias: 365 } });
    expect(purga.body.acessos).toBeGreaterThanOrEqual(1);
    expect((await chamar(amb.app, "POST", "/master/seguranca/purgar-logs", { token: master, body: { dias: 10 } })).status).toBe(422);
  });
});
