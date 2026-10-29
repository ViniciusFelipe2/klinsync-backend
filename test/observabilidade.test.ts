import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { avaliarSaude, inclinacaoPorHora, saudeGeral, type EntradaSaude } from "../src/lib/saude.js";
import { MonitorIndisponivel, criarMonitorDemo, type Custos, type Infra, type InstanciaInfo, type Monitor, type Ponto, type SerieInstancia } from "../src/services/monitor.js";
import { chamar, criarAmbiente, criarHospital, criarUsuarioDireto, habilitarFeature, tokenDe, type Ambiente } from "./helpers.js";

const AGORA = Date.UTC(2026, 9, 9, 12, 0, 0);
const serie = (valores: number[], passoMin = 10): Ponto[] => valores.map((v, i) => ({ t: AGORA - (valores.length - 1 - i) * passoMin * 60_000, v }));
const vazia = (): SerieInstancia => ({ cpu: [], redeEntrada: [], redeSaida: [], creditos: [], memoria: [], disco: [], falhaStatus: [] });
const inst = (over: Partial<InstanciaInfo> = {}): InstanciaInfo => ({
  id: "i-1", nome: "Klinsync-backend", tipo: "t3.small", estado: "running", az: "us-east-2a", ipPrivado: null, ipPublico: null, iniciadaEm: null,
  burstavel: true, statusInstancia: "ok", statusSistema: "ok", eventosAgendados: [], ...over,
});
const infraCom = (i: InstanciaInfo, s: Partial<SerieInstancia>, alarmes: Infra["alarmes"] = []): Infra => ({
  instancias: [i], series: { [i.id]: { ...vazia(), ...s } }, alarmes, periodoSegundos: 600,
});
const base = (over: Partial<EntradaSaude> = {}): EntradaSaude => ({ agora: AGORA, infra: null, app: null, banco: null, custos: null, ...over });
const ids = (e: EntradaSaude) => avaliarSaude(e).map((a) => a.id);
const sev = (e: EntradaSaude, id: string) => avaliarSaude(e).find((a) => a.id === id)?.severidade;

