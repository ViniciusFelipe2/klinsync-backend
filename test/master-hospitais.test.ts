import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chamar, criarAmbiente, criarHospital, criarUsuarioDireto, habilitarFeature, login, tokenDe, type Ambiente } from "./helpers.js";

let amb: Ambiente;
let master: string;
let tenant: string;
let outro: string;
let feature: string;

beforeAll(async () => {
  amb = await criarAmbiente();
  tenant = await criarHospital(amb.db, "Hospital Alfa");
  outro = await criarHospital(amb.db, "Hospital Beta");
  feature = await habilitarFeature(amb.db, tenant, "giro_de_sala");
  await habilitarFeature(amb.db, outro, "giro_de_sala");
  await criarUsuarioDireto(amb.db, { email: "master@t.com", role: "master_admin" });
  await criarUsuarioDireto(amb.db, { email: "adm@alfa.com", role: "hospital_admin", tenantId: tenant });
  await criarUsuarioDireto(amb.db, { email: "op@alfa.com", role: "operador", tenantId: tenant, featureId: feature });
  await criarUsuarioDireto(amb.db, { email: "adm@beta.com", role: "hospital_admin", tenantId: outro });
  master = await tokenDe(amb.app, "master@t.com");
});
afterAll(() => amb.fechar());

const status = (id: string, s: "ativo" | "inativo" | "inadimplente", token = master) =>
  chamar(amb.app, "POST", "/master/hospitais/status", { token, body: { id, status: s } });

describe("desativar hospital", () => {
  it("só o master altera o status", async () => {
    const adm = await tokenDe(amb.app, "adm@alfa.com");
    expect((await status(tenant, "inativo", adm)).status).toBe(403);
  });

  it("derruba a sessão aberta, avisa o admin e esconde o motivo do operador no login", async () => {
    const adm = await login(amb.app, "adm@alfa.com");
    const op = await login(amb.app, "op@alfa.com");
    expect(adm.status).toBe(200);
    expect(op.status).toBe(200);

    expect((await status(tenant, "inativo")).status).toBe(200);

    // sessão já aberta deixa de valer, inclusive a renovação
    expect((await chamar(amb.app, "GET", "/hospital/resumo", { token: adm.body.accessToken })).status).toBe(401);
    expect((await chamar(amb.app, "GET", "/giro/salas", { token: op.body.accessToken })).status).toBe(401);
    expect((await chamar(amb.app, "POST", "/auth/refresh", { body: { refreshToken: adm.body.refreshToken } })).status).toBe(401);

    // novo login: senha correta, hospital desativado
    const a = await login(amb.app, "adm@alfa.com");
    expect(a.status).toBe(403);
    expect(a.body.message).toMatch(/indispon[ií]vel.*desativa/i);
    const o = await login(amb.app, "op@alfa.com");
    expect(o.status).toBe(403);
    expect(o.body.message).toBe("Não foi possível fazer login.");
    expect(o.body.accessToken).toBeUndefined();

    // senha errada continua com a mensagem de sempre (não revela o status do hospital)
    const errada = await login(amb.app, "op@alfa.com", "Errada#12345");
    expect(errada.status).toBe(401);

    // outro hospital não é afetado
    expect((await login(amb.app, "adm@beta.com")).status).toBe(200);
  });

  it("inadimplente também bloqueia; reativar libera de novo", async () => {
    expect((await status(tenant, "inadimplente")).status).toBe(200);
    expect((await login(amb.app, "op@alfa.com")).status).toBe(403);
    expect((await status(tenant, "ativo")).status).toBe(200);
    expect((await login(amb.app, "adm@alfa.com")).status).toBe(200);
    expect((await login(amb.app, "op@alfa.com")).status).toBe(200);
  });

  it("master continua entrando e a ação fica na auditoria", async () => {
    expect((await login(amb.app, "master@t.com")).status).toBe(200);
    const log = await amb.db.query("SELECT detalhes FROM log_acoes_sensiveis WHERE acao = 'alterou_status_hospital'");
    expect(log.rowCount).toBeGreaterThanOrEqual(3);
  });

  it("hospital inexistente dá 404", async () => {
    expect((await status("00000000-0000-4000-8000-000000000000", "inativo")).status).toBe(404);
  });
});

