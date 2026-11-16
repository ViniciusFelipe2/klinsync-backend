import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pareceLeitor } from "../src/lib/cme.js";
import { chamar, criarAmbiente, criarHospital, criarUsuarioDireto, habilitarFeature, tokenDe, type Ambiente } from "./helpers.js";

let amb: Ambiente;
let tenantA: string;
let tenantB: string;
let salaA: string;
let salaB: string;
let chefe: string;
let chefeB: string;
let adm: string;
let master: string;
let estacao: string;
let estacaoId: string;
let estacaoB: string;

/** O que o leitor manda: 8 teclas em 70 ms. */
const VIA_LEITOR = { duracaoMs: 70, teclas: 8, digitado: false };

const post = (token: string, url: string, body: unknown) => chamar(amb.app, "POST", url, { token, body });
const novaCaixa = async (token: string, rotulo = "Laparotomia", extra: Record<string, unknown> = {}) =>
  (await post(token, "/cme/caixas/criar", { rotulo, tipoCaixa: "casa", ...extra })).body;
const novoItem = async (token: string, caixaId: string, rotulo = "Pinça Kelly", extra: Record<string, unknown> = {}) =>
  (await post(token, "/cme/itens/criar", { caixaId, rotulo, ...extra })).body;
const novoColaborador = async (token: string, numeroCracha: string, nome = "Maria Souza", perfil = "sala") =>
  post(token, "/cme/colaboradores/salvar", { nome, numeroCracha, perfil });
const entrar = (token: string, cracha: string, leitura: Record<string, unknown> = VIA_LEITOR) => post(token, "/cme/sala/entrar", { cracha, ...leitura });

beforeAll(async () => {
  amb = await criarAmbiente();
  tenantA = await criarHospital(amb.db, "Hospital A");
  tenantB = await criarHospital(amb.db, "Hospital B");
  const fa = await habilitarFeature(amb.db, tenantA, "cme");
  const fb = await habilitarFeature(amb.db, tenantB, "cme");
  const sala = async (t: string, nome: string) =>
    (await amb.db.query<{ id: string }>("INSERT INTO salas (tenant_id, nome) VALUES ($1, $2) RETURNING id", [t, nome])).rows[0]!.id;
  salaA = await sala(tenantA, "Sala 5");
  salaB = await sala(tenantB, "Sala B1");

  await criarUsuarioDireto(amb.db, { email: "master@c.com", role: "master_admin" });
  await criarUsuarioDireto(amb.db, { email: "adm@c.com", role: "hospital_admin", tenantId: tenantA });
  const chefeId = await criarUsuarioDireto(amb.db, { email: "chefe@c.com", role: "operador", tenantId: tenantA, featureId: fa });
  const chefeBId = await criarUsuarioDireto(amb.db, { email: "chefe-b@c.com", role: "operador", tenantId: tenantB, featureId: fb });
  estacaoId = await criarUsuarioDireto(amb.db, { email: "sala5@c.com", role: "operador", tenantId: tenantA, featureId: fa });
  const estacaoBId = await criarUsuarioDireto(amb.db, { email: "salab@c.com", role: "operador", tenantId: tenantB, featureId: fb });
  await amb.db.query("INSERT INTO cme_contas (usuario_id, tenant_id, tipo) VALUES ($1, $2, 'chefe'), ($3, $4, 'chefe')", [chefeId, tenantA, chefeBId, tenantB]);

  master = await tokenDe(amb.app, "master@c.com");
  adm = await tokenDe(amb.app, "adm@c.com");
  chefe = await tokenDe(amb.app, "chefe@c.com");
  chefeB = await tokenDe(amb.app, "chefe-b@c.com");

  // O master define os computadores de sala, como faria pela tela.
  expect((await post(master, "/master/cme/funcao", { usuarioId: estacaoId, funcao: "estacao_sala", salaId: salaA })).status).toBe(200);
  expect((await post(master, "/master/cme/funcao", { usuarioId: estacaoBId, funcao: "estacao_sala", salaId: salaB })).status).toBe(200);
  estacao = await tokenDe(amb.app, "sala5@c.com");
  estacaoB = await tokenDe(amb.app, "salab@c.com");
});
afterAll(() => amb.fechar());