describe("regras de saúde (antecipação de falhas)", () => {
  it("tudo normal não gera alerta", () => {
    const e = base({ infra: infraCom(inst(), { cpu: serie([20, 25, 22]), creditos: serie(Array(12).fill(120)), memoria: serie([50, 52]), disco: serie(Array(12).fill(40)) }) });
    expect(avaliarSaude(e)).toEqual([]);
    expect(saudeGeral([])).toBe("ok");
  });

  it("instância parada e falhas de status são críticas", () => {
    expect(sev(base({ infra: infraCom(inst({ estado: "stopped" }), {}) }), "srv-parada-i-1")).toBe("critico");
    expect(ids(base({ infra: infraCom(inst({ statusSistema: "comprometido", statusInstancia: "comprometido" }), {}) }))).toEqual(
      expect.arrayContaining(["srv-status-sistema-i-1", "srv-status-instancia-i-1"]),
    );
    expect(sev(base({ infra: infraCom(inst({ eventosAgendados: [{ codigo: "instance-retirement", descricao: "x", inicio: null }] }), {}) }), "srv-evento-i-1-instance-retirement")).toBe("aviso");
  });

  it("CPU alta: aviso a partir de 75% e crítico a partir de 90% (média dos últimos 20 min)", () => {
    expect(sev(base({ infra: infraCom(inst(), { cpu: serie([80, 82, 79]) }) }), "srv-cpu-i-1")).toBe("aviso");
    expect(sev(base({ infra: infraCom(inst(), { cpu: serie([95, 97, 96]) }) }), "srv-cpu-i-1")).toBe("critico");
    // pico antigo não conta: só a janela recente
    expect(ids(base({ infra: infraCom(inst(), { cpu: [{ t: AGORA - 3 * 3600_000, v: 99 }, ...serie([10, 12])] }) }))).not.toContain("srv-cpu-i-1");
  });

  it("créditos de CPU: baixo agora ou previsão de acabar em menos de 24 h", () => {
    expect(sev(base({ infra: infraCom(inst(), { creditos: serie(Array(12).fill(3)) }) }), "srv-creditos-i-1")).toBe("critico");
    // saldo caindo 10 por hora (1,67 por ponto de 10 min): acaba em ~10 h
    const caindo = Array.from({ length: 12 }, (_, i) => 120 - i * (10 / 6));
    const a = avaliarSaude(base({ infra: infraCom(inst(), { creditos: serie(caindo) }) })).find((x) => x.id === "srv-creditos-i-1");
    expect(a?.severidade).toBe("aviso");
    expect(a?.titulo).toMatch(/sem créditos/);
  });

  it("disco: nível atual e projeção de quando enche", () => {
    expect(sev(base({ infra: infraCom(inst(), { disco: serie(Array(12).fill(93)), memoria: serie([10]) }) }), "srv-disco-i-1")).toBe("critico");
    // 50% hoje, +1 ponto percentual por hora => cheio em ~50 h (< 72 h => crítico)
    const subindo = Array.from({ length: 24 }, (_, i) => 50 - (23 - i) * (1 / 6));
    const a = avaliarSaude(base({ infra: infraCom(inst(), { disco: serie(subindo), memoria: serie([10]) }) })).find((x) => x.id === "srv-disco-tendencia-i-1");
    expect(a?.severidade).toBe("critico");
    expect(a?.titulo).toMatch(/encher em ~(2 dias|\d+ h)/);
    // estável não alerta
    expect(ids(base({ infra: infraCom(inst(), { disco: serie(Array(24).fill(50)), memoria: serie([10]) }) }))).not.toContain("srv-disco-tendencia-i-1");
  });

  it("memória alta e ausência do CloudWatch Agent", () => {
    expect(sev(base({ infra: infraCom(inst(), { memoria: serie([95, 96]), disco: serie([40]) }) }), "srv-mem-i-1")).toBe("critico");
    expect(sev(base({ infra: infraCom(inst(), { cpu: serie([5]) }) }), "obs-sem-agente")).toBe("info");
  });

  it("alarme do CloudWatch em ALARM", () => {
    const al = [{ nome: "cpu-db", estado: "ALARM" as const, motivo: "Threshold Crossed", atualizadoEm: null, metrica: null }];
    expect(sev(base({ infra: infraCom(inst(), {}, al) }), "cw-alarme-cpu-db")).toBe("critico");
  });

  it("API: taxa de 5xx e latência; banco: conexões", () => {
    expect(sev(base({ app: { requisicoes: 100, erros5xx: 10, erros4xx: 0, latenciaMediaMs: 50, lentas: 0 } }), "app-erros-5xx")).toBe("critico");
    expect(sev(base({ app: { requisicoes: 200, erros5xx: 3, erros4xx: 0, latenciaMediaMs: 50, lentas: 0 } }), "app-erros-5xx")).toBe("aviso");
    expect(ids(base({ app: { requisicoes: 5, erros5xx: 1, erros4xx: 0, latenciaMediaMs: 50, lentas: 0 } }))).toEqual([]); // amostra pequena
    expect(sev(base({ app: { requisicoes: 50, erros5xx: 0, erros4xx: 0, latenciaMediaMs: 1500, lentas: 20 } }), "app-latencia")).toBe("aviso");
    expect(sev(base({ banco: { conexoes: 95, maxConexoes: 100 } }), "banco-conexoes")).toBe("critico");
    expect(sev(base({ banco: { conexoes: 80, maxConexoes: 100 } }), "banco-conexoes")).toBe("aviso");
    expect(ids(base({ banco: { conexoes: 10, maxConexoes: 100 } }))).toEqual([]);
  });

  it("custos: orçamento, previsão e anomalia diária", () => {
    const c: Custos = {
      moeda: "USD", mesAtual: { inicio: "2026-10-01", fim: "2026-11-01", total: 20, diasDecorridos: 8, diasNoMes: 31 },
      mesAnterior: { total: 60, mesmoPeriodo: 16 }, previsaoFimMes: 80, hoje: 2, mediaDiaria7d: 2, diario: [], porServico: [], atualizadoEm: "",
    };
    expect(sev(base({ custos: c, orcamento: 70 }), "custo-orcamento")).toBe("critico");
    expect(sev(base({ custos: { ...c, previsaoFimMes: 50 }, orcamento: 70 }), "custo-orcamento")).toBeUndefined();
    expect(sev(base({ custos: { ...c, previsaoFimMes: 50, mesAtual: { ...c.mesAtual, total: 60 } }, orcamento: 70 }), "custo-orcamento")).toBe("aviso");

    // ontem (2026-10-08) com US$ 9 contra US$ 2/dia nos sete dias anteriores; hoje (10-09) é parcial e ignorado
    const normais = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"].map((dia) => ({ dia, valor: 2 }));
    const hoje = { dia: "2026-10-09", valor: 0.1 };
    expect(ids(base({ custos: { ...c, diario: [...normais, { dia: "2026-10-08", valor: 9 }, hoje] } }))).toContain("custo-anomalia");
    expect(ids(base({ custos: { ...c, diario: [...normais, { dia: "2026-10-08", valor: 2.2 }, hoje] } }))).not.toContain("custo-anomalia");
  });

  it("inclinação por hora e ordenação por severidade", () => {
    expect(inclinacaoPorHora(serie([1, 2, 3], 60))).toBeNull(); // poucos pontos
    expect(inclinacaoPorHora(serie([1, 2, 3, 4, 5, 6], 60))).toBeCloseTo(1, 5);
    const lista = avaliarSaude(base({ infra: infraCom(inst(), { cpu: serie([80]) }), banco: { conexoes: 95, maxConexoes: 100 } }));
    expect(lista[0]!.severidade).toBe("critico");
    expect(saudeGeral(lista)).toBe("critico");
  });
});

