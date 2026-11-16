import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chamar, criarAmbiente, criarHospital, criarUsuarioDireto, habilitarFeature, tokenDe, type Ambiente } from "./helpers.js";

let amb: Ambiente;
let tenantA: string;
let chefe: string;
let adm: string;
let estacaoSala: string;
let estacaoCme: string;
let estacaoCmeB: string;
let cracha: string;

type Codigo = { id: string; codigo: string };
let caixa: Codigo;
let pinca: Codigo;
let tesoura: Codigo;

/** O que o leitor manda: 8 teclas em 70 ms. */
const VIA_LEITOR = { duracaoMs: 70, teclas: 8, digitado: false };

const post = (token: string, url: string, body: unknown) => chamar(amb.app, "POST", url, { token, body });
const novaCaixa = async (rotulo: string): Promise<Codigo> => (await post(chefe, "/cme/caixas/criar", { rotulo, tipoCaixa: "casa" })).body;
const novoItem = async (caixaId: string, rotulo: string): Promise<Codigo> => (await post(chefe, "/cme/itens/criar", { caixaId, rotulo })).body;
const painel = async (token = chefe) => (await chamar(amb.app, "GET", "/cme/painel", { token })).body;
const statusDe = async (id: string) => (await painel()).caixas.find((c: { id: string }) => c.id === id);
const biparCaixa = (estacao: string, texto: string, extra: Record<string, unknown> = {}) =>
  post(estacao, "/cme/sala/caixa", { token: cracha, texto, ...VIA_LEITOR, ...extra });

beforeAll(async () => {
  amb = await criarAmbiente();
  tenantA = await criarHospital(amb.db, "Hospital A");
  const tenantB = await criarHospital(amb.db, "Hospital B");
  const fa = await habilitarFeature(amb.db, tenantA, "cme");
  const fb = await habilitarFeature(amb.db, tenantB, "cme");
  const salaA = (await amb.db.query<{ id: string }>("INSERT INTO salas (tenant_id, nome) VALUES ($1, 'Sala 5') RETURNING id", [tenantA])).rows[0]!.id;

  await criarUsuarioDireto(amb.db, { email: "master@o.com", role: "master_admin" });
  await criarUsuarioDireto(amb.db, { email: "adm@o.com", role: "hospital_admin", tenantId: tenantA });
  const chefeId = await criarUsuarioDireto(amb.db, { email: "chefe@o.com", role: "operador", tenantId: tenantA, featureId: fa });
  const salaId = await criarUsuarioDireto(amb.db, { email: "sala@o.com", role: "operador", tenantId: tenantA, featureId: fa });
  const cmeId = await criarUsuarioDireto(amb.db, { email: "cme@o.com", role: "operador", tenantId: tenantA, featureId: fa });
  const cmeBId = await criarUsuarioDireto(amb.db, { email: "cme-b@o.com", role: "operador", tenantId: tenantB, featureId: fb });
  await amb.db.query("INSERT INTO cme_contas (usuario_id, tenant_id, tipo) VALUES ($1, $2, 'chefe')", [chefeId, tenantA]);

  const master = await tokenDe(amb.app, "master@o.com");
  adm = await tokenDe(amb.app, "adm@o.com");
  chefe = await tokenDe(amb.app, "chefe@o.com");
  expect((await post(master, "/master/cme/funcao", { usuarioId: salaId, funcao: "estacao_sala", salaId: salaA })).status).toBe(200);
  expect((await post(master, "/master/cme/funcao", { usuarioId: cmeId, funcao: "estacao_cme" })).status).toBe(200);
  expect((await post(master, "/master/cme/funcao", { usuarioId: cmeBId, funcao: "estacao_cme" })).status).toBe(200);
  estacaoSala = await tokenDe(amb.app, "sala@o.com");
  estacaoCme = await tokenDe(amb.app, "cme@o.com");
  estacaoCmeB = await tokenDe(amb.app, "cme-b@o.com");

  caixa = await novaCaixa("Caixa Fluxo");
  pinca = await novoItem(caixa.id, "Pinça Kocher");
  tesoura = await novoItem(caixa.id, "Tesoura Mayo");
  expect((await post(chefe, "/cme/colaboradores/salvar", { nome: "Rita Expurgo", numeroCracha: "700700", perfil: "cme" })).status).toBe(200);
  cracha = (await post(estacaoCme, "/cme/sala/entrar", { cracha: "700700", ...VIA_LEITOR })).body.token;
  expect(cracha).toBeTruthy();
});
afterAll(() => amb.fechar());