describe("caixas e itens", () => {
  it("cria a caixa com código próprio e os itens dentro dela", async () => {
    const cx = await novaCaixa(chefe, "Caixa Ortopedia");
    expect(cx.codigo).toMatch(/^1\d{7}$/);
    const item = await novoItem(chefe, cx.id, "Afastador");
    expect(item.codigo).toMatch(/^2\d{7}$/);

    const r = (await chamar(amb.app, "GET", "/cme/caixas?busca=Ortopedia", { token: chefe })).body;
    const achada = r.caixas.find((c: { id: string }) => c.id === cx.id);
    expect(achada.itens.map((i: { rotulo: string }) => i.rotulo)).toEqual(["Afastador"]);
    expect(achada.itens[0].avaliacao.modulosPorLado).toBe(12);
  });

  it("a busca pelo nome de um item encontra a caixa dele", async () => {
    const cx = await novaCaixa(chefe, "Caixa Cesárea");
    await novoItem(chefe, cx.id, "Valva suprapúbica");
    const r = (await chamar(amb.app, "GET", "/cme/caixas?busca=suprap", { token: chefe })).body;
    expect(r.caixas.map((c: { rotulo: string }) => c.rotulo)).toEqual(["Caixa Cesárea"]);
  });

  it("aceita o código que já está gravado na peça", async () => {
    const cx = await novaCaixa(chefe, "Caixa Consignada", { tipoCaixa: "consignada", codigoGravado: "FORN-CX-77" });
    expect(cx.origem).toBe("existente");
    const item = await novoItem(chefe, cx.id, "Broca", { codigoGravado: "]d2FORN-BR-01\r" });
    expect(item.codigo).toBe("FORN-BR-01");
    expect((await post(chefe, "/cme/itens/criar", { caixaId: cx.id, rotulo: "Repetido", codigoGravado: "FORN-BR-01" })).status).toBe(409);
  });

  it("item sem caixa aparece separado e pode ser colocado numa caixa", async () => {
    const solto = (await post(chefe, "/cme/codigos/gerar", { tipo: "item", rotulo: "Peça de teste" })).body;
    let r = (await chamar(amb.app, "GET", "/cme/caixas", { token: chefe })).body;
    expect(r.semCaixa.map((i: { id: string }) => i.id)).toContain(solto.id);

    const cx = await novaCaixa(chefe, "Caixa Destino");
    expect((await post(chefe, "/cme/itens/mover", { id: solto.id, caixaId: cx.id })).status).toBe(200);
    r = (await chamar(amb.app, "GET", "/cme/caixas", { token: chefe })).body;
    expect(r.semCaixa.map((i: { id: string }) => i.id)).not.toContain(solto.id);
    expect(r.caixas.find((c: { id: string }) => c.id === cx.id).itens[0].id).toBe(solto.id);
  });

  it("não coloca item em caixa inativa nem de outro hospital", async () => {
    const inativa = await novaCaixa(chefe, "Caixa Inativa");
    await post(chefe, "/cme/codigos/situacao", { id: inativa.id, ativo: false });
    expect((await post(chefe, "/cme/itens/criar", { caixaId: inativa.id, rotulo: "Tesoura" })).status).toBe(404);
    const deOutro = await novaCaixa(chefeB, "Caixa do B");
    expect((await post(chefe, "/cme/itens/criar", { caixaId: deOutro.id, rotulo: "Tesoura" })).status).toBe(404);
  });

  it("edita nome e tipo da caixa e o nome do item", async () => {
    const cx = await novaCaixa(chefe, "Nome antigo");
    const item = await novoItem(chefe, cx.id, "Item antigo");
    expect((await post(chefe, "/cme/caixas/editar", { id: cx.id, rotulo: "Nome novo", tipoCaixa: "consignada" })).status).toBe(200);
    expect((await post(chefe, "/cme/itens/editar", { id: item.id, rotulo: "Item novo" })).status).toBe(200);
    const r = (await chamar(amb.app, "GET", "/cme/caixas?busca=Nome novo", { token: chefe })).body;
    expect(r.caixas[0]).toMatchObject({ rotulo: "Nome novo", tipo_caixa: "consignada" });
    expect(r.caixas[0].itens[0].rotulo).toBe("Item novo");
  });

  it("administrador vê, mas não cadastra; outro hospital não vê", async () => {
    const cx = await novaCaixa(chefe, "Caixa Só do A");
    expect((await chamar(amb.app, "GET", "/cme/caixas", { token: adm })).body.caixas.some((c: { id: string }) => c.id === cx.id)).toBe(true);
    expect((await post(adm, "/cme/caixas/criar", { rotulo: "Caixa do admin", tipoCaixa: "casa" })).status).toBe(403);
    expect((await post(adm, "/cme/itens/criar", { caixaId: cx.id, rotulo: "Item do admin" })).status).toBe(403);
    expect((await chamar(amb.app, "GET", "/cme/caixas", { token: chefeB })).body.caixas.some((c: { id: string }) => c.id === cx.id)).toBe(false);
  });
});

