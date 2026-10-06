import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chamar, criarAmbiente, criarHospital, criarUsuarioDireto, habilitarFeature, tokenDe, type Ambiente } from "./helpers.js";

let amb: Ambiente;
let tenantA: string;
let salaA1: string;
let salaA2: string;
let salaB1: string;
let op: string;
let opB: string;
let adm: string;
let master: string;
let opId: string;

const sala = async (id: string) => (await amb.db.query("SELECT status_atual, cirurgia_atual FROM salas WHERE id = $1", [id])).rows[0]!;
const iniciar = (token: string, salaId: string, tipo: string) => chamar(amb.app, "POST", "/giro/etapas/iniciar", { token, body: { salaId, tipo } });
const finalizar = (token: string, eventoId: string, cirurgiaProxima?: string) =>
  chamar(amb.app, "POST", "/giro/etapas/finalizar", { token, body: { eventoId, ...(cirurgiaProxima ? { cirurgiaProxima } : {}) } });
const abertos = async (token: string) => (await chamar(amb.app, "GET", "/giro/eventos?abertos=true", { token })).body as { id: string; sala_id: string; tipo_evento: string }[];

beforeAll(async () => {
  amb = await criarAmbiente();
  tenantA = await criarHospital(amb.db, "Hospital A");
  const tenantB = await criarHospital(amb.db, "Hospital B");
  const fa = await habilitarFeature(amb.db, tenantA, "giro_de_sala");
  const fb = await habilitarFeature(amb.db, tenantB, "giro_de_sala");
  const ins = async (t: string, nome: string, ativa = true) =>
    (await amb.db.query<{ id: string }>("INSERT INTO salas (tenant_id, nome, ativa) VALUES ($1, $2, $3) RETURNING id", [t, nome, ativa])).rows[0]!.id;
  salaA1 = await ins(tenantA, "Sala 1");
  salaA2 = await ins(tenantA, "Sala 2");
  salaB1 = await ins(tenantB, "Sala B1");
  await ins(tenantA, "Sala Inativa", false);
  await criarUsuarioDireto(amb.db, { email: "master@t.com", role: "master_admin" });
  opId = await criarUsuarioDireto(amb.db, { email: "op@t.com", role: "operador", tenantId: tenantA, featureId: fa });
  await criarUsuarioDireto(amb.db, { email: "op-b@t.com", role: "operador", tenantId: tenantB, featureId: fb });
  await criarUsuarioDireto(amb.db, { email: "adm@t.com", role: "hospital_admin", tenantId: tenantA });
  master = await tokenDe(amb.app, "master@t.com");
  op = await tokenDe(amb.app, "op@t.com");
  opB = await tokenDe(amb.app, "op-b@t.com");
  adm = await tokenDe(amb.app, "adm@t.com");
});
afterAll(() => amb.fechar());

describe("leitura e isolamento por hospital", () => {
  it("lista só as salas ativas do próprio hospital; master vê todos", async () => {
    const a = await chamar(amb.app, "GET", "/giro/salas", { token: op });
    expect(a.body.map((s: { nome: string }) => s.nome)).toEqual(["Sala 1", "Sala 2"]);
    expect((await chamar(amb.app, "GET", "/giro/salas", { token: opB })).body).toHaveLength(1);
    expect((await chamar(amb.app, "GET", "/giro/salas", { token: master })).body).toHaveLength(3);
  });

  it("operador de outro hospital não age nas salas alheias", async () => {
    expect((await iniciar(opB, salaA1, "desmontagem")).status).toBe(404);
    expect((await chamar(amb.app, "POST", "/giro/paradas/iniciar", { token: opB, body: { salaId: salaA1 } })).status).toBe(404);
    expect((await chamar(amb.app, "POST", "/giro/reservas/reservar", { token: opB, body: { salaId: salaA1, deviceId: "t-1" } })).status).toBe(404);
  });

  it("validação de parâmetros de consulta", async () => {
    expect((await chamar(amb.app, "GET", "/giro/historico?de=x&ate=y", { token: op })).status).toBe(422);
    expect((await chamar(amb.app, "GET", "/giro/eventos?horas=9999", { token: op })).status).toBe(422);
  });
});