let amb: Ambiente;
let master: string;
let adm: string;
let op: string;

const monitorFalho = (m: MonitorIndisponivel): Monitor => ({
  modo: "aws",
  infra: async () => {
    throw m;
  },
  custos: async () => {
    throw m;
  },
});

describe("rotas de observabilidade", () => {
  beforeAll(async () => {
    amb = await criarAmbiente({ config: { ORCAMENTO_MENSAL_USD: "1" } });
    const t = await criarHospital(amb.db, "Hospital A");
    await criarUsuarioDireto(amb.db, { email: "master@t.com", role: "master_admin" });
    await criarUsuarioDireto(amb.db, { email: "adm@t.com", role: "hospital_admin", tenantId: t });
    const f = await habilitarFeature(amb.db, t, "giro_de_sala");
    await criarUsuarioDireto(amb.db, { email: "op@t.com", role: "operador", tenantId: t, featureId: f });
    master = await tokenDe(amb.app, "master@t.com");
    adm = await tokenDe(amb.app, "adm@t.com");
    op = await tokenDe(amb.app, "op@t.com");
  });
  afterAll(() => amb.fechar());

  it("somente o master acessa (401 sem login, 403 para os demais papéis)", async () => {
    const rotas = [
      ["GET", "/master/observabilidade/resumo", undefined],
      ["POST", "/master/observabilidade/servidores", {}],
      ["POST", "/master/observabilidade/aplicacao", {}],
      ["POST", "/master/observabilidade/custos", {}],
    ] as const;
    for (const [m, u, body] of rotas) {
      expect((await chamar(amb.app, m, u, { body })).status).toBe(401);
      expect((await chamar(amb.app, m, u, { token: adm, body })).status).toBe(403);
      expect((await chamar(amb.app, m, u, { token: op, body })).status).toBe(403);
      expect((await chamar(amb.app, m, u, { token: master, body })).status).toBe(200);
    }
  });

  it("servidores e custos devolvem os dados do monitor; período inválido é recusado", async () => {
    const s = await chamar(amb.app, "POST", "/master/observabilidade/servidores", { token: master, body: { horas: 6 } });
    expect(s.body.fonte).toEqual({ ok: true });
    expect(s.body.instancias).toHaveLength(3);
    expect(s.body.series["i-0demo0backend"].cpu.length).toBeGreaterThan(10);
    expect((await chamar(amb.app, "POST", "/master/observabilidade/servidores", { token: master, body: { horas: 5 } })).status).toBe(422);

    const c = await chamar(amb.app, "POST", "/master/observabilidade/custos", { token: master, body: {} });
    expect(c.body.custos.porServico.length).toBeGreaterThan(0);
    expect(c.body.orcamento).toBe(1);
  });

  it("métricas da API são gravadas por rota, somadas entre descargas e aparecem na aba Aplicação", async () => {
    await chamar(amb.app, "GET", "/auth/me", { token: master });
    await chamar(amb.app, "GET", "/auth/me", { token: master });
    amb.metricas.registrar("GET", "/rota-teste", 500, 1500);
    amb.metricas.registrar("GET", "/rota-teste", 200, 100);
    await amb.metricas.descarregar();
    amb.metricas.registrar("GET", "/rota-teste", 200, 50);
    await amb.metricas.descarregar();

    const r = await chamar(amb.app, "POST", "/master/observabilidade/aplicacao", { token: master, body: { horas: 1 } });
    const rota = r.body.rotas.find((x: { rota: string }) => x.rota === "/rota-teste");
    expect(rota).toMatchObject({ requisicoes: 3, erros5xx: 1, lentas: 1, latenciaMaxMs: 1500, latenciaMediaMs: 550 });
    expect(r.body.rotas.find((x: { rota: string }) => x.rota === "/auth/me").requisicoes).toBeGreaterThanOrEqual(2);
    expect(r.body.serie.length).toBeGreaterThan(0);
    expect(r.body.recente.requisicoes).toBeGreaterThanOrEqual(5);
    expect(r.body.processo.rssMb).toBeGreaterThan(0);
    expect(r.body.banco).toHaveProperty("disponivel");
    expect(r.body.rotas.some((x: { rota: string }) => x.rota === "/health")).toBe(false);
  });

  it("resumo consolida alertas (orçamento estourado) e KPIs", async () => {
    const r = await chamar(amb.app, "GET", "/master/observabilidade/resumo", { token: master });
    expect(r.body.kpis.servidores.total).toBe(3);
    expect(r.body.alertas.some((a: { id: string }) => a.id === "custo-orcamento")).toBe(true);
    expect(r.body.saude).toBe("critico");
    expect(r.body.fontes.servidores).toEqual({ ok: true });
  });
});