describe("colaboradores", () => {
  it("cadastra com o número do crachá em maiúsculas e recusa número repetido", async () => {
    const r = await novoColaborador(chefe, "ab-1234", "João Lima");
    expect(r.status).toBe(200);
    expect(r.body.numero_cracha).toBe("AB-1234");
    const repetido = await novoColaborador(chefe, "AB-1234", "Outro");
    expect(repetido.status).toBe(409);
    expect(repetido.body.message).toMatch(/número de crachá/);
    // O mesmo número em outro hospital é permitido.
    expect((await novoColaborador(chefeB, "AB-1234", "João do B")).status).toBe(200);
  });

  it("recusa número de crachá curto demais ou com símbolos", async () => {
    expect((await novoColaborador(chefe, "12")).status).toBe(422);
    expect((await novoColaborador(chefe, "12 34*")).status).toBe(422);
  });

  it("imprime o crachá com o Data Matrix do número", async () => {
    const c = (await novoColaborador(chefe, "900100", "Ana Paula")).body;
    const r = await post(chefe, "/cme/crachas/impressao", { ids: [c.id] });
    expect(r.status).toBe(200);
    expect(r.body.tamanhoMm).toBe(12);
    expect(r.body.linhas[0]).toMatchObject({ nome: "Ana Paula", numero_cracha: "900100" });
    expect(r.body.linhas[0].matriz.length).toBe(10);
    expect((await post(adm, "/cme/crachas/impressao", { ids: [c.id] })).status).toBe(403);
  });

  it("administrador consulta a lista, mas não cadastra", async () => {
    expect((await chamar(amb.app, "GET", "/cme/colaboradores", { token: adm })).status).toBe(200);
    expect((await novoColaborador(adm, "555555")).status).toBe(403);
  });
});

