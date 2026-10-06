import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SENHA, chamar, criarAmbiente, criarHospital, criarUsuarioDireto, login, tokenDe, type Ambiente } from "./helpers.js";

let amb: Ambiente;

beforeAll(async () => {
  amb = await criarAmbiente();
});
afterAll(() => amb.fechar());

describe("health e proteção", () => {
  it("GET /health responde ok com a versão", async () => {
    const r = await chamar(amb.app, "GET", "/health");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
    expect(r.body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("rotas protegidas exigem Bearer token válido", async () => {
    expect((await chamar(amb.app, "GET", "/auth/me")).status).toBe(401);
    expect((await chamar(amb.app, "GET", "/auth/me", { token: "abc.def.ghi" })).status).toBe(401);
    expect((await chamar(amb.app, "GET", "/giro/salas")).status).toBe(401);
  });

  it("rota inexistente devolve 404 em JSON e erros usam { message }", async () => {
    const r = await chamar(amb.app, "GET", "/nao-existe");
    expect(r.status).toBe(404);
    expect(typeof r.body.message).toBe("string");
  });

  it("responde ao preflight de CORS apenas para a origem configurada", async () => {
    const ok = await amb.app.inject({
      method: "OPTIONS",
      url: "/auth/login",
      headers: { origin: "https://app.exemplo.com.br", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" },
    });
    expect(ok.headers["access-control-allow-origin"]).toBe("https://app.exemplo.com.br");
    const outra = await amb.app.inject({
      method: "OPTIONS",
      url: "/auth/login",
      headers: { origin: "https://malicioso.com", "access-control-request-method": "POST" },
    });
    expect(outra.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("login, sessão e refresh", () => {
  it("login válido devolve sessão; /auth/me identifica o usuário", async () => {
    await criarUsuarioDireto(amb.db, { email: "master@trizion.com", role: "master_admin" });
    const r = await login(amb.app, "master@trizion.com");
    expect(r.status).toBe(200);
    expect(r.body.user.email).toBe("master@trizion.com");
    expect(r.body.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    const me = await chamar(amb.app, "GET", "/auth/me", { token: r.body.accessToken });
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ id: r.body.user.id, email: "master@trizion.com" });
  });

  it("e-mail é case-insensitive e a senha errada devolve mensagem genérica", async () => {
    await criarUsuarioDireto(amb.db, { email: "caso@trizion.com", role: "master_admin" });
    expect((await login(amb.app, "CASO@Trizion.com")).status).toBe(200);
    const errada = await login(amb.app, "caso@trizion.com", "SenhaErrada#1");
    const inexistente = await login(amb.app, "naoexiste@trizion.com", "SenhaErrada#1");
    expect(errada.status).toBe(401);
    expect(errada.body.message).toBe("E-mail ou senha inválidos.");
    expect(inexistente.status).toBe(401);
    expect(inexistente.body.message).toBe(errada.body.message);
  });

  it("registra as tentativas (sucesso e falha) em log_acessos", async () => {
    await criarUsuarioDireto(amb.db, { email: "log@trizion.com", role: "master_admin" });
    await login(amb.app, "log@trizion.com");
    await login(amb.app, "log@trizion.com", "Errada#12345");
    const r = await amb.db.query("SELECT sucesso FROM log_acessos WHERE email_tentado = 'log@trizion.com' ORDER BY created_at");
    expect(r.rows.map((x) => x["sucesso"]).sort()).toEqual([false, true]);
  });

  it("usuário desativado não consegue entrar", async () => {
    const id = await criarUsuarioDireto(amb.db, { email: "off@trizion.com", role: "master_admin" });
    await amb.db.query("UPDATE usuarios_perfil SET ativo = false WHERE id = $1", [id]);
    expect((await login(amb.app, "off@trizion.com")).status).toBe(401);
  });

  it("refresh rotaciona o token e o reuso do token antigo derruba a família", async () => {
    await criarUsuarioDireto(amb.db, { email: "rot@trizion.com", role: "master_admin" });
    const s1 = (await login(amb.app, "rot@trizion.com")).body;
    const s2 = await chamar(amb.app, "POST", "/auth/refresh", { body: { refreshToken: s1.refreshToken } });
    expect(s2.status).toBe(200);
    expect(s2.body.refreshToken).not.toBe(s1.refreshToken);

    // reuso do refresh antigo = possível roubo: invalida também o token novo
    const reuso = await chamar(amb.app, "POST", "/auth/refresh", { body: { refreshToken: s1.refreshToken } });
    expect(reuso.status).toBe(401);
    const novo = await chamar(amb.app, "POST", "/auth/refresh", { body: { refreshToken: s2.body.refreshToken } });
    expect(novo.status).toBe(401);
  });

  it("logout revoga o refresh token (204)", async () => {
    await criarUsuarioDireto(amb.db, { email: "out@trizion.com", role: "master_admin" });
    const s = (await login(amb.app, "out@trizion.com")).body;
    expect((await chamar(amb.app, "POST", "/auth/logout", { body: { refreshToken: s.refreshToken } })).status).toBe(204);
    expect((await chamar(amb.app, "POST", "/auth/refresh", { body: { refreshToken: s.refreshToken } })).status).toBe(401);
  });

  it("refresh de usuário desativado é recusado", async () => {
    const id = await criarUsuarioDireto(amb.db, { email: "ref-off@trizion.com", role: "master_admin" });
    const s = (await login(amb.app, "ref-off@trizion.com")).body;
    await amb.db.query("UPDATE usuarios_perfil SET ativo = false WHERE id = $1", [id]);
    expect((await chamar(amb.app, "POST", "/auth/refresh", { body: { refreshToken: s.refreshToken } })).status).toBe(401);
  });
});

describe("bloqueio por tentativas e por IP", () => {
  it("bloqueia após o limite de falhas (423 com minutosRestantes) e não aceita nem a senha certa", async () => {
    await criarUsuarioDireto(amb.db, { email: "bloq@trizion.com", role: "master_admin" });
    for (let i = 0; i < 5; i++) {
      expect((await login(amb.app, "bloq@trizion.com", "Errada#12345", "10.1.1.1")).status).toBe(401);
    }
    const r = await login(amb.app, "bloq@trizion.com", SENHA, "10.1.1.1");
    expect(r.status).toBe(423);
    expect(r.body.bloqueado).toBe(true);
    expect(r.body.minutosRestantes).toBeGreaterThan(0);
  });

  it("IP em ip_bloqueios permanente é bloqueado antes de checar a senha", async () => {
    await criarUsuarioDireto(amb.db, { email: "ipbloq@trizion.com", role: "master_admin" });
    await amb.db.query("INSERT INTO ip_bloqueios (ip, permanente) VALUES ('10.9.9.9', true)");
    const r = await login(amb.app, "ipbloq@trizion.com", SENHA, "10.9.9.9");
    expect(r.status).toBe(423);
  });

  it("rate limit por IP devolve 429", async () => {
    let ultimo = 0;
    for (let i = 0; i < 32; i++) {
      ultimo = (await login(amb.app, `inexistente${i}@x.com`, "Errada#12345", "10.7.7.7")).status;
    }
    expect(ultimo).toBe(429);
  });
});

describe("captcha", () => {
  it("login recusado (403) quando o captcha falha", async () => {
    const env = await criarAmbiente({ externos: { verificarCaptcha: async () => ({ ok: false, motivo: "score-baixo" }) } });
    try {
      await criarUsuarioDireto(env.db, { email: "cap@trizion.com", role: "master_admin" });
      const r = await login(env.app, "cap@trizion.com");
      expect(r.status).toBe(403);
    } finally {
      await env.fechar();
    }
  });
});

describe("MFA (TOTP)", () => {
  const totp = (segredo: string) => new OTPAuth.TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(segredo) });

  it("cadastro, login em duas etapas e bloqueio de reuso do código", async () => {
    await criarUsuarioDireto(amb.db, { email: "mfa@trizion.com", role: "master_admin" });
    const token = await tokenDe(amb.app, "mfa@trizion.com");

    const enroll = await chamar(amb.app, "POST", "/auth/mfa/enroll", { token, body: { friendlyName: "Teste" } });
    expect(enroll.status).toBe(200);
    expect(enroll.body.qr).toMatch(/^data:image\/png;base64,/);
    const { id, secret } = enroll.body as { id: string; secret: string };

    // código errado não confirma
    expect((await chamar(amb.app, "POST", "/auth/mfa/enroll/confirm", { token, body: { factorId: id, code: "000000" } })).status).toBe(401);
    const confirma = await chamar(amb.app, "POST", "/auth/mfa/enroll/confirm", { token, body: { factorId: id, code: totp(secret).generate() } });
    expect(confirma.status).toBe(200);

    const fatores = await chamar(amb.app, "GET", "/auth/mfa/factors", { token });
    expect(fatores.body).toEqual([expect.objectContaining({ id, status: "verified" })]);

    // agora o login pede o segundo fator
    const etapa1 = await login(amb.app, "mfa@trizion.com");
    expect(etapa1.status).toBe(200);
    expect(etapa1.body.mfaRequired).toBe(true);
    expect(etapa1.body.accessToken).toBeUndefined();
    const { mfaToken, factorId } = etapa1.body as { mfaToken: string; factorId: string };

    // o código já consumido no cadastro não vale de novo (anti-replay)
    const reuso = await chamar(amb.app, "POST", "/auth/mfa/verify", { body: { mfaToken, factorId, code: totp(secret).generate() } });
    expect(reuso.status).toBe(401);

    // um código do próximo passo (30 s à frente, dentro da janela) vale
    const proximo = totp(secret).generate({ timestamp: Date.now() + 30_000 });
    const ok = await chamar(amb.app, "POST", "/auth/mfa/verify", { body: { mfaToken, factorId, code: proximo } });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();

    // o mesmo código não pode ser usado de novo
    const denovo = await chamar(amb.app, "POST", "/auth/mfa/verify", { body: { mfaToken, factorId, code: proximo } });
    expect(denovo.status).toBe(401);

    // remover o fator volta ao login simples
    expect((await chamar(amb.app, "DELETE", `/auth/mfa/factors/${id}`, { token: ok.body.accessToken })).status).toBe(200);
    expect((await login(amb.app, "mfa@trizion.com")).body.accessToken).toBeTruthy();
  });

  it("mfaToken inválido é recusado", async () => {
    const r = await chamar(amb.app, "POST", "/auth/mfa/verify", {
      body: { mfaToken: "x.y.z", factorId: "11111111-1111-4111-8111-111111111111", code: "123456" },
    });
    expect(r.status).toBe(401);
  });
});

describe("sessão e módulos", () => {
  it("destino inicial por papel e acesso a módulos", async () => {
    const t = await criarHospital(amb.db, "Hospital A");
    const feat = await amb.db.query<{ id: string; chave: string }>("SELECT id, chave FROM features");
    const giro = feat.rows.find((f) => f.chave === "giro_de_sala")!;
    await amb.db.query("INSERT INTO tenant_features (tenant_id, feature_id) VALUES ($1, $2)", [t, giro.id]);
    await criarUsuarioDireto(amb.db, { email: "adm@a.com", role: "hospital_admin", tenantId: t });
    await criarUsuarioDireto(amb.db, { email: "op@a.com", role: "operador", tenantId: t, featureId: giro.id });

    const master = await tokenDe(amb.app, "master@trizion.com");
    const adm = await tokenDe(amb.app, "adm@a.com");
    const op = await tokenDe(amb.app, "op@a.com");

    expect((await chamar(amb.app, "GET", "/sessao/destino-inicial", { token: master })).body.destino).toBe("/master");
    expect((await chamar(amb.app, "GET", "/sessao/destino-inicial", { token: adm })).body.destino).toBe("/hospital");
    expect((await chamar(amb.app, "GET", "/sessao/destino-inicial", { token: op })).body.destino).toBe("/giro-sala");

    const sessao = await chamar(amb.app, "GET", "/sessao", { token: op });
    expect(sessao.body.perfil.role).toBe("operador");
    expect(sessao.body.tenant.nome).toBe("Hospital A");
    expect(sessao.body.features.map((f: { chave: string }) => f.chave)).toEqual(["giro_de_sala"]);

    const ok = await chamar(amb.app, "POST", "/modulos/acesso", { token: op, body: { chave: "giro_de_sala" } });
    expect(ok.body).toMatchObject({ permitido: true, motivo: "ok", tenantNome: "Hospital A", podeAdministrar: false });
    const naoContratada = await chamar(amb.app, "POST", "/modulos/acesso", { token: adm, body: { chave: "checkin_cirurgioes" } });
    expect(naoContratada.body).toMatchObject({ permitido: false, motivo: "feature_nao_contratada" });
    const masterOk = await chamar(amb.app, "POST", "/modulos/acesso", { token: master, body: { chave: "checkin_cirurgioes" } });
    expect(masterOk.body).toMatchObject({ permitido: true, tenantNome: "Suporte Trizion" });

    await amb.db.query("UPDATE tenants SET status = 'inadimplente' WHERE id = $1", [t]);
    const inativo = await chamar(amb.app, "POST", "/modulos/acesso", { token: adm, body: { chave: "giro_de_sala" } });
    expect(inativo.body).toMatchObject({ permitido: false, motivo: "hospital_inativo" });

    const nomes = await chamar(amb.app, "GET", "/modulos/equipe-nomes", { token: op });
    expect(nomes.body.map((n: { nome: string }) => n.nome).sort()).toEqual(["adm", "op"]);
  });
});
