import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chamar, criarAmbiente, criarHospital, criarUsuarioDireto, login, tokenDe, type Ambiente } from "./helpers.js";

let amb: Ambiente;
let master: string;

const REDE = "10.20.30.40";

beforeAll(async () => {
  amb = await criarAmbiente();
  const t = await criarHospital(amb.db, "Hospital Rede");
  await criarUsuarioDireto(amb.db, { email: "master@t.com", role: "master_admin" });
  await criarUsuarioDireto(amb.db, { email: "adm@rede.com", role: "hospital_admin", tenantId: t });
  await criarUsuarioDireto(amb.db, { email: "outro@rede.com", role: "hospital_admin", tenantId: t });
  master = await tokenDe(amb.app, "master@t.com");
});
afterAll(() => amb.fechar());

const painel = async () => (await chamar(amb.app, "POST", "/master/seguranca/ips", { token: master, body: { dias: 7 } })).body;
const errar = (email: string, vezes: number, ip = REDE) => Promise.all(Array.from({ length: vezes }, () => login(amb.app, email, "Errada#12345", ip)));

describe("liberar rede travada por senhas erradas", () => {
  it("o login trava, o painel mostra quem está travado e o master libera", async () => {
    // padrão: 5 falhas na janela travam o login (inclusive com a senha certa)
    for (let i = 0; i < 5; i++) await login(amb.app, "adm@rede.com", "Errada#12345", REDE);
    const travado = await login(amb.app, "adm@rede.com", undefined, REDE);
    expect(travado.status).toBe(423);

    const p = await painel();
    expect(p.indicadores.travadosAgora).toBeGreaterThanOrEqual(1);
    expect(p.travados).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tipo: "ip", alvo: REDE, falhas: 5 }),
        expect.objectContaining({ tipo: "email", alvo: "adm@rede.com", falhas: 5 }),
      ]),
    );
    expect(p.ips.find((i: { ip: string }) => i.ip === REDE).travado).toBe(true);

    const liberar = await chamar(amb.app, "POST", "/master/seguranca/ips/liberar", { token: master, body: { ip: REDE, email: "adm@rede.com" } });
    expect(liberar.status).toBe(200);
    expect(liberar.body.falhasPerdoadas).toBe(5);

    expect((await login(amb.app, "adm@rede.com", undefined, REDE)).status).toBe(200);
    const depois = await painel();
    expect(depois.travados.find((t: { alvo: string }) => t.alvo === REDE)).toBeUndefined();
  });

  it("não apaga o histórico: as falhas seguem registradas e a liberação fica na auditoria", async () => {
    const falhas = await amb.db.query("SELECT liberado_em FROM log_acessos WHERE sucesso = false AND ip = $1", [REDE]);
    expect(falhas.rowCount).toBe(5);
    expect(falhas.rows.every((r) => (r as { liberado_em: unknown }).liberado_em !== null)).toBe(true);
    const log = await amb.db.query("SELECT detalhes FROM log_acoes_sensiveis WHERE acao = 'liberou_login'");
    expect(log.rowCount).toBe(1);
  });

  it("depois de liberada, a rede volta a ser travada se errar de novo (a proteção não some)", async () => {
    for (let i = 0; i < 5; i++) await login(amb.app, "adm@rede.com", "Errada#12345", REDE);
    expect((await login(amb.app, "adm@rede.com", undefined, REDE)).status).toBe(423);
    await chamar(amb.app, "POST", "/master/seguranca/ips/liberar", { token: master, body: { ip: REDE } });
  });

  it("liberar só a conta não mexe nas outras redes e vice-versa", async () => {
    const OUTRA = "10.99.99.99";
    for (let i = 0; i < 5; i++) await login(amb.app, "outro@rede.com", "Errada#12345", OUTRA);
    expect((await login(amb.app, "outro@rede.com", undefined, "10.1.1.1")).status).toBe(423); // conta travada de qualquer rede

    await chamar(amb.app, "POST", "/master/seguranca/ips/liberar", { token: master, body: { email: "outro@rede.com" } });
    expect((await login(amb.app, "outro@rede.com", undefined, "10.1.1.1")).status).toBe(200);
  });

  it("bloqueio automático do IP: 'Liberar' de verdade destrava (antes o bloqueio voltava na hora)", async () => {
    const AUTO = "10.77.77.77";
    await errar("adm@rede.com", 10, AUTO); // 2x o limite vira bloqueio automático do IP
    expect((await login(amb.app, "adm@rede.com", undefined, AUTO)).status).toBe(423);
    const bloq = await amb.db.query("SELECT 1 FROM ip_bloqueios WHERE ip = $1", [AUTO]);
    expect(bloq.rowCount).toBe(1);

    const r = await chamar(amb.app, "POST", "/master/seguranca/ips/desbloquear", { token: master, body: { ip: AUTO } });
    expect(r.status).toBe(200);
    expect((await login(amb.app, "adm@rede.com", undefined, AUTO)).status).toBe(200);
    expect((await amb.db.query("SELECT 1 FROM ip_bloqueios WHERE ip = $1", [AUTO])).rowCount).toBe(0);
  });

  it("exige IP ou e-mail e só o master pode liberar", async () => {
    expect((await chamar(amb.app, "POST", "/master/seguranca/ips/liberar", { token: master, body: {} })).status).toBe(422);
    const adm = await tokenDe(amb.app, "adm@rede.com");
    expect((await chamar(amb.app, "POST", "/master/seguranca/ips/liberar", { token: adm, body: { ip: REDE } })).status).toBe(403);
  });
});