describe("login por crachá no computador da sala", () => {
  let cracha: string;
  let colaboradorId: string;

  beforeAll(async () => {
    const r = await novoColaborador(chefe, "700700", "Carla Dias");
    cracha = r.body.numero_cracha;
    colaboradorId = r.body.id;
  });

  it("a medição de velocidade separa leitor de digitação", () => {
    expect(pareceLeitor(70, 8)).toBe(true);
    expect(pareceLeitor(2000, 8)).toBe(false);
    expect(pareceLeitor(undefined, undefined)).toBe(false);
  });

  it("entra pelo leitor e mostra quem está logado", async () => {
    const r = await entrar(estacao, cracha);
    expect(r.status).toBe(200);
    expect(r.body.colaborador).toMatchObject({ nome: "Carla Dias", numeroCracha: "700700" });
    expect(r.body.inatividadeMin).toBe(15);
    expect((await post(estacao, "/cme/sala/sessao", { token: r.body.token })).body.colaborador.nome).toBe("Carla Dias");
  });

  it("com a digitação desligada, recusa o número digitado ou lento", async () => {
    const digitado = await entrar(estacao, cracha, { digitado: true });
    expect(digitado.status).toBe(422);
    expect(digitado.body.message).toMatch(/Bipe o crachá no leitor/);
    expect((await entrar(estacao, cracha, { duracaoMs: 3000, teclas: 6 })).status).toBe(422);
  });

  it("com a chave de teste ligada pelo chefe, aceita o número digitado", async () => {
    const base = { tamanhoPadraoMm: 5, moduloMinimoMm: 0.17, moduloAvisoMm: 0.19, matrizMaxima5mm: 24 };
    expect((await post(chefe, "/cme/config", { ...base, permitirCrachaDigitado: true })).status).toBe(200);
    expect((await entrar(estacao, cracha, { digitado: true })).status).toBe(200);
    expect((await post(chefe, "/cme/config", { ...base, permitirCrachaDigitado: false })).status).toBe(200);
  });

  it("crachá desconhecido é recusado sem derrubar o login do computador", async () => {
    const r = await entrar(estacao, "000000");
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/não reconhecido/);
  });

  it("o crachá não funciona fora do computador de sala", async () => {
    expect((await entrar(chefe, cracha)).status).toBe(403);
    expect((await entrar(adm, cracha)).status).toBe(403);
    // Computador de sala de outro hospital não reconhece o crachá deste.
    expect((await entrar(estacaoB, cracha)).status).toBe(422);
  });

  it("o computador de sala não enxerga os cadastros", async () => {
    expect((await chamar(amb.app, "GET", "/cme/caixas", { token: estacao })).status).toBe(403);
    expect((await chamar(amb.app, "GET", "/cme/colaboradores", { token: estacao })).status).toBe(403);
  });

  it("um novo crachá encerra a sessão anterior do mesmo computador", async () => {
    const outro = (await novoColaborador(chefe, "700701", "Bruno Reis")).body;
    const primeira = (await entrar(estacao, cracha)).body.token;
    expect((await entrar(estacao, outro.numero_cracha)).status).toBe(200);
    const r = await post(estacao, "/cme/sala/sessao", { token: primeira });
    expect(r.status).toBe(422);
    expect(r.body.sessaoEncerrada).toBe(true);
  });

  it("sai sozinho depois de 15 minutos sem uso", async () => {
    const token = (await entrar(estacao, cracha)).body.token;
    await amb.db.query("UPDATE cme_sessoes_cracha SET ultimo_uso = now() - interval '16 minutes' WHERE encerrada_em IS NULL AND estacao_id = $1", [estacaoId]);
    expect((await post(estacao, "/cme/sala/sessao", { token })).status).toBe(422);
    const s = await amb.db.query<{ motivo_fim: string }>("SELECT motivo_fim FROM cme_sessoes_cracha ORDER BY criada_em DESC LIMIT 1");
    expect(s.rows[0]!.motivo_fim).toBe("inatividade");
  });

  it("sair encerra a sessão", async () => {
    const token = (await entrar(estacao, cracha)).body.token;
    expect((await post(estacao, "/cme/sala/sair", { token })).status).toBe(200);
    expect((await post(estacao, "/cme/sala/sessao", { token })).status).toBe(422);
  });

  it("colaborador inativado perde o acesso na hora", async () => {
    const c = (await novoColaborador(chefe, "700702", "Desligado")).body;
    const token = (await entrar(estacao, c.numero_cracha)).body.token;
    expect((await post(chefe, "/cme/colaboradores/situacao", { id: c.id, ativo: false })).status).toBe(200);
    expect((await post(estacao, "/cme/sala/sessao", { token })).status).toBe(422);
    expect((await entrar(estacao, c.numero_cracha)).status).toBe(422);
  });

  it("bipou a caixa: mostra os itens dela e registra quem leu", async () => {
    const cx = await novaCaixa(chefe, "Caixa da Sala");
    await novoItem(chefe, cx.id, "Pinça Allis");
    await novoItem(chefe, cx.id, "Bisturi cabo 4");
    const token = (await entrar(estacao, cracha)).body.token;

    const r = await post(estacao, "/cme/sala/caixa", { token, texto: `${cx.codigo}\r`, ...VIA_LEITOR });
    expect(r.status).toBe(200);
    expect(r.body.caixa.rotulo).toBe("Caixa da Sala");
    expect(r.body.itens.map((i: { rotulo: string }) => i.rotulo)).toEqual(["Bisturi cabo 4", "Pinça Allis"]);
    const l = await amb.db.query<{ colaborador_id: string; tela: string }>("SELECT colaborador_id, tela FROM cme_leituras WHERE codigo_id = $1", [cx.id]);
    expect(l.rows[0]).toMatchObject({ colaborador_id: colaboradorId, tela: "sala_caixa" });

    expect((await post(estacao, "/cme/sala/caixa", { token, texto: "99999999", ...VIA_LEITOR })).status).toBe(404);
    expect((await post(estacao, "/cme/sala/caixa", { token, texto: cx.codigo, digitado: true })).status).toBe(422);
    expect((await post(estacao, "/cme/sala/caixa", { token, texto: cx.codigo, digitado: true, motivo: "Etiqueta molhada" })).status).toBe(200);
  });

  it("registra entrada e saída na auditoria, sem o nome do colaborador", async () => {
    const a = await amb.db.query<{ detalhes: Record<string, unknown> }>("SELECT detalhes FROM cme_auditoria WHERE acao = 'cme_cracha_entrou' LIMIT 1");
    expect(a.rows[0]!.detalhes).toHaveProperty("colaboradorId");
    expect(JSON.stringify(a.rows[0]!.detalhes)).not.toContain("Carla");
  });
});