describe("computador do CME", () => {
  it("informa a função e não enxerga cadastros nem o painel", async () => {
    expect((await chamar(amb.app, "GET", "/cme/acesso", { token: estacaoCme })).body.tipo).toBe("estacao_cme");
    expect((await chamar(amb.app, "GET", "/cme/caixas", { token: estacaoCme })).status).toBe(403);
    expect((await chamar(amb.app, "GET", "/cme/painel", { token: estacaoCme })).status).toBe(403);
  });

  it("caixa nunca bipada aparece sem movimentação", async () => {
    expect(await statusDe(caixa.id)).toMatchObject({ status: "sem_movimento", desde: null, itens: 2 });
  });

  it("exige o setor antes de bipar a caixa", async () => {
    expect((await biparCaixa(estacaoCme, caixa.codigo)).status).toBe(422);
    expect((await biparCaixa(estacaoCme, caixa.codigo, { setor: "esterilizacao" })).status).toBe(422);
  });
});

describe("status da caixa segue o último bip", () => {
  it("bipada no expurgo fica 'no expurgo' e abre a conferência com o gabarito, sem códigos", async () => {
    const r = await biparCaixa(estacaoCme, caixa.codigo, { setor: "expurgo" });
    expect(r.status).toBe(200);
    expect(r.body.setor).toBe("expurgo");
    expect(r.body.itens.map((i: { rotulo: string; conferido: boolean }) => [i.rotulo, i.conferido])).toEqual([
      ["Pinça Kocher", false],
      ["Tesoura Mayo", false],
    ]);
    expect(JSON.stringify(r.body)).not.toContain(pinca.codigo);
    expect(await statusDe(caixa.id)).toMatchObject({ status: "expurgo" });

    const item = (texto: string) => post(estacaoCme, "/cme/sala/item", { token: cracha, conferenciaId: r.body.conferenciaId, texto, ...VIA_LEITOR });
    expect((await post(estacaoCme, "/cme/sala/finalizar", { token: cracha, conferenciaId: r.body.conferenciaId })).status).toBe(422);
    expect((await item(pinca.codigo)).status).toBe(200);
    expect((await item(tesoura.codigo)).status).toBe(200);
    expect((await post(estacaoCme, "/cme/sala/finalizar", { token: cracha, conferenciaId: r.body.conferenciaId })).status).toBe(200);
    const l = await amb.db.query<{ tela: string }>("SELECT DISTINCT tela FROM cme_leituras WHERE tela LIKE 'expurgo%' ORDER BY tela");
    expect(l.rows.map((x) => x.tela)).toEqual(["expurgo_caixa", "expurgo_conferencia"]);
  });

  it("bipar de novo no mesmo setor não mexe na hora nem repete o histórico", async () => {
    const antes = (await statusDe(caixa.id)).desde;
    expect((await biparCaixa(estacaoCme, caixa.codigo, { setor: "expurgo" })).status).toBe(200);
    expect((await statusDe(caixa.id)).desde).toBe(antes);
    const m = await amb.db.query("SELECT 1 FROM cme_movimentos WHERE caixa_id = $1", [caixa.id]);
    expect(m.rowCount).toBe(1);
  });

  it("bipada no preparo muda para 'em preparo', com conferência própria daquele setor", async () => {
    const r = await biparCaixa(estacaoCme, caixa.codigo, { setor: "preparo" });
    expect(r.status).toBe(200);
    expect(r.body.itens.every((i: { conferido: boolean }) => !i.conferido)).toBe(true);
    expect(await statusDe(caixa.id)).toMatchObject({ status: "preparo" });
  });

  it("bipada na sala cirúrgica mostra em qual sala está", async () => {
    await post(chefe, "/cme/colaboradores/salvar", { nome: "Circulante Sala", numeroCracha: "800800", perfil: "sala" });
    const token = (await post(estacaoSala, "/cme/sala/entrar", { cracha: "800800", ...VIA_LEITOR })).body.token;
    const r = await post(estacaoSala, "/cme/sala/caixa", { token, texto: caixa.codigo, ...VIA_LEITOR });
    expect(r.body.setor).toBe("sala");
    expect(await statusDe(caixa.id)).toMatchObject({ status: "sala", salaNome: "Sala 5" });
    const historico = await amb.db.query<{ setor: string }>("SELECT setor FROM cme_movimentos WHERE caixa_id = $1 ORDER BY created_at", [caixa.id]);
    expect(historico.rows.map((x) => x.setor)).toEqual(["expurgo", "preparo", "sala"]);
  });

  it("o histórico de movimentos não pode ser apagado", async () => {
    await expect(amb.db.query("DELETE FROM cme_movimentos WHERE caixa_id = $1", [caixa.id])).rejects.toThrow();
  });
});

