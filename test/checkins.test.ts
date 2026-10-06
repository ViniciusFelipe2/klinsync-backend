import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chamar, criarAmbiente, criarHospital, criarUsuarioDireto, habilitarFeature, tokenDe, type Ambiente } from "./helpers.js";

let amb: Ambiente;
let opA: string;
let opB: string;
let admA: string;
let master: string;
let tenantA: string;

const fotoPng = (extra = 200) => `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra)]).toString("base64")}`;
const fotoJpeg = () => `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]).toString("base64")}`;

beforeAll(async () => {
  amb = await criarAmbiente();
  tenantA = await criarHospital(amb.db, "Hospital A");
  const tenantB = await criarHospital(amb.db, "Hospital B");
  const fa = await habilitarFeature(amb.db, tenantA, "checkin_cirurgioes");
  const fb = await habilitarFeature(amb.db, tenantB, "checkin_cirurgioes");
  await criarUsuarioDireto(amb.db, { email: "master@t.com", role: "master_admin" });
  await criarUsuarioDireto(amb.db, { email: "op-a@t.com", role: "operador", tenantId: tenantA, featureId: fa });
  await criarUsuarioDireto(amb.db, { email: "op-b@t.com", role: "operador", tenantId: tenantB, featureId: fb });
  await criarUsuarioDireto(amb.db, { email: "adm-a@t.com", role: "hospital_admin", tenantId: tenantA });
  master = await tokenDe(amb.app, "master@t.com");
  opA = await tokenDe(amb.app, "op-a@t.com");
  opB = await tokenDe(amb.app, "op-b@t.com");
  admA = await tokenDe(amb.app, "adm-a@t.com");
});
afterAll(() => amb.fechar());