describe("ciclo de giro (enfermagem + limpeza)", () => {
  it("segue as regras da tela operacional e atualiza o status da sala", async () => {
    // inativa não inicia; limpeza não começa antes da enfermagem
    expect((await iniciar(op, salaA1, "limpeza")).status).toBe(422);
    await amb.db.query("UPDATE salas SET cirurgia_atual = 'Colecistectomia — Dr. Silva' WHERE id = $1", [salaA1]);

    expect((await iniciar(op, salaA1, "desmontagem")).status).toBe(200);
    expect(await sala(salaA1)).toMatchObject({ status_atual: "desmontagem" });
    expect((await iniciar(op, salaA1, "desmontagem")).status).toBe(409); // já iniciada

    const ev = await abertos(op);
    const enf = ev.find((e) => e.tipo_evento === "desmontagem")!;
    const linhaEnf = (await amb.db.query("SELECT cirurgia_anterior, usuario_inicio_id FROM eventos_giro WHERE id = $1", [enf.id])).rows[0]!;
    expect(linhaEnf["cirurgia_anterior"]).toBe("Colecistectomia — Dr. Silva");
    expect(linhaEnf["usuario_inicio_id"]).toBe(opId); // quem inicia vem do token

    // enfermagem não finaliza sem limpeza finalizada nem sem a próxima cirurgia
    expect((await finalizar(op, enf.id, "Apendicectomia")).status).toBe(422);
    expect((await iniciar(op, salaA1, "limpeza")).status).toBe(200);
    expect(await sala(salaA1)).toMatchObject({ status_atual: "limpeza" });
    expect((await iniciar(op, salaA1, "limpeza")).status).toBe(409);
    expect((await finalizar(op, enf.id, "Apendicectomia")).status).toBe(422); // limpeza ainda aberta

    const limp = (await abertos(op)).find((e) => e.tipo_evento === "limpeza")!;
    expect((await finalizar(op, limp.id)).status).toBe(200);
    expect(await sala(salaA1)).toMatchObject({ status_atual: "desmontagem" }); // volta para a enfermagem em curso
    expect((await iniciar(op, salaA1, "limpeza")).status).toBe(422); // limpeza do ciclo já finalizada
    expect((await finalizar(op, limp.id)).status).toBe(409); // etapa já finalizada

    expect((await finalizar(op, enf.id)).status).toBe(422); // próxima cirurgia obrigatória
    expect((await finalizar(op, enf.id, "Apendicectomia — Dra. Souza")).status).toBe(200);
    expect(await sala(salaA1)).toMatchObject({ status_atual: "livre", cirurgia_atual: "Apendicectomia — Dra. Souza" });

    const fim = (await amb.db.query("SELECT fim, duracao_segundos, cirurgia_proxima, usuario_fim_id FROM eventos_giro WHERE id = $1", [enf.id])).rows[0]!;
    expect(fim["fim"]).not.toBeNull();
    expect(fim["duracao_segundos"]).toBeGreaterThanOrEqual(0);
    expect(fim["cirurgia_proxima"]).toBe("Apendicectomia — Dra. Souza");
    expect(fim["usuario_fim_id"]).toBe(opId);
    expect(await abertos(op)).toHaveLength(0);

    // novo ciclo na mesma sala, agora com a cirurgia anterior atualizada
    expect((await iniciar(op, salaA1, "desmontagem")).status).toBe(200);
    const novo = (await abertos(op))[0]!;
    expect((await amb.db.query("SELECT cirurgia_anterior FROM eventos_giro WHERE id = $1", [novo.id])).rows[0]!["cirurgia_anterior"]).toBe("Apendicectomia — Dra. Souza");
  });

  it("sala inativa não aceita etapa", async () => {
    const inativa = (await amb.db.query<{ id: string }>("SELECT id FROM salas WHERE ativa = false")).rows[0]!.id;
    expect((await iniciar(op, inativa, "desmontagem")).status).toBe(422);
  });

  it("não é possível iniciar enfermagem com a sala em processo", async () => {
    expect((await iniciar(op, salaA1, "remontagem")).status).toBe(422);
  });
});

describe("sala parada", () => {
  it("inicia, impede duplicidade e finaliza com duração", async () => {
    expect((await chamar(amb.app, "POST", "/giro/paradas/iniciar", { token: op, body: { salaId: salaA2 } })).status).toBe(200);
    expect((await chamar(amb.app, "POST", "/giro/paradas/iniciar", { token: op, body: { salaId: salaA2 } })).status).toBe(409);
    const aberta = (await chamar(amb.app, "GET", "/giro/paradas?abertas=true", { token: op })).body as { id: string; sala_id: string }[];
    expect(aberta).toHaveLength(1);
    expect((await chamar(amb.app, "POST", "/giro/paradas/finalizar", { token: opB, body: { paradaId: aberta[0]!.id } })).status).toBe(404);
    expect((await chamar(amb.app, "POST", "/giro/paradas/finalizar", { token: op, body: { paradaId: aberta[0]!.id } })).status).toBe(200);
    expect((await chamar(amb.app, "POST", "/giro/paradas/finalizar", { token: op, body: { paradaId: aberta[0]!.id } })).status).toBe(409);
    expect((await amb.db.query("SELECT duracao_segundos FROM eventos_sala_parada WHERE id = $1", [aberta[0]!.id])).rows[0]!["duracao_segundos"]).toBeGreaterThanOrEqual(0);
    expect((await chamar(amb.app, "GET", "/giro/paradas?abertas=true", { token: op })).body).toHaveLength(0);
  });
});