describe("conferência da caixa na sala", () => {
  let token: string;
  let caixa: { id: string; codigo: string };
  let pinca: { id: string; codigo: string };
  let tesoura: { id: string; codigo: string };
  let deOutraCaixa: { codigo: string };

  const abrir = (texto: string) => post(estacao, "/cme/sala/caixa", { token, texto, ...VIA_LEITOR });
  const bipar = (conferenciaId: string, texto: string, extra: Record<string, unknown> = VIA_LEITOR) =>
    post(estacao, "/cme/sala/item", { token, conferenciaId, texto, ...extra });

  beforeAll(async () => {
    caixa = await novaCaixa(chefe, "Caixa Conferência");
    pinca = await novoItem(chefe, caixa.id, "Pinça Kocher");
    tesoura = await novoItem(chefe, caixa.id, "Tesoura Mayo");
    const outra = await novaCaixa(chefe, "Caixa Vizinha");
    deOutraCaixa = await novoItem(chefe, outra.id, "Afastador Gelpi");
    const c = (await novoColaborador(chefe, "910910", "Paula Conferente")).body;
    token = (await entrar(estacao, c.numero_cracha)).body.token;
  });

  it("bipar a caixa abre a conferência com o gabarito, nada conferido", async () => {
    const r = await abrir(caixa.codigo);
    expect(r.status).toBe(200);
    expect(r.body.conferenciaId).toBeTruthy();
    expect(r.body.itens.map((i: { rotulo: string; conferido: boolean }) => [i.rotulo, i.conferido])).toEqual([
      ["Pinça Kocher", false],
      ["Tesoura Mayo", false],
    ]);
  });

  it("confere item por item, recusa repetido, de outra caixa, de caixa e desconhecido", async () => {
    const { conferenciaId } = (await abrir(caixa.codigo)).body;

    const ok = await bipar(conferenciaId, pinca.codigo);
    expect(ok.status).toBe(200);
    expect(ok.body.itens.filter((i: { conferido: boolean }) => i.conferido)).toHaveLength(1);

    const repetido = await bipar(conferenciaId, pinca.codigo);
    expect(repetido.status).toBe(409);
    expect(repetido.body.message).toMatch(/já foi conferido/);

    const outra = await bipar(conferenciaId, deOutraCaixa.codigo);
    expect(outra.status).toBe(422);
    expect(outra.body.message).toMatch(/não pertence a esta caixa.*Caixa Vizinha/);

    expect((await bipar(conferenciaId, caixa.codigo)).status).toBe(422);
    expect((await bipar(conferenciaId, "NAO-EXISTE-99")).status).toBe(404);
  });

  it("toda leitura recusada fica registrada, com quem bipou", async () => {
    const r = await amb.db.query<{ resultado: string; n: number }>(
      "SELECT resultado, count(*)::int AS n FROM cme_leituras WHERE tela = 'sala_conferencia' GROUP BY resultado ORDER BY resultado",
    );
    // 1 conferido + 1 repetido + 1 de outra caixa + 1 código de caixa = 4 reconhecidos; 1 desconhecido.
    expect(r.rows).toEqual([
      { resultado: "desconhecido", n: 1 },
      { resultado: "reconhecido", n: 4 },
    ]);
    const semColaborador = await amb.db.query("SELECT 1 FROM cme_leituras WHERE tela = 'sala_conferencia' AND colaborador_id IS NULL");
    expect(semColaborador.rowCount).toBe(0);
  });

  it("caixa desconhecida também fica registrada como leitura", async () => {
    expect((await abrir("CAIXA-FANTASMA")).status).toBe(404);
    const r = await amb.db.query("SELECT 1 FROM cme_leituras WHERE tela = 'sala_caixa' AND texto_normalizado = 'CAIXA-FANTASMA'");
    expect(r.rowCount).toBe(1);
  });

  it("bipar a caixa de novo retoma a mesma conferência, sem perder o que já foi conferido", async () => {
    const r = (await abrir(caixa.codigo)).body;
    expect(r.itens.find((i: { rotulo: string }) => i.rotulo === "Pinça Kocher").conferido).toBe(true);
  });

  it("digitar a peça exige o motivo", async () => {
    const { conferenciaId } = (await abrir(caixa.codigo)).body;
    expect((await bipar(conferenciaId, tesoura.codigo, { digitado: true })).status).toBe(422);
  });

  it("só finaliza com todos os itens conferidos", async () => {
    const { conferenciaId } = (await abrir(caixa.codigo)).body;
    const cedo = await post(estacao, "/cme/sala/finalizar", { token, conferenciaId });
    expect(cedo.status).toBe(422);
    expect(cedo.body.message).toMatch(/falta 1 item/);

    expect((await bipar(conferenciaId, tesoura.codigo, { digitado: true, motivo: "Código gasto" })).status).toBe(200);
    const fim = await post(estacao, "/cme/sala/finalizar", { token, conferenciaId });
    expect(fim.status).toBe(200);
    expect(fim.body.itens).toBe(2);

    expect((await bipar(conferenciaId, pinca.codigo)).status).toBe(409);
    const c = await amb.db.query<{ status: string; itens_esperados: number }>("SELECT status, itens_esperados FROM cme_conferencias WHERE id = $1", [conferenciaId]);
    expect(c.rows[0]).toEqual({ status: "concluida", itens_esperados: 2 });
  });

  it("depois de finalizada, bipar a caixa começa uma conferência nova", async () => {
    const r = (await abrir(caixa.codigo)).body;
    expect(r.itens.every((i: { conferido: boolean }) => !i.conferido)).toBe(true);
  });

  it("outro computador de sala não mexe nesta conferência", async () => {
    const { conferenciaId } = (await abrir(caixa.codigo)).body;
    const c = (await novoColaborador(chefeB, "920920", "Do outro hospital")).body;
    const tokenB = (await entrar(estacaoB, c.numero_cracha)).body.token;
    const r = await post(estacaoB, "/cme/sala/item", { token: tokenB, conferenciaId, texto: pinca.codigo, ...VIA_LEITOR });
    expect(r.status).toBe(404);
  });

  it("a peça conferida não pode ser apagada nem alterada", async () => {
    await expect(amb.db.query("DELETE FROM cme_conferencia_itens")).rejects.toThrow(/não podem ser alterados/);
  });
});