describe("máquinas e ciclos", () => {
  it("só o chefe cadastra; exige pelo menos um ciclo e recusa nome repetido", async () => {
    const corpo = { nome: "Autoclave 1", ciclos: [{ nome: "Leve", duracaoMin: 30 }, { nome: "Pesado", duracaoMin: 60 }] };
    expect((await post(adm, "/cme/maquinas/salvar", corpo)).status).toBe(403);
    expect((await post(chefe, "/cme/maquinas/salvar", { nome: "Autoclave 1", ciclos: [] })).status).toBe(422);
    expect((await post(chefe, "/cme/maquinas/salvar", corpo)).status).toBe(200);
    expect((await post(chefe, "/cme/maquinas/salvar", { ...corpo, nome: "autoclave 1" })).status).toBe(409);

    const r = (await chamar(amb.app, "GET", "/cme/maquinas", { token: adm })).body;
    expect(r.maquinas).toHaveLength(1);
    expect(r.maquinas[0]).toMatchObject({ nome: "Autoclave 1", ativo: true, carga: null, ultimoCiclo: null });
    expect(r.maquinas[0].ciclos.map((c: { nome: string; duracaoMin: number }) => [c.nome, c.duracaoMin])).toEqual([
      ["Leve", 30],
      ["Pesado", 60],
    ]);
  });

  it("editar troca o tempo e inativa o ciclo que saiu da lista", async () => {
    const m = (await chamar(amb.app, "GET", "/cme/maquinas", { token: chefe })).body.maquinas[0];
    const leve = m.ciclos.find((c: { nome: string }) => c.nome === "Leve");
    expect((await post(chefe, "/cme/maquinas/salvar", { id: m.id, nome: "Autoclave 1", ciclos: [{ id: leve.id, nome: "Leve", duracaoMin: 35 }] })).status).toBe(200);
    const depois = (await chamar(amb.app, "GET", "/cme/maquinas", { token: chefe })).body.maquinas[0];
    expect(depois.ciclos).toEqual([{ id: leve.id, nome: "Leve", duracaoMin: 35 }]);
    const guardados = await amb.db.query("SELECT 1 FROM cme_maquina_ciclos WHERE maquina_id = $1", [m.id]);
    expect(guardados.rowCount).toBe(2);
  });
});

