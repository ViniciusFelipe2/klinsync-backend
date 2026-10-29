import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chamar, criarAmbiente, criarHospital, criarUsuarioDireto, habilitarFeature, tokenDe, type Ambiente } from "./helpers.js";

/**
 * Verificações do guia "Vibe coding com segurança" (KipperDev), no que se aplica a esta API:
 * inventário de rotas (10), campos extras (02), SQL injection (03) e erros que não vazam dados (12).
 */

let amb: Ambiente;
let tenantA: string;
let tenantB: string;
let admA: string;
let opA: string;

const ROTAS_PUBLICAS = new Set([
  "GET /health",
  "POST /auth/login",
  "POST /auth/mfa/verify",
  "POST /auth/refresh",
  "POST /auth/logout",
  "POST /convites/validar",
  "POST /convites/aceitar",
]);
const fotoPng = () =>
  `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200)]).toString("base64")}`;

beforeAll(async () => {
  amb = await criarAmbiente();
  tenantA = await criarHospital(amb.db, "Hospital A", 5);
  tenantB = await criarHospital(amb.db, "Hospital B");
  const fa = await habilitarFeature(amb.db, tenantA, "checkin_cirurgioes");
  await criarUsuarioDireto(amb.db, { email: "master@t.com", role: "master_admin" });
  await criarUsuarioDireto(amb.db, { email: "adm-a@t.com", role: "hospital_admin", tenantId: tenantA });
  await criarUsuarioDireto(amb.db, { email: "op-a@t.com", role: "operador", tenantId: tenantA, featureId: fa });
  admA = await tokenDe(amb.app, "adm-a@t.com");
  opA = await tokenDe(amb.app, "op-a@t.com");
});
afterAll(() => amb.fechar());