describe("falhas na AWS são explicadas, não escondidas", () => {
  it("sem permissão/credenciais o painel segue funcionando e indica o que falta", async () => {
    const env = await criarAmbiente({ monitor: monitorFalho(new MonitorIndisponivel("permissao", "Sem permissão para ec2:DescribeInstances.", "Conceda a permissão.")) });
    try {
      await criarUsuarioDireto(env.db, { email: "m@t.com", role: "master_admin" });
      const tok = await tokenDe(env.app, "m@t.com");
      const s = await chamar(env.app, "POST", "/master/observabilidade/servidores", { token: tok, body: {} });
      expect(s.status).toBe(200);
      expect(s.body.fonte).toMatchObject({ ok: false, motivo: "permissao", acao: "Conceda a permissão." });
      expect(s.body.instancias).toEqual([]);
      const r = await chamar(env.app, "GET", "/master/observabilidade/resumo", { token: tok });
      expect(r.body.alertas.map((a: { id: string }) => a.id)).toEqual(expect.arrayContaining(["obs-aws-indisponivel", "obs-custos-indisponivel"]));
      expect(r.body.saude).toBe("atencao");
    } finally {
      await env.fechar();
    }
  });

  it("erro cru do SDK é classificado", async () => {
    const { classificarErroAws } = await import("../src/services/monitor.js");
    expect(classificarErroAws(Object.assign(new Error("x"), { name: "CredentialsProviderError" }), "a").motivo).toBe("credenciais");
    expect(classificarErroAws(Object.assign(new Error("User is not authorized"), { name: "AccessDeniedException" }), "a").motivo).toBe("permissao");
    expect(classificarErroAws(new Error("boom"), "a").motivo).toBe("erro");
  });

  it("modo demo é recusado em produção", async () => {
    const { loadConfig } = await import("../src/config.js");
    expect(() =>
      loadConfig({ NODE_ENV: "production", DATABASE_URL: "postgresql://a/b", JWT_ACCESS_SECRET: "a".repeat(40), JWT_REFRESH_SECRET: "b".repeat(40), MONITOR_MODO: "demo" }),
    ).toThrow(/demo/);
    expect(criarMonitorDemo().modo).toBe("demo");
  });
});