describe("esterilização", () => {
  let maquina: { id: string; ciclos: { id: string }[] };
  let maquina2: { id: string; ciclos: { id: string }[] };
  let cargaId: string;
  let outra: Codigo;

  const maquinas = async () => (await chamar(amb.app, "GET", "/cme/esterilizacao/maquinas", { token: estacaoCme })).body.maquinas;
  const abrir = (maquinaId: string, cicloId?: string) => post(estacaoCme, "/cme/esterilizacao/carga/abrir", { token: cracha, maquinaId, cicloId });
  const bipar = (carga: string, texto: string) => post(estacaoCme, "/cme/esterilizacao/carga/caixa", { token: cracha, cargaId: carga, texto, ...VIA_LEITOR });
  const iniciar = (carga: string) => post(estacaoCme, "/cme/esterilizacao/carga/iniciar", { token: cracha, cargaId: carga });

  beforeAll(async () => {
    expect((await post(chefe, "/cme/maquinas/salvar", { nome: "Autoclave 2", ciclos: [{ nome: "Rápido", duracaoMin: 10 }] })).status).toBe(200);
    const todas = await maquinas();
    maquina = todas.find((m: { nome: string }) => m.nome === "Autoclave 1");
    maquina2 = todas.find((m: { nome: string }) => m.nome === "Autoclave 2");
    outra = await novaCaixa("Caixa Vizinha");
  });

  it("só o computador do CME, com crachá, usa a esterilização; outro hospital não vê as máquinas", async () => {
    expect((await chamar(amb.app, "GET", "/cme/esterilizacao/maquinas", { token: estacaoSala })).status).toBe(403);
    expect((await chamar(amb.app, "GET", "/cme/esterilizacao/maquinas", { token: chefe })).status).toBe(403);
    expect((await chamar(amb.app, "GET", "/cme/esterilizacao/maquinas", { token: estacaoCmeB })).body.maquinas).toEqual([]);
    expect((await post(estacaoCme, "/cme/esterilizacao/carga/abrir", { token: "token-que-nao-existe", maquinaId: maquina.id })).status).toBe(422);
    expect((await post(estacaoCmeB, "/cme/esterilizacao/carga/abrir", { token: cracha, maquinaId: maquina.id, cicloId: maquina.ciclos[0]!.id })).status).toBe(422);
  });

  it("abre a carga com o ciclo escolhido e continua nela ao voltar", async () => {
    expect((await abrir(maquina.id)).status).toBe(422);
    const r = await abrir(maquina.id, maquina.ciclos[0]!.id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "montando", cicloNome: "Leve", duracaoMin: 35, caixas: [], maquina: { nome: "Autoclave 1" } });
    cargaId = r.body.id;
    expect((await abrir(maquina.id)).body.id).toBe(cargaId);
    expect((await iniciar(cargaId)).status).toBe(422);
  });

  it("bipa só caixas: peça, código desconhecido e caixa repetida são recusados", async () => {
    expect((await bipar(cargaId, pinca.codigo)).status).toBe(422);
    expect((await bipar(cargaId, "NAO-EXISTE-1")).status).toBe(404);
    const r = await bipar(cargaId, caixa.codigo);
    expect(r.status).toBe(200);
    expect(r.body.carga.caixas.map((c: { rotulo: string }) => c.rotulo)).toEqual(["Caixa Fluxo"]);
    expect(JSON.stringify(r.body)).not.toContain(caixa.codigo);
    expect((await bipar(cargaId, caixa.codigo)).status).toBe(409);
    expect(await statusDe(caixa.id)).toMatchObject({ status: "esterilizacao", maquinaNome: "Autoclave 1" });
  });

  it("caixa bipada em outra máquina sai da carga anterior; a retirada manual também funciona", async () => {
    expect((await bipar(cargaId, outra.codigo)).status).toBe(200);
    const c2 = (await abrir(maquina2.id, maquina2.ciclos[0]!.id)).body;
    expect((await bipar(c2.id, outra.codigo)).status).toBe(200);
    expect((await abrir(maquina.id)).body.caixas.map((c: { id: string }) => c.id)).toEqual([caixa.id]);

    const r = await post(estacaoCme, "/cme/esterilizacao/carga/remover", { token: cracha, cargaId: c2.id, caixaId: outra.id });
    expect(r.status).toBe(200);
    expect(r.body.caixas).toEqual([]);
    // Nunca tinha sido bipada antes da máquina: volta a ficar sem movimentação.
    expect(await statusDe(outra.id)).toMatchObject({ status: "sem_movimento", maquinaNome: null, desde: null });
  });

  it("iniciar o ciclo muda a caixa para 'em ciclo' e trava a carga", async () => {
    const r = await iniciar(cargaId);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("em_ciclo");
    const restanteMin = (new Date(r.body.terminaEm).getTime() - new Date(r.body.agora).getTime()) / 60_000;
    expect(restanteMin).toBeGreaterThan(34.5);
    expect(restanteMin).toBeLessThanOrEqual(35);

    expect(await statusDe(caixa.id)).toMatchObject({ status: "esterilizacao", maquinaNome: "Autoclave 1", cicloNome: "Leve" });
    expect((await iniciar(cargaId)).status).toBe(409);
    expect((await bipar(cargaId, outra.codigo)).status).toBe(409);
    expect((await post(estacaoCme, "/cme/esterilizacao/carga/remover", { token: cracha, cargaId, caixaId: caixa.id })).status).toBe(409);
    // Abrir a máquina em ciclo mostra o ciclo em andamento, não uma carga nova.
    expect((await abrir(maquina.id, maquina.ciclos[0]!.id)).body).toMatchObject({ id: cargaId, status: "em_ciclo" });
    const lista = await maquinas();
    expect(lista.find((m: { id: string }) => m.id === maquina.id).carga).toMatchObject({ status: "em_ciclo", caixas: 1 });

    // Caixa em ciclo não entra em outra máquina.
    const c2 = (await abrir(maquina2.id)).body;
    expect((await bipar(c2.id, caixa.codigo)).status).toBe(409);
  });

  it("quando o tempo acaba a caixa continua 'na esterilização' até a confirmação do arsenal", async () => {
    const arsenal = () => post(estacaoCme, "/cme/esterilizacao/carga/arsenal", { token: cracha, cargaId });
    expect((await arsenal()).status).toBe(409);
    await amb.db.query("UPDATE cme_cargas SET iniciada_em = now() - interval '40 minutes', termina_em = now() - interval '5 minutes' WHERE id = $1", [cargaId]);
    expect(await statusDe(caixa.id)).toMatchObject({ status: "esterilizacao", maquinaNome: "Autoclave 1" });

    // Enquanto ninguém confirma, a máquina continua com a carga e não aceita outra.
    const esperando = (await maquinas()).find((x: { id: string }) => x.id === maquina.id);
    expect(esperando.carga).toMatchObject({ id: cargaId, status: "aguardando_retirada" });
    expect((await abrir(maquina.id, maquina.ciclos[0]!.id)).body).toMatchObject({ id: cargaId, status: "aguardando_retirada" });

    expect((await post(estacaoSala, "/cme/esterilizacao/carga/arsenal", { token: cracha, cargaId })).status).toBe(403);
    expect((await arsenal()).body).toEqual({ ok: true, caixas: 1 });
    expect((await arsenal()).status).toBe(409);
    expect(await statusDe(caixa.id)).toMatchObject({ status: "arsenal", maquinaNome: null });
    const historico = await amb.db.query<{ setor: string }>("SELECT setor FROM cme_movimentos WHERE caixa_id = $1 ORDER BY created_at DESC LIMIT 1", [caixa.id]);
    expect(historico.rows[0]!.setor).toBe("arsenal");

    const m = (await maquinas()).find((x: { id: string }) => x.id === maquina.id);
    expect(m.carga).toBeNull();
    expect(m.ultimoCiclo).toMatchObject({ id: cargaId, status: "concluida", cicloNome: "Leve" });
    const nova = await abrir(maquina.id, maquina.ciclos[0]!.id);
    expect(nova.body.status).toBe("montando");
    expect(nova.body.id).not.toBe(cargaId);
  });

  it("cancelar o ciclo só existe no modo de teste e devolve as caixas ao setor anterior", async () => {
    const cx = await novaCaixa("Caixa do Cancelamento");
    expect((await biparCaixa(estacaoCme, cx.codigo, { setor: "preparo" })).status).toBe(200);
    const c2 = (await abrir(maquina2.id)).body;
    expect((await bipar(c2.id, cx.codigo)).status).toBe(200);
    expect((await iniciar(c2.id)).status).toBe(200);
    const cancelar = () => post(estacaoCme, "/cme/esterilizacao/carga/cancelar", { token: cracha, cargaId: c2.id });
    expect((await cancelar()).status).toBe(403);

    const cfg = { tamanhoPadraoMm: 5, moduloMinimoMm: 0.17, moduloAvisoMm: 0.19, matrizMaxima5mm: 24 };
    expect((await post(chefe, "/cme/config", { ...cfg, permitirCrachaDigitado: true })).status).toBe(200);
    expect((await cancelar()).status).toBe(200);
    expect(await statusDe(cx.id)).toMatchObject({ status: "preparo", maquinaNome: null });
    expect((await maquinas()).find((m: { id: string }) => m.id === maquina2.id).carga).toBeNull();
    expect((await post(chefe, "/cme/config", { ...cfg, permitirCrachaDigitado: false })).status).toBe(200);
    await post(chefe, "/cme/codigos/situacao", { id: cx.id, ativo: false });
  });

  it("o painel resume os status e os ciclos das últimas 24 horas", async () => {
    const p = await painel(adm);
    expect(p.resumo).toMatchObject({ arsenal: 1, esterilizacao: 0, sala: 0, sem_movimento: 1 });
    expect(p.ultimas24h).toEqual({ ciclos: 1, caixasEsterilizadas: 1 });
    expect(p.maquinas.map((m: { nome: string }) => m.nome)).toEqual(["Autoclave 1", "Autoclave 2"]);
    expect(JSON.stringify(p.caixas)).not.toContain(caixa.codigo);
  });

  it("do arsenal, o bip na sala volta a caixa para 'na sala'", async () => {
    const token = (await post(estacaoSala, "/cme/sala/entrar", { cracha: "800800", ...VIA_LEITOR })).body.token;
    expect((await post(estacaoSala, "/cme/sala/caixa", { token, texto: caixa.codigo, ...VIA_LEITOR })).status).toBe(200);
    expect(await statusDe(caixa.id)).toMatchObject({ status: "sala", maquinaNome: null });
    // A carga que já rodou continua com a caixa: é histórico.
    const h = await amb.db.query("SELECT 1 FROM cme_carga_caixas WHERE carga_id = $1 AND caixa_id = $2", [cargaId, caixa.id]);
    expect(h.rowCount).toBe(1);
  });
});