describe("histórico", () => {
  it("devolve eventos e paradas do período; eventos recentes por horas", async () => {
    const de = new Date(Date.now() - 3600_000).toISOString();
    const ate = new Date(Date.now() + 3600_000).toISOString();
    const h = await chamar(amb.app, "GET", `/giro/historico?de=${encodeURIComponent(de)}&ate=${encodeURIComponent(ate)}`, { token: op });
    expect(h.status).toBe(200);
    expect(h.body.giro.length).toBeGreaterThanOrEqual(3);
    expect(h.body.paradas).toHaveLength(1);
    const recentes = await chamar(amb.app, "GET", "/giro/eventos?horas=48", { token: op });
    expect(recentes.body.length).toBe(h.body.giro.length);
    expect(recentes.body[0]).toHaveProperty("usuario_inicio_id");
  });
});

describe("vínculo sala <-> tablet", () => {
  it("reserva permanente: só o mesmo tablet mantém; admin pode liberar", async () => {
    const reservar = (token: string, salaId: string, deviceId: string) =>
      chamar(amb.app, "POST", "/giro/reservas/reservar", { token, body: { salaId, deviceId } });

    expect((await reservar(op, salaA1, "tablet-1")).body.reservada).toBe(true);
    expect((await reservar(op, salaA1, "tablet-1")).body.reservada).toBe(true); // idempotente
    expect((await reservar(op, salaA1, "tablet-2")).body.reservada).toBe(false); // já tem dono

    // um tablet só fica em uma sala: ao reservar a sala 2, a reserva da sala 1 some
    expect((await reservar(op, salaA2, "tablet-1")).body.reservada).toBe(true);
    const lista = (await chamar(amb.app, "GET", "/giro/reservas", { token: op })).body as { sala_id: string; device_id: string }[];
    expect(lista).toEqual([expect.objectContaining({ sala_id: salaA2, device_id: "tablet-1" })]);
    expect((await reservar(op, salaA1, "tablet-2")).body.reservada).toBe(true);

    // heartbeat atualiza o sinal
    await amb.db.query("UPDATE sala_dispositivos SET ultimo_sinal = now() - interval '1 hour' WHERE sala_id = $1", [salaA1]);
    expect((await chamar(amb.app, "POST", "/giro/reservas/heartbeat", { token: op, body: { salaId: salaA1, deviceId: "tablet-2" } })).status).toBe(200);
    const sinal = (await amb.db.query<{ recente: boolean }>("SELECT ultimo_sinal > now() - interval '1 minute' AS recente FROM sala_dispositivos WHERE sala_id = $1", [salaA1])).rows[0]!;
    expect(sinal.recente).toBe(true);

    // outro tablet (operador) não libera; o dono e o administrador sim
    await chamar(amb.app, "POST", "/giro/reservas/liberar", { token: op, body: { salaId: salaA1, deviceId: "tablet-x" } });
    expect((await chamar(amb.app, "GET", "/giro/reservas", { token: op })).body).toHaveLength(2);
    await chamar(amb.app, "POST", "/giro/reservas/liberar", { token: adm, body: { salaId: salaA1, deviceId: "tablet-x" } });
    expect((await chamar(amb.app, "GET", "/giro/reservas", { token: op })).body).toHaveLength(1);
    await chamar(amb.app, "POST", "/giro/reservas/liberar", { token: op, body: { salaId: salaA2, deviceId: "tablet-1" } });
    expect((await chamar(amb.app, "GET", "/giro/reservas", { token: op })).body).toHaveLength(0);
    expect(salaB1).toBeTruthy();
  });
});