describe("excluir hospital", () => {
  const excluir = (id: string, confirmarNome: string) =>
    chamar(amb.app, "POST", "/master/hospitais/excluir", { token: master, body: { id, confirmarNome } });

  it("recusa hospital ativo e nome diferente", async () => {
    const t = await criarHospital(amb.db, "Hospital Gama");
    expect((await excluir(t, "Hospital Gama")).status).toBe(409); // ainda ativo
    await status(t, "inativo");
    expect((await excluir(t, "Hospital Errado")).status).toBe(422);
    expect((await chamar(amb.app, "GET", "/master/dashboard", { token: master })).body.tenants.some((x: { id: string }) => x.id === t)).toBe(true);
  });

  it("só o master exclui", async () => {
    const adm = await tokenDe(amb.app, "adm@beta.com");
    const r = await chamar(amb.app, "POST", "/master/hospitais/excluir", { token: adm, body: { id: outro, confirmarNome: "Hospital Beta" } });
    expect(r.status).toBe(403);
  });

  it("apaga tudo do hospital (dados, logins e fotos), libera os e-mails e preserva os outros hospitais", async () => {
    const t = await criarHospital(amb.db, "Hospital Delta");
    const f = await habilitarFeature(amb.db, t, "giro_de_sala");
    const opId = await criarUsuarioDireto(amb.db, { email: "op@delta.com", role: "operador", tenantId: t, featureId: f });
    await criarUsuarioDireto(amb.db, { email: "adm@delta.com", role: "hospital_admin", tenantId: t });
    // histórico que referencia o usuário (FK sem cascata) e uma foto de check-in
    const sala = (await amb.db.query<{ id: string }>("INSERT INTO salas (tenant_id, nome) VALUES ($1, 'Sala 1') RETURNING id", [t])).rows[0]!.id;
    await amb.db.query("INSERT INTO eventos_giro (sala_id, tipo_evento, usuario_inicio_id) VALUES ($1, 'limpeza', $2)", [sala, opId]);
    await amb.db.query("INSERT INTO eventos_sala_parada (sala_id, usuario_inicio_id) VALUES ($1, $2)", [sala, opId]);
    const foto = `${t}/foto-1.png`;
    await amb.storage.put(foto, Buffer.from("x"), "image/png");
    await amb.db.query("INSERT INTO check_ins (tenant_id, doctor_name, photo_path) VALUES ($1, 'Dr. X', $2)", [t, foto]);
    await login(amb.app, "op@delta.com");
    await status(t, "inativo");

    const r = await excluir(t, "  hospital   DELTA ");
    expect(r.status).toBe(200);
    expect(r.body.fotosNaoRemovidas).toBe(0);

    const restos = await amb.db.query(
      `SELECT (SELECT count(*) FROM tenants WHERE id = $1) AS t,
              (SELECT count(*) FROM salas WHERE tenant_id = $1) AS s,
              (SELECT count(*) FROM check_ins WHERE tenant_id = $1) AS c,
              (SELECT count(*) FROM tenant_features WHERE tenant_id = $1) AS f,
              (SELECT count(*) FROM usuarios WHERE email LIKE '%@delta.com') AS u,
              (SELECT count(*) FROM usuarios_perfil WHERE tenant_id = $1) AS p`,
      [t],
    );
    expect(Object.values(restos.rows[0]!).map(Number)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(amb.storage.objetos.has(foto)).toBe(false);

    // e-mail liberado para novo cadastro e outros hospitais intactos
    await criarUsuarioDireto(amb.db, { email: "adm@delta.com", role: "hospital_admin", tenantId: outro });
    expect((await login(amb.app, "adm@beta.com")).status).toBe(200);
    const audit = await amb.db.query<{ detalhes: { nome: string; usuarios_removidos: number } }>(
      "SELECT detalhes FROM log_acoes_sensiveis WHERE acao = 'excluiu_hospital'",
    );
    expect(audit.rows[0]!.detalhes).toMatchObject({ nome: "Hospital Delta", usuarios_removidos: 2 });
  });

  it("uma foto que falha ao sair do storage não desfaz a exclusão e é informada", async () => {
    const t = await criarHospital(amb.db, "Hospital Épsilon");
    await amb.db.query("INSERT INTO check_ins (tenant_id, doctor_name, photo_path) VALUES ($1, 'Dr. Y', $2)", [t, `${t}/f.png`]);
    await status(t, "inativo");
    const original = amb.storage.remove;
    amb.storage.remove = async () => {
      throw new Error("s3 fora do ar");
    };
    try {
      const r = await excluir(t, "Hospital Épsilon");
      expect(r.status).toBe(200);
      expect(r.body.fotosNaoRemovidas).toBe(1);
    } finally {
      amb.storage.remove = original;
    }
    expect((await amb.db.query("SELECT 1 FROM tenants WHERE id = $1", [t])).rowCount).toBe(0);
  });
});

