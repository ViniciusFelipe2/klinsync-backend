import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chamar, criarAmbiente, criarHospital, criarUsuarioDireto, habilitarFeature, tokenDe, type Ambiente } from "./helpers.js";

let amb: Ambiente;
let base: string;
let admA: string;
let admB: string;
let opA: string;
let master: string;
let salaA: string;

/** Abre o fluxo SSE e vai acumulando o texto recebido. */
async function abrirFluxo(token: string) {
  const ctl = new AbortController();
  const res = await fetch(`${base}/eventos/stream`, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
  let texto = "";
  if (res.body) {
    const leitor = res.body.getReader();
    const dec = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await leitor.read();
          if (done) break;
          texto += dec.decode(value);
        }
      } catch {
        /* abortado ao fechar */
      }
    })();
  }
  const ate = async (trecho: string, ms = 3000) => {
    const limite = Date.now() + ms;
    while (!texto.includes(trecho)) {
      if (Date.now() > limite) return false;
      await new Promise((r) => setTimeout(r, 25));
    }
    return true;
  };
  return { res, ate, texto: () => texto, fechar: () => ctl.abort() };
}

beforeAll(async () => {
  amb = await criarAmbiente();
  const ta = await criarHospital(amb.db, "Hospital A");
  const tb = await criarHospital(amb.db, "Hospital B");
  const fa = await habilitarFeature(amb.db, ta, "giro_de_sala");
  await habilitarFeature(amb.db, ta, "checkin_cirurgioes");
  await criarUsuarioDireto(amb.db, { email: "adm-a@t.com", role: "hospital_admin", tenantId: ta });
  await criarUsuarioDireto(amb.db, { email: "adm-b@t.com", role: "hospital_admin", tenantId: tb });
  await criarUsuarioDireto(amb.db, { email: "op-a@t.com", role: "operador", tenantId: ta, featureId: fa });
  await criarUsuarioDireto(amb.db, { email: "master@t.com", role: "master_admin" });
  salaA = (await amb.db.query<{ id: string }>("INSERT INTO salas (tenant_id, nome) VALUES ($1, 'Sala 1') RETURNING id", [ta])).rows[0]!.id;
  admA = await tokenDe(amb.app, "adm-a@t.com");
  admB = await tokenDe(amb.app, "adm-b@t.com");
  opA = await tokenDe(amb.app, "op-a@t.com");
  master = await tokenDe(amb.app, "master@t.com");
  base = await amb.app.listen({ port: 0, host: "127.0.0.1" });
});
afterAll(() => amb.fechar());

describe("tempo real (SSE)", () => {
  it("exige login", async () => {
    const r = await fetch(`${base}/eventos/stream`);
    expect(r.status).toBe(401);
  });

  it("abre o fluxo com os cabeçalhos certos e avisa o painel do mesmo hospital quando uma sala inicia o giro", async () => {
    const painel = await abrirFluxo(admA);
    try {
      expect(painel.res.status).toBe(200);
      expect(painel.res.headers.get("content-type")).toMatch(/text\/event-stream/);
      expect(painel.res.headers.get("x-accel-buffering")).toBe("no");
      expect(await painel.ate("event: pronto")).toBe(true);

      await chamar(amb.app, "POST", "/giro/reservas/reservar", { token: opA, body: { salaId: salaA, deviceId: "tablet-1" } });
      expect(await painel.ate("event: reserva")).toBe(true);

      const r = await chamar(amb.app, "POST", "/giro/etapas/iniciar", { token: opA, body: { salaId: salaA, tipo: "desmontagem", deviceId: "tablet-1" } });
      expect(r.status).toBe(200);
      expect(await painel.ate("event: giro")).toBe(true);
    } finally {
      painel.fechar();
    }
  });

  it("avisa sobre novo check-in e não vaza para outro hospital; master recebe tudo", async () => {
    const a = await abrirFluxo(admA);
    const b = await abrirFluxo(admB);
    const m = await abrirFluxo(master);
    try {
      await a.ate("event: pronto");
      await b.ate("event: pronto");
      await m.ate("event: pronto");
      const png = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200)]).toString("base64")}`;
      const ci = await chamar(amb.app, "POST", "/checkins", { token: opA, body: { doctorName: "Dr. Tempo Real", photoBase64: png } });
      // o operador precisa do módulo de check-in; usa o admin do hospital A (também tem acesso ao módulo)
      const r = ci.status === 200 ? ci : await chamar(amb.app, "POST", "/checkins", { token: admA, body: { doctorName: "Dr. Tempo Real", photoBase64: png } });
      expect(r.status).toBe(200);
      expect(await a.ate("event: checkin")).toBe(true);
      expect(await m.ate("event: checkin")).toBe(true);
      await new Promise((res) => setTimeout(res, 300));
      expect(b.texto()).not.toContain("event: checkin");
    } finally {
      a.fechar();
      b.fechar();
      m.fechar();
    }
  });

  it("falha de uma operação não gera aviso", async () => {
    const painel = await abrirFluxo(admA);
    try {
      await painel.ate("event: pronto");
      const antes = painel.texto();
      const r = await chamar(amb.app, "POST", "/giro/etapas/iniciar", { token: opA, body: { salaId: salaA, tipo: "desmontagem", deviceId: "tablet-errado" } });
      expect(r.status).toBe(403);
      await new Promise((res) => setTimeout(res, 300));
      expect(painel.texto()).toBe(antes);
    } finally {
      painel.fechar();
    }
  });

  it("limita conexões simultâneas por usuário", async () => {
    const abertos = [];
    try {
      for (let i = 0; i < 30; i++) abertos.push(await abrirFluxo(admB));
      const extra = await fetch(`${base}/eventos/stream`, { headers: { Authorization: `Bearer ${admB}` } });
      expect(extra.status).toBe(429);
    } finally {
      abertos.forEach((f) => f.fechar());
    }
  });
});