describe("painel do hospital (giro, paradas, estatísticas e resumo)", () => {
  beforeAll(async () => {
    // ciclo antigo e completo para alimentar as estatísticas: enfermagem 40 min com limpeza de 15 min
    const t0 = new Date(Date.now() - 2 * 3600_000);
    const ins = (tipo: string, ini: Date, seg: number) =>
      amb.db.query(
        `INSERT INTO eventos_giro (sala_id, tipo_evento, inicio, fim, duracao_segundos, usuario_inicio_id, cirurgia_anterior, cirurgia_proxima)
         VALUES ($1, $2, $3, $4, $5, $6, 'Cirurgia X', 'Cirurgia Y')`,
        [salaA2, tipo, ini, new Date(ini.getTime() + seg * 1000), seg, opId],
      );
    await ins("desmontagem", t0, 2400);
    await ins("limpeza", new Date(t0.getTime() + 600_000), 900);
    await amb.db.query(
      "INSERT INTO eventos_sala_parada (sala_id, inicio, fim, duracao_segundos, usuario_inicio_id) VALUES ($1, $2, $3, 600, $4)",
      [salaA2, new Date(Date.now() - 5 * 3600_000), new Date(Date.now() - 5 * 3600_000 + 600_000), opId],
    );
  });

  it("estatísticas separam enfermagem líquida, limpeza e ciclo geral", async () => {
    const r = await chamar(amb.app, "POST", "/hospital/giro/estatisticas", { token: adm, body: {} });
    expect(r.status).toBe(200);
    expect(r.body.ciclos).toBeGreaterThanOrEqual(1);
    expect(r.body.mediaLimpeza).toBeGreaterThan(0);
    expect(r.body.mediaGeral).toBeGreaterThanOrEqual(r.body.mediaEnfermagem);
    expect(r.body.periodo.de).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.body.porDia.length).toBeGreaterThan(0);
    expect(r.body.porCiclo[0]).toHaveProperty("rotulo");
    expect(r.body.paradas).toBe(2); // a parada de 10 min + a criada no teste anterior (duração ~0)
    expect(r.body.mediaParada).toBeGreaterThan(0);
    expect(r.body.mediaParada).toBeLessThanOrEqual(600);
  });

  it("lista de giro com filtro por etapa/sala e cirurgias da limpeza vindas da enfermagem", async () => {
    const todas = await chamar(amb.app, "POST", "/hospital/giro", { token: adm, body: { pagina: 1, porPagina: 50 } });
    expect(todas.status).toBe(200);
    expect(todas.body.total).toBeGreaterThanOrEqual(4);
    const limpeza = await chamar(amb.app, "POST", "/hospital/giro", { token: adm, body: { etapa: "limpeza", salaId: salaA2, pagina: 1, porPagina: 50 } });
    expect(limpeza.body.total).toBe(1);
    expect(limpeza.body.linhas[0]).toMatchObject({ tipo_evento: "limpeza", sala: "Sala 2", cirurgia_anterior: "Cirurgia X", cirurgia_proxima: "Cirurgia Y" });
    const invalida = await chamar(amb.app, "POST", "/hospital/giro", { token: adm, body: { salaId: "nao-e-uuid" } });
    expect(invalida.body).toEqual({ linhas: [], total: 0 });
  });

  it("paradas: lista paginada e estatísticas por janelas", async () => {
    const lista = await chamar(amb.app, "POST", "/hospital/paradas", { token: adm, body: { pagina: 1, porPagina: 20 } });
    expect(lista.body.total).toBeGreaterThanOrEqual(2);
    expect(lista.body.linhas[0]).toHaveProperty("sala");
    const st = await chamar(amb.app, "POST", "/hospital/paradas/estatisticas", { token: adm, body: {} });
    expect(st.status).toBe(200);
    expect(st.body.janelas).toEqual([7, 15, 30, 45]);
    const s2 = st.body.salas.find((s: { sala: string }) => s.sala === "Sala 2");
    expect(s2.ocorrencias).toBeGreaterThanOrEqual(2);
    expect(s2.medias["7"]).toBeGreaterThanOrEqual(0);
  });

  it("resumo do hospital consolida usuários, salas, giro e acessos", async () => {
    const r = await chamar(amb.app, "GET", "/hospital/resumo", { token: adm });
    expect(r.status).toBe(200);
    expect(r.body.tenant.nome).toBe("Hospital A");
    expect(r.body.usuarios).toEqual({ total: 2, ativos: 2, operadores: 1 });
    expect(r.body.salas).toMatchObject({ total: 3, ativas: 2 });
    expect(r.body.salas.emProcesso).toBeGreaterThanOrEqual(1);
    expect(r.body.features.map((f: { chave: string }) => f.chave)).toEqual(["giro_de_sala"]);
    expect(r.body.giro.eventos30).toBeGreaterThanOrEqual(2);
    expect(r.body.acessos.length).toBeGreaterThan(0);
    expect((await chamar(amb.app, "POST", "/hospital/acessos", { token: adm, body: { busca: "adm@", pagina: 1, porPagina: 20 } })).body.total).toBeGreaterThan(0);
    expect((await chamar(amb.app, "GET", "/hospital/usuarios", { token: adm })).body).toHaveLength(2);
  });
});