describe("check-in de cirurgiões", () => {
  it("registra o check-in, grava a foto no storage por hospital e devolve o registro", async () => {
    const r = await chamar(amb.app, "POST", "/checkins", { token: opA, body: { doctorName: "Dr. João Silva", photoBase64: fotoPng() } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ doctor_name: "Dr. João Silva" });
    const linha = await amb.db.query<{ photo_path: string; tenant_id: string }>("SELECT photo_path, tenant_id FROM check_ins WHERE id = $1", [r.body.id]);
    expect(linha.rows[0]!.tenant_id).toBe(tenantA);
    expect(linha.rows[0]!.photo_path).toMatch(new RegExp(`^${tenantA}/[0-9a-f-]{36}\\.png$`));
    expect(amb.storage.objetos.has(linha.rows[0]!.photo_path)).toBe(true);
  });

  it("recusa foto que não é imagem de verdade, nome curto e payload fora do padrão", async () => {
    const falsa = `data:image/png;base64,${Buffer.alloc(200, 0x41).toString("base64")}`; // bytes não são PNG
    expect((await chamar(amb.app, "POST", "/checkins", { token: opA, body: { doctorName: "Dr. Falso", photoBase64: falsa } })).status).toBe(422);
    expect((await chamar(amb.app, "POST", "/checkins", { token: opA, body: { doctorName: "Dr", photoBase64: fotoPng() } })).status).toBe(422);
    expect((await chamar(amb.app, "POST", "/checkins", { token: opA, body: { doctorName: "Dr. SVG", photoBase64: "data:image/svg+xml;base64,AAAA" } })).status).toBe(422);
  });

  it("master (sem hospital) não registra check-in", async () => {
    const r = await chamar(amb.app, "POST", "/checkins", { token: master, body: { doctorName: "Dr. Master", photoBase64: fotoJpeg() } });
    expect(r.status).toBe(403);
  });

  it("lista com busca, paginação e contagem de hoje; isola por hospital", async () => {
    for (const nome of ["Dra. Ana Costa", "Dr. Pedro Souza", "Dra. Ana Lima"]) {
      await chamar(amb.app, "POST", "/checkins", { token: opA, body: { doctorName: nome, photoBase64: fotoJpeg() } });
    }
    await chamar(amb.app, "POST", "/checkins", { token: opB, body: { doctorName: "Dr. Outro Hospital", photoBase64: fotoJpeg() } });

    const todos = await chamar(amb.app, "POST", "/checkins/listar", { token: opA, body: { pagina: 1, porPagina: 20 } });
    expect(todos.body.total).toBe(4);
    expect(todos.body.hoje).toBe(4);
    expect(todos.body.linhas.some((l: { doctor_name: string }) => l.doctor_name === "Dr. Outro Hospital")).toBe(false);

    const busca = await chamar(amb.app, "POST", "/checkins/listar", { token: opA, body: { busca: "ana", pagina: 1, porPagina: 20 } });
    expect(busca.body.total).toBe(2);
    const pag = await chamar(amb.app, "POST", "/checkins/listar", { token: opA, body: { pagina: 2, porPagina: 3 } });
    expect(pag.body.linhas).toHaveLength(1);
    expect(pag.body.total).toBe(4);

    // curingas do LIKE são tratados como texto
    const curinga = await chamar(amb.app, "POST", "/checkins/listar", { token: opA, body: { busca: "%", pagina: 1, porPagina: 20 } });
    expect(curinga.body.total).toBe(0);

    // filtro de período no fuso do hospital
    const hoje = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
    const noDia = await chamar(amb.app, "POST", "/checkins/listar", { token: opA, body: { de: hoje, ate: hoje, pagina: 1, porPagina: 20 } });
    expect(noDia.body.total).toBe(4);
    const antes = await chamar(amb.app, "POST", "/checkins/listar", { token: opA, body: { de: "2000-01-01", ate: "2000-01-31", pagina: 1, porPagina: 20 } });
    expect(antes.body.total).toBe(0);

    // master vê todos os hospitais
    const m = await chamar(amb.app, "POST", "/checkins/listar", { token: master, body: { pagina: 1, porPagina: 50 } });
    expect(m.body.total).toBe(5);

    const exp = await chamar(amb.app, "POST", "/checkins/exportar", { token: opA, body: { busca: "ana" } });
    expect(exp.body.linhas).toHaveLength(2);
  });

  it("URLs assinadas curtas só para registros do próprio hospital", async () => {
    const meus = (await chamar(amb.app, "POST", "/checkins/listar", { token: opA, body: { pagina: 1, porPagina: 20 } })).body.linhas as { id: string }[];
    const outro = (await chamar(amb.app, "POST", "/checkins/listar", { token: opB, body: { pagina: 1, porPagina: 20 } })).body.linhas as { id: string }[];

    const um = await chamar(amb.app, "POST", "/checkins/foto-url", { token: opA, body: { id: meus[0]!.id } });
    expect(um.status).toBe(200);
    expect(um.body.url).toMatch(/ttl=300$/);
    expect((await chamar(amb.app, "POST", "/checkins/foto-url", { token: opA, body: { id: outro[0]!.id } })).status).toBe(404);

    const varios = await chamar(amb.app, "POST", "/checkins/fotos-urls", { token: opA, body: { ids: [...meus.map((m) => m.id), outro[0]!.id] } });
    expect(Object.keys(varios.body.urls)).toHaveLength(meus.length); // a foto do outro hospital não vem
    expect(Object.values(varios.body.urls as Record<string, string>).every((u) => u.endsWith("ttl=1800"))).toBe(true);
    expect((await chamar(amb.app, "POST", "/checkins/fotos-urls", { token: opA, body: { ids: [] } })).status).toBe(422);
  });

  it("uso do armazenamento e exclusão (remove linha e foto)", async () => {
    const antes = await chamar(amb.app, "POST", "/checkins/uso", { token: opA, body: {} });
    expect(antes.body).toMatchObject({ isEstimate: false, totalBytes: 1024 ** 3, checkInCount: 4 });
    expect(antes.body.usedBytes).toBeGreaterThan(0);

    const alvo = (await chamar(amb.app, "POST", "/checkins/listar", { token: opA, body: { pagina: 1, porPagina: 1 } })).body.linhas[0] as { id: string };
    const caminho = (await amb.db.query<{ photo_path: string }>("SELECT photo_path FROM check_ins WHERE id = $1", [alvo.id])).rows[0]!.photo_path;

    // outro hospital não consegue excluir
    expect((await chamar(amb.app, "POST", "/checkins/excluir", { token: opB, body: { id: alvo.id } })).status).toBe(404);
    expect((await chamar(amb.app, "POST", "/checkins/excluir", { token: opA, body: { id: alvo.id } })).status).toBe(200);
    expect(amb.storage.objetos.has(caminho)).toBe(false);
    expect((await amb.db.query("SELECT 1 FROM check_ins WHERE id = $1", [alvo.id])).rowCount).toBe(0);
    expect((await chamar(amb.app, "POST", "/checkins/excluir", { token: opA, body: { id: alvo.id } })).status).toBe(404);

    const depois = await chamar(amb.app, "POST", "/checkins/uso", { token: opA, body: {} });
    expect(depois.body.checkInCount).toBe(3);
  });

  it("rate limit por IP no check-in (429 após o limite da janela)", async () => {
    let ultimo = 0;
    for (let i = 0; i < 62; i++) {
      ultimo = (await chamar(amb.app, "POST", "/checkins", { token: opA, ip: "10.5.5.5", body: { doctorName: "Dr. Flood", photoBase64: "x" } })).status;
    }
    // as primeiras recusas são 422 (payload), mas o limitador conta a tentativa e passa a responder 429
    expect(ultimo).toBe(429);
  });

  it("hospital_admin lista check-ins pelo painel do hospital", async () => {
    const r = await chamar(amb.app, "POST", "/hospital/checkins", { token: admA, body: { pagina: 1, porPagina: 20 } });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(3);
    expect(r.body.linhas[0]).toHaveProperty("doctor_name");
  });

  it("storage indisponível devolve 503 em vez de falhar", async () => {
    const env = await criarAmbiente();
    try {
      const { storageIndisponivel } = await import("../src/services/storage.js");
      const { buildApp } = await import("../src/app.js");
      const { externosDeTeste } = await import("./helpers.js");
      const t = await criarHospital(env.db);
      const f = await habilitarFeature(env.db, t, "checkin_cirurgioes");
      await criarUsuarioDireto(env.db, { email: "o@t.com", role: "operador", tenantId: t, featureId: f });
      const app = await buildApp({ config: env.config, db: env.db, externos: externosDeTeste(), storage: storageIndisponivel() });
      await app.ready();
      const tok = await tokenDe(app, "o@t.com");
      const r = await chamar(app, "POST", "/checkins", { token: tok, body: { doctorName: "Dr. Sem Bucket", photoBase64: fotoPng() } });
      expect(r.status).toBe(503);
      expect(r.body.message).toMatch(/não configurado/);
      await app.close();
    } finally {
      await env.fechar();
    }
  });
});