/** Todas as rotas registradas, lidas da própria aplicação (não de uma lista escrita à mão). */
function rotasRegistradas(): { metodo: string; caminho: string }[] {
  // A árvore mostra as rotas filhas de forma relativa ao pai: o caminho completo se remonta pela indentação.
  const arvore = amb.app.printRoutes({ commonPrefix: false });
  const out: { metodo: string; caminho: string }[] = [];
  const pilha: string[] = [];
  for (const linha of arvore.split("\n")) {
    const marcador = linha.search(/[├└]── /);
    if (marcador < 0) continue;
    const nivel = marcador / 4;
    const resto = linha.slice(marcador + 4);
    const m = resto.match(/^(\S*)(?:\s+\(([A-Z, ]+)\))?/);
    if (!m) continue;
    const caminho = (nivel > 0 ? (pilha[nivel - 1] ?? "") : "") + m[1]!;
    pilha[nivel] = caminho;
    pilha.length = nivel + 1;
    for (const metodo of (m[2] ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
      if (metodo !== "HEAD" && metodo !== "OPTIONS") out.push({ metodo, caminho });
    }
  }
  return out;
}

describe("10 · inventário de rotas e autorização", () => {
  it("toda rota fora da lista pública exige autenticação (negação por padrão)", async () => {
    const rotas = rotasRegistradas();
    expect(rotas.length).toBeGreaterThan(40); // garante que o inventário realmente leu as rotas
    const abertas: string[] = [];
    for (const r of rotas) {
      if (ROTAS_PUBLICAS.has(`${r.metodo} ${r.caminho}`)) continue;
      const url = r.caminho.replace(/:[A-Za-z]+/g, "00000000-0000-4000-8000-000000000000");
      const res = await chamar(amb.app, r.metodo as "GET" | "POST" | "DELETE", url, r.metodo === "GET" ? {} : { body: {} });
      if (res.status !== 401) abertas.push(`${r.metodo} ${r.caminho} -> ${res.status}`);
    }
    expect(abertas).toEqual([]);
  });

  it("não há rotas de depuração, documentação ou arquivos de configuração", async () => {
    for (const url of ["/debug", "/docs", "/swagger", "/openapi.json", "/.env", "/admin", "/metrics", "/graphql"]) {
      const r = await chamar(amb.app, "GET", url);
      expect([401, 404]).toContain(r.status);
      expect(JSON.stringify(r.body)).not.toMatch(/stack|node_modules|\/src\//);
    }
  });

  it("a role vem da sessão: enviar role/tenant no corpo não eleva privilégio", async () => {
    const op = await chamar(amb.app, "POST", "/convites/criar", {
      token: opA,
      body: { nome: "Invasor", email: "invasor@t.com", role: "master_admin", tenantId: tenantB },
    });
    expect(op.status).toBe(403);
    const adm = await chamar(amb.app, "POST", "/convites/criar", {
      token: admA,
      body: { nome: "Invasor", email: "invasor2@t.com", role: "master_admin", tenantId: tenantB },
    });
    expect(adm.status).toBe(403);
  });
});

describe("02 · campos extras e entradas fora do padrão", () => {
  it("campos que não fazem parte do contrato são ignorados e não chegam ao banco", async () => {
    const r = await chamar(amb.app, "POST", "/hospital/salas/salvar", {
      token: admA,
      body: { nome: "Sala Extra", ativa: true, tenant_id: tenantB, tenantId: tenantB, role: "master_admin", limite_salas: 999 },
    });
    expect(r.status).toBe(200);
    const sala = await amb.db.query<{ tenant_id: string }>("SELECT tenant_id FROM salas WHERE nome = 'Sala Extra'");
    expect(sala.rows).toHaveLength(1);
    expect(sala.rows[0]!.tenant_id).toBe(tenantA); // o hospital vem do perfil, nunca do corpo
    const t = await amb.db.query<{ limite_salas: number }>("SELECT limite_salas FROM tenants WHERE id = $1", [tenantA]);
    expect(t.rows[0]!.limite_salas).toBe(5);
  });

  it("tipo errado, texto acima do limite e JSON malformado são recusados sem erro 500", async () => {
    const mestre = await tokenDe(amb.app, "master@t.com");
    const longo = "x".repeat(5000);
    for (const body of [
      { nome: 123, status: "ativo" },
      { nome: longo, status: "ativo" },
      { nome: "Hospital Ok", status: "ativo", cnpj: longo },
      { nome: "Hospital Ok", status: "root" },
    ]) {
      const r = await chamar(amb.app, "POST", "/master/hospitais/salvar", { token: mestre, body });
      expect(r.status).toBe(422);
    }
    const quebrado = await amb.app.inject({
      method: "POST",
      url: "/hospital/checkins",
      headers: { authorization: `Bearer ${admA}`, "content-type": "application/json" },
      payload: "{não é json",
    });
    expect(quebrado.statusCode).toBe(400);
    expect(quebrado.body).not.toMatch(/SyntaxError|at \w+/);
  });
});

describe("03 · SQL injection", () => {
  it("apóstrofos e curingas em filtros e cadastros são tratados como dados", async () => {
    const cadastro = await chamar(amb.app, "POST", "/checkins", {
      token: opA,
      body: { doctorName: "Dr. D'Ávila", photoBase64: fotoPng() },
    });
    expect(cadastro.status).toBe(200);
    expect(cadastro.body.doctor_name).toBe("Dr. D'Ávila");

    for (const busca of ["' OR '1'='1", "'; DROP TABLE check_ins; --", "%", "_", "\\"]) {
      const r = await chamar(amb.app, "POST", "/hospital/checkins", { token: admA, body: { busca } });
      expect(r.status).toBe(200);
      expect(r.body.total).toBe(0); // nenhum nome contém esses textos: o filtro não "abriu"
    }
    const achou = await chamar(amb.app, "POST", "/hospital/checkins", { token: admA, body: { busca: "D'Á" } });
    expect(achou.body.total).toBe(1);
    const restante = await amb.db.query<{ n: number }>("SELECT count(*)::int AS n FROM check_ins");
    expect(restante.rows[0]!.n).toBeGreaterThan(0); // a tabela continua lá
  });

  it("e-mail de login com SQL não autentica nem derruba a requisição", async () => {
    const r = await chamar(amb.app, "POST", "/auth/login", { body: { email: "x@t.com' OR '1'='1", senha: "qualquer" } });
    expect([401, 422]).toContain(r.status);
  });
});

describe("12 · erros que não vazam dados", () => {
  it("erro inesperado devolve mensagem genérica e requestId, sem stack, SQL ou caminhos", async () => {
    const original = amb.storage.put;
    amb.storage.put = async () => {
      throw new Error("falha em /var/app/src/secreto.ts: SELECT * FROM usuarios WHERE senha_hash = 'segredo' postgres://u:senha@10.0.0.5");
    };
    try {
      const r = await chamar(amb.app, "POST", "/checkins", { token: opA, body: { doctorName: "Dr. Erro", photoBase64: fotoPng() } });
      expect(r.status).toBe(500);
      expect(Object.keys(r.body).sort()).toEqual(["message", "requestId"]);
      expect(r.body.requestId).toBeTruthy();
      expect(JSON.stringify(r.body)).not.toMatch(/secreto|SELECT|senha|postgres|\/var\/app|stack/i);
    } finally {
      amb.storage.put = original;
    }
  });

  it("erros esperados mantêm o status correto (401/403/404/422), não viram 500", async () => {
    expect((await chamar(amb.app, "GET", "/rota-que-nao-existe")).status).toBe(404);
    expect((await chamar(amb.app, "GET", "/auth/me")).status).toBe(401);
    expect((await chamar(amb.app, "GET", "/master/dashboard", { token: opA })).status).toBe(403);
    expect((await chamar(amb.app, "POST", "/checkins/excluir", { token: opA, body: { id: "não-é-uuid" } })).status).toBe(422);
  });

  it("referência a registro inexistente (FK) vira 422 sem expor nome de tabela ou constraint", async () => {
    const mestre = await tokenDe(amb.app, "master@t.com");
    const feat = (await amb.db.query<{ id: string }>("SELECT id FROM features LIMIT 1")).rows[0]!.id;
    const r = await chamar(amb.app, "POST", "/master/features/alternar", {
      token: mestre,
      body: { tenantId: "00000000-0000-4000-8000-000000000000", featureId: feat, habilitada: true },
    });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).not.toMatch(/constraint|violates|tenant_features|foreign key/i);
  });
});

describe("08 · armazenamento de senhas", () => {
  it("scrypt com salt próprio: mesma senha gera hashes diferentes e nada fica em texto puro", async () => {
    const hashes = (await amb.db.query<{ senha_hash: string }>("SELECT senha_hash FROM usuarios")).rows.map((r) => r.senha_hash);
    expect(hashes.length).toBeGreaterThanOrEqual(3); // as contas do teste usam a mesma senha
    expect(new Set(hashes).size).toBe(hashes.length);
    for (const h of hashes) {
      expect(h).toMatch(/^scrypt\$32768\$8\$3\$/);
      expect(h).not.toContain("Senha#Forte123");
    }
  });

  it("hash com parâmetros antigos é regravado com os atuais no login", async () => {
    const { scryptSync, randomBytes } = await import("node:crypto");
    const salt = randomBytes(16);
    const antigo = `scrypt$16384$8$1$${salt.toString("base64")}$${scryptSync("Senha#Forte123".normalize("NFKC"), salt, 64, { N: 16384, r: 8, p: 1 }).toString("base64")}`;
    await criarUsuarioDireto(amb.db, { email: "antigo@t.com", role: "hospital_admin", tenantId: tenantA });
    await amb.db.query("UPDATE usuarios SET senha_hash = $1 WHERE email = 'antigo@t.com'", [antigo]);

    expect((await chamar(amb.app, "POST", "/auth/login", { body: { email: "antigo@t.com", senha: "errada" } })).status).toBe(401);
    expect((await amb.db.query<{ senha_hash: string }>("SELECT senha_hash FROM usuarios WHERE email = 'antigo@t.com'")).rows[0]!.senha_hash).toBe(antigo);

    expect((await chamar(amb.app, "POST", "/auth/login", { body: { email: "antigo@t.com", senha: "Senha#Forte123" } })).status).toBe(200);
    expect((await amb.db.query<{ senha_hash: string }>("SELECT senha_hash FROM usuarios WHERE email = 'antigo@t.com'")).rows[0]!.senha_hash).toMatch(
      /^scrypt\$32768\$8\$3\$/,
    );
  });
});