describe("funções definidas pelo master", () => {
  it("computador de sala exige uma sala do mesmo hospital", async () => {
    const id = await criarUsuarioDireto(amb.db, {
      email: "sala-x@c.com",
      role: "operador",
      tenantId: tenantA,
      featureId: (await amb.db.query<{ id: string }>("SELECT id FROM features WHERE chave = 'cme'")).rows[0]!.id,
    });
    expect((await post(master, "/master/cme/funcao", { usuarioId: id, funcao: "estacao_sala" })).status).toBe(422);
    expect((await post(master, "/master/cme/funcao", { usuarioId: id, funcao: "estacao_sala", salaId: salaB })).status).toBe(404);
    expect((await post(chefe, "/master/cme/funcao", { usuarioId: id, funcao: "estacao_sala", salaId: salaA })).status).toBe(403);
  });

  it("a tela informa a sala do computador", async () => {
    const r = (await chamar(amb.app, "GET", "/cme/acesso", { token: estacao })).body;
    expect(r).toMatchObject({ tipo: "estacao_sala", podeEditar: false, sala: { nome: "Sala 5" } });
  });

  it("remover a função derruba quem estava logado no computador", async () => {
    const c = (await novoColaborador(chefe, "800800", "Teste Função")).body;
    const token = (await entrar(estacao, c.numero_cracha)).body.token;
    expect((await post(master, "/master/cme/funcao", { usuarioId: estacaoId, funcao: "estacao_sala", salaId: salaA })).status).toBe(200);
    expect((await post(estacao, "/cme/sala/sessao", { token })).status).toBe(422);
  });

  it("hospital com colaboradores cadastrados não pode ser excluído", async () => {
    await amb.db.query("UPDATE tenants SET status = 'inativo' WHERE id = $1", [tenantB]);
    const r = await post(master, "/master/hospitais/excluir", { id: tenantB, confirmarNome: "Hospital B" });
    expect(r.status).toBe(409);
    await amb.db.query("UPDATE tenants SET status = 'ativo' WHERE id = $1", [tenantB]);
  });
});
