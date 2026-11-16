import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LIMITES_PADRAO,
  avaliarCodigo,
  digitoVerificadorOk,
  gerarCodigoCurto,
  matrizDoConteudo,
  normalizarLeitura,
} from "../src/lib/datamatrix.js";
import { chamar, criarAmbiente, criarHospital, criarUsuarioDireto, habilitarFeature, tokenDe, type Ambiente } from "./helpers.js";

const aqui = dirname(fileURLToPath(import.meta.url));

describe("cálculo do quadradinho", () => {
  it("calcula tamanho em mm e em mil, e a margem fica por fora do código", () => {
    const a = avaliarCodigo(12, 5, LIMITES_PADRAO);
    expect(a.moduloMm).toBe(0.417);
    expect(a.moduloMil).toBe(16.4);
    expect(a.modulosPorLado).toBe(12);
    expect(a.tamanhoMm).toBe(5);
    expect(a.totalComMargemMm).toBe(5.833);
    expect(a.situacao).toBe("ok");
  });

  it("0,17 mm equivale a 6,7 mil e 0,19 mm a 7,5 mil", () => {
    expect(avaliarCodigo(20, 3.4, LIMITES_PADRAO).moduloMil).toBe(6.7);
    expect(avaliarCodigo(20, 3.8, LIMITES_PADRAO).moduloMil).toBe(7.5);
  });
});

describe("aviso e bloqueio nos limites", () => {
  it("exatamente em 0,19 mm não avisa; logo abaixo avisa", () => {
    expect(avaliarCodigo(20, 3.8, LIMITES_PADRAO).situacao).toBe("ok");
    const a = avaliarCodigo(20, 3.7, LIMITES_PADRAO);
    expect(a.situacao).toBe("aviso");
    expect(a.mensagem).toContain("0,185");
  });

  it("exatamente em 0,17 mm só avisa, apesar do arredondamento do computador; logo abaixo bloqueia", () => {
    expect(3.4 / 20).toBeLessThan(0.17); // o motivo do arredondamento em avaliarCodigo
    expect(avaliarCodigo(20, 3.4, LIMITES_PADRAO).situacao).toBe("aviso");
    const b = avaliarCodigo(18, 3, LIMITES_PADRAO);
    expect(b.situacao).toBe("bloqueado");
    expect(b.moduloMm).toBe(0.167);
    expect(b.mensagem).toMatch(/Aumente o tamanho do código ou encurte o conteúdo/);
  });

  it("os limites vêm da configuração, não de um modelo de leitor", () => {
    const outroLeitor = { moduloMinimoMm: 0.3, moduloAvisoMm: 0.35, matrizMaxima5mm: 24 };
    expect(avaliarCodigo(16, 5, outroLeitor).situacao).toBe("aviso");
    expect(avaliarCodigo(18, 5, outroLeitor).situacao).toBe("bloqueado");
  });
});

describe("conteúdo e matriz", () => {
  it("conteúdo que força matriz maior que 24x24 é bloqueado em 5 mm, mesmo com quadradinho acima do mínimo", () => {
    const matriz = matrizDoConteudo("1234567890".repeat(8));
    expect(matriz.length).toBeGreaterThan(24);
    const a = avaliarCodigo(26, 5, LIMITES_PADRAO);
    expect(a.moduloMm).toBeGreaterThan(LIMITES_PADRAO.moduloAvisoMm);
    expect(a.situacao).toBe("bloqueado");
    expect(a.mensagem).toContain("26x26");
    expect(avaliarCodigo(24, 5, LIMITES_PADRAO).situacao).toBe("ok");
  });

  it("a mesma matriz grande passa quando o código é maior que 5 mm", () => {
    expect(avaliarCodigo(26, 8, LIMITES_PADRAO).situacao).toBe("ok");
  });

  it("gera ECC 200 quadrado, com as bordas sólidas do padrão", () => {
    const m = matrizDoConteudo("20481357");
    expect(m).toHaveLength(12);
    expect(m.every((l) => l.length === 12)).toBe(true);
    expect(m.every((l) => l[0])).toBe(true); // borda esquerda
    expect(m[11]!.every(Boolean)).toBe(true); // borda de baixo
  });

  it("o código gerado tem 8 dígitos, matriz 12x12 e dígito verificador válido", () => {
    for (let i = 0; i < 50; i++) {
      const c = gerarCodigoCurto(i % 2 ? "item" : "caixa");
      expect(c).toMatch(i % 2 ? /^2\d{7}$/ : /^1\d{7}$/);
      expect(digitoVerificadorOk(c)).toBe(true);
      expect(matrizDoConteudo(c)).toHaveLength(12);
    }
  });

  it("o dígito verificador denuncia dígito errado e troca de vizinhos", () => {
    const c = gerarCodigoCurto("item");
    const errado = `${c.slice(0, 3)}${(Number(c[3]) + 1) % 10}${c.slice(4)}`;
    expect(digitoVerificadorOk(errado)).toBe(false);
    for (let i = 0; i < 7; i++) {
      if (c[i] === c[i + 1]) continue;
      const trocado = `${c.slice(0, i)}${c[i + 1]}${c[i]}${c.slice(i + 2)}`;
      expect(digitoVerificadorOk(trocado)).toBe(false);
    }
  });

  it("limpa caracteres invisíveis e o prefixo de simbologia", () => {
    expect(normalizarLeitura("]d220481357\r\n")).toBe("20481357");
    expect(normalizarLeitura("\u001d010123\u001d21ABC")).toBe("010123" + "21ABC");
  });
});

describe("rotas do CME", () => {
  let amb: Ambiente;
  let tenantA: string;
  let tenantB: string;
  let chefe: string;
  let chefeB: string;
  let colab: string;
  let adm: string;
  let master: string;
  let semFuncao: string;
  let semFuncaoId: string;

  const gerar = async (token: string, r = "Pinça Kelly") => (await chamar(amb.app, "POST", "/cme/codigos/gerar", { token, body: { tipo: "item", rotulo: r } })).body;
  const testar = (token: string, body: Record<string, unknown>) =>
    chamar(amb.app, "POST", "/cme/testes", { token, body: { tipoPeca: "papel", tentativas: 1, ...body } });

  beforeAll(async () => {
    amb = await criarAmbiente();
    tenantA = await criarHospital(amb.db, "Hospital A");
    tenantB = await criarHospital(amb.db, "Hospital B");
    const fa = await habilitarFeature(amb.db, tenantA, "cme");
    const fb = await habilitarFeature(amb.db, tenantB, "cme");
    await criarUsuarioDireto(amb.db, { email: "master@t.com", role: "master_admin" });
    await criarUsuarioDireto(amb.db, { email: "adm@t.com", role: "hospital_admin", tenantId: tenantA });
    const chefeId = await criarUsuarioDireto(amb.db, { email: "chefe@t.com", role: "operador", tenantId: tenantA, featureId: fa });
    const chefeBId = await criarUsuarioDireto(amb.db, { email: "chefe-b@t.com", role: "operador", tenantId: tenantB, featureId: fb });
    const colabId = await criarUsuarioDireto(amb.db, { email: "colab@t.com", role: "operador", tenantId: tenantA, featureId: fa });
    semFuncaoId = await criarUsuarioDireto(amb.db, { email: "sem@t.com", role: "operador", tenantId: tenantA, featureId: fa });
    await amb.db.query("INSERT INTO cme_contas (usuario_id, tenant_id, tipo) VALUES ($1, $2, 'chefe'), ($3, $4, 'chefe'), ($5, $2, 'colaborador')", [
      chefeId,
      tenantA,
      chefeBId,
      tenantB,
      colabId,
    ]);
    master = await tokenDe(amb.app, "master@t.com");
    adm = await tokenDe(amb.app, "adm@t.com");
    chefe = await tokenDe(amb.app, "chefe@t.com");
    chefeB = await tokenDe(amb.app, "chefe-b@t.com");
    colab = await tokenDe(amb.app, "colab@t.com");
    semFuncao = await tokenDe(amb.app, "sem@t.com");
  });
  afterAll(() => amb.fechar());

  describe("permissões", () => {
    it("toda rota exige login", async () => {
      for (const [m, u] of [["GET", "/cme/acesso"], ["GET", "/cme/codigos"], ["POST", "/cme/impressao"], ["POST", "/cme/testes"], ["GET", "/cme/relatorio-falhas"]] as const) {
        expect((await chamar(amb.app, m, u)).status).toBe(401);
      }
    });

    it("administrador e colaborador consultam, mas só o chefe altera", async () => {
      const corpo = { tipo: "item", rotulo: "Tesoura" };
      for (const token of [adm, colab, master]) {
        expect((await chamar(amb.app, "GET", "/cme/codigos", { token })).status).toBe(200);
        expect((await chamar(amb.app, "POST", "/cme/codigos/gerar", { token, body: corpo })).status).toBe(403);
      }
      expect((await chamar(amb.app, "POST", "/cme/codigos/gerar", { token: chefe, body: corpo })).status).toBe(200);
    });

    it("administrador e master não registram leituras", async () => {
      expect((await testar(adm, { origem: "leitor", texto: "1" })).status).toBe(403);
      expect((await testar(master, { origem: "leitor", texto: "1" })).status).toBe(403);
    });

    it("login do módulo sem função definida não entra", async () => {
      expect((await chamar(amb.app, "GET", "/cme/codigos", { token: semFuncao })).status).toBe(403);
    });

    it("hospital sem o módulo contratado não acessa", async () => {
      const t = await criarHospital(amb.db, "Sem CME");
      await criarUsuarioDireto(amb.db, { email: "adm-sem@t.com", role: "hospital_admin", tenantId: t });
      expect((await chamar(amb.app, "GET", "/cme/codigos", { token: await tokenDe(amb.app, "adm-sem@t.com") })).status).toBe(403);
    });

    it("um hospital não enxerga nem imprime os códigos do outro", async () => {
      const c = await gerar(chefe, "Só do A");
      const lista = (await chamar(amb.app, "GET", "/cme/codigos", { token: chefeB })).body;
      expect(lista.linhas.map((l: { id: string }) => l.id)).not.toContain(c.id);
      expect((await chamar(amb.app, "POST", "/cme/impressao", { token: chefeB, body: { ids: [c.id], tamanhoMm: 5 } })).status).toBe(404);
      expect((await chamar(amb.app, "POST", "/cme/folha-teste", { token: chefeB, body: { id: c.id } })).status).toBe(404);
    });
  });

  describe("definição do chefe pelo master", () => {
    it("só o master define, e só para login vinculado ao CME", async () => {
      const corpo = { usuarioId: semFuncaoId, funcao: "chefe" };
      expect((await chamar(amb.app, "POST", "/master/cme/funcao", { token: chefe, body: corpo })).status).toBe(403);
      expect((await chamar(amb.app, "POST", "/master/cme/funcao", { token: master, body: corpo })).status).toBe(200);
      expect((await chamar(amb.app, "GET", "/cme/acesso", { token: semFuncao })).body.podeEditar).toBe(true);
      expect((await chamar(amb.app, "POST", "/master/cme/funcao", { token: master, body: { usuarioId: semFuncaoId, funcao: null } })).status).toBe(200);
      expect((await chamar(amb.app, "GET", "/cme/acesso", { token: semFuncao })).status).toBe(403);

      const admId = (await amb.db.query<{ id: string }>("SELECT id FROM usuarios WHERE email = 'adm@t.com'")).rows[0]!.id;
      expect((await chamar(amb.app, "POST", "/master/cme/funcao", { token: master, body: { usuarioId: admId, funcao: "chefe" } })).status).toBe(403);
    });
  });

  describe("impressão", () => {
    it("imprime com matriz e informa o tamanho calculado", async () => {
      const c = await gerar(chefe);
      expect(c.matriz_lado).toBe(12);
      const r = await chamar(amb.app, "POST", "/cme/impressao", { token: chefe, body: { ids: [c.id], tamanhoMm: 5 } });
      expect(r.status).toBe(200);
      expect(r.body.linhas[0].avaliacao.moduloMm).toBe(0.417);
      expect(r.body.linhas[0].matriz).toHaveLength(12);
    });

    it("o servidor recusa imprimir abaixo do mínimo, mesmo se a tela deixar passar", async () => {
      const longo = "ABCDEFGHJK".repeat(4);
      const c = (await chamar(amb.app, "POST", "/cme/codigos/existente", { token: chefe, body: { tipo: "item", rotulo: "Código longo", codigo: longo } })).body;
      const r = await chamar(amb.app, "POST", "/cme/impressao", { token: chefe, body: { ids: [c.id], tamanhoMm: 3 } });
      expect(r.status).toBe(422);
      expect(r.body.message).toMatch(/abaixo do mínimo/);
      expect(r.body.bloqueados[0].id).toBe(c.id);
      expect(r.body.linhas).toBeUndefined();
    });

    it("a prévia mostra a matriz resultante e não entrega a imagem de um conteúdo bloqueado", async () => {
      const curto = await chamar(amb.app, "POST", "/cme/codigos/previa", { token: chefe, body: { conteudo: "20481357", tamanhoMm: 5 } });
      expect(curto.body.avaliacao.modulosPorLado).toBe(12);
      expect(curto.body.matriz).toHaveLength(12);
      const longo = await chamar(amb.app, "POST", "/cme/codigos/previa", { token: chefe, body: { conteudo: "Pinça Kelly reta 14 cm do conjunto de laparotomia", tamanhoMm: 5 } });
      expect(longo.status).toBe(200);
      expect(longo.body.avaliacao.situacao).toBe("bloqueado");
      expect(longo.body.matriz).toBeNull();
    });

    it("a folha de teste traz 3, 4, 5, 6, 8 e 10 mm", async () => {
      const c = await gerar(chefe);
      const r = await chamar(amb.app, "POST", "/cme/folha-teste", { token: chefe, body: { id: c.id } });
      expect(r.body.tamanhos.map((t: { avaliacao: { tamanhoMm: number } }) => t.avaliacao.tamanhoMm)).toEqual([3, 4, 5, 6, 8, 10]);
      expect(r.body.tamanhos.every((t: { matriz: unknown }) => t.matriz)).toBe(true);
    });

    it("a configuração muda os limites, e aviso abaixo do mínimo é recusado", async () => {
      const c = await gerar(chefeB);
      const cfg = { tamanhoPadraoMm: 5, moduloMinimoMm: 0.5, moduloAvisoMm: 0.6, matrizMaxima5mm: 24 };
      expect((await chamar(amb.app, "POST", "/cme/config", { token: adm, body: cfg })).status).toBe(403);
      expect((await chamar(amb.app, "POST", "/cme/config", { token: chefeB, body: { ...cfg, moduloAvisoMm: 0.4 } })).status).toBe(422);
      expect((await chamar(amb.app, "POST", "/cme/config", { token: chefeB, body: cfg })).status).toBe(200);
      expect((await chamar(amb.app, "POST", "/cme/impressao", { token: chefeB, body: { ids: [c.id], tamanhoMm: 5 } })).status).toBe(422);
    });
  });

  describe("exportação para a empresa de gravação", () => {
    it("exporta códigos gerados e recusa os que já estão gravados", async () => {
      const c = await gerar(chefe, "Para gravar");
      const r = await chamar(amb.app, "POST", "/cme/exportar", { token: chefe, body: { ids: [c.id], tamanhoMm: 5 } });
      expect(r.status).toBe(200);
      expect(r.body.linhas[0].codigo).toBe(c.codigo);
      const g = (await chamar(amb.app, "POST", "/cme/codigos/existente", { token: chefe, body: { tipo: "item", rotulo: "Já gravado", codigo: "GRAV-001" } })).body;
      expect((await chamar(amb.app, "POST", "/cme/exportar", { token: chefe, body: { ids: [g.id], tamanhoMm: 5 } })).status).toBe(422);
      expect((await chamar(amb.app, "POST", "/cme/exportar", { token: adm, body: { ids: [c.id], tamanhoMm: 5 } })).status).toBe(403);
    });
  });

  describe("leitura e falhas", () => {
    it("reconhece o código mesmo com prefixo e sufixo, e guarda o texto como chegou", async () => {
      const c = await gerar(chefe, "Afastador");
      const r = await testar(colab, { origem: "leitor", texto: `]d2${c.codigo}\r`, textoVisivel: `]d2${c.codigo}[ENTER]`, duracaoMs: 40 });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ resultado: "sucesso", reconhecido: true, normalizado: c.codigo });
      expect(r.body.codigo.rotulo).toBe("Afastador");
      const l = await amb.db.query<{ texto_bruto: string }>("SELECT texto_bruto FROM cme_leituras WHERE codigo_id = $1", [c.id]);
      expect(l.rows[0]!.texto_bruto).toBe(`]d2${c.codigo}[ENTER]`);
    });

    it("código desconhecido e texto malicioso não quebram: o texto é só dado", async () => {
      const malicioso = "'; DROP TABLE cme_codigos; --<script>";
      const r = await testar(colab, { origem: "leitor", texto: malicioso });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ reconhecido: false, codigo: null });
      expect((await chamar(amb.app, "GET", "/cme/codigos", { token: chefe })).status).toBe(200);
    });

    it("digitação manual exige motivo, registra quem fez e conta como falha da peça", async () => {
      const c = await gerar(chefe, "Porta-agulha");
      expect((await testar(colab, { origem: "manual", texto: c.codigo })).status).toBe(422);
      const r = await testar(colab, { origem: "manual", texto: c.codigo, motivo: "Peça com brilho" });
      expect(r.body).toMatchObject({ resultado: "falha", reconhecido: true });
      const l = await amb.db.query<{ usuario_id: string; motivo: string; created_at: string }>("SELECT usuario_id, motivo, created_at FROM cme_leituras WHERE codigo_id = $1", [c.id]);
      expect(l.rows[0]!.motivo).toBe("Peça com brilho");
      expect(l.rows[0]!.usuario_id).toBeTruthy();
      expect(l.rows[0]!.created_at).toBeTruthy();
    });

    it("relatório ordena os itens com mais falhas e lista os códigos desconhecidos", async () => {
      const ruim = await gerar(chefe, "Peça ruim");
      const media = await gerar(chefe, "Peça média");
      const boa = await gerar(chefe, "Peça boa");
      await testar(colab, { origem: "manual", texto: ruim.codigo, motivo: "Não leu" });
      await testar(colab, { origem: "nao_leu", codigoId: ruim.id });
      await testar(colab, { origem: "nao_leu", codigoId: media.id });
      await testar(colab, { origem: "leitor", texto: boa.codigo });
      await testar(colab, { origem: "leitor", texto: "NAO-EXISTE-1" });

      const r = (await chamar(amb.app, "GET", "/cme/relatorio-falhas", { token: adm })).body;
      const nomes = r.itens.map((i: { rotulo: string }) => i.rotulo);
      expect(nomes.indexOf("Peça ruim")).toBeLessThan(nomes.indexOf("Peça média"));
      expect(nomes).not.toContain("Peça boa");
      expect(r.itens.find((i: { rotulo: string }) => i.rotulo === "Peça ruim")).toMatchObject({ falhas: 2, manuais: 1, nao_leu: 1 });
      expect(r.desconhecidos.map((d: { texto: string }) => d.texto)).toContain("NAO-EXISTE-1");
      expect(r.manuais.find((x: { rotulo: string }) => x.rotulo === "Peça ruim")).toMatchObject({ motivo: "Não leu", quem: "colab" });
    });

    it("resumo calcula a taxa de sucesso por tipo de peça", async () => {
      const c = await gerar(chefe, "Curva");
      await testar(colab, { origem: "leitor", texto: c.codigo, tipoPeca: "inox_curvo", tentativas: 1, duracaoMs: 30 });
      await testar(colab, { origem: "leitor", texto: c.codigo, tipoPeca: "inox_curvo", tentativas: 3, duracaoMs: 50 });
      await testar(colab, { origem: "nao_leu", codigoId: c.id, tipoPeca: "inox_curvo", tentativas: 5 });
      const r = (await chamar(amb.app, "GET", "/cme/testes/resumo", { token: colab })).body;
      expect(r.find((x: { tipo_peca: string }) => x.tipo_peca === "inox_curvo")).toMatchObject({ total: 3, sucessos: 2, de_primeira: 1, media_tentativas: 3, media_ms: 40 });
    });
  });

  describe("auditoria e histórico", () => {
    it("registra as ações, com quem e de onde", async () => {
      const c = await gerar(chefe, "Auditado");
      await chamar(amb.app, "POST", "/cme/impressao", { token: chefe, body: { ids: [c.id], tamanhoMm: 5 }, ip: "10.1.2.3" });
      const a = await amb.db.query<{ usuario_id: string; ip: string }>("SELECT usuario_id, ip FROM cme_auditoria WHERE acao = 'cme_codigos_impressos' ORDER BY created_at DESC LIMIT 1");
      expect(a.rows[0]!.ip).toBe("10.1.2.3");
      expect(a.rows[0]!.usuario_id).toBeTruthy();
    });

    it("o banco recusa editar ou apagar auditoria e leituras", async () => {
      for (const t of ["cme_auditoria", "cme_leituras", "cme_testes_leitura"]) {
        await expect(amb.db.query(`DELETE FROM ${t}`)).rejects.toThrow(/não podem ser alterados/);
        await expect(amb.db.query(`UPDATE ${t} SET created_at = now()`)).rejects.toThrow(/não podem ser alterados/);
      }
      await expect(amb.db.query("TRUNCATE cme_auditoria")).rejects.toThrow(/não podem ser alterados/);
    });

    it("hospital com rastreabilidade não pode ser excluído", async () => {
      await amb.db.query("UPDATE tenants SET status = 'inativo' WHERE id = $1", [tenantB]);
      const r = await chamar(amb.app, "POST", "/master/hospitais/excluir", { token: master, body: { id: tenantB, confirmarNome: "Hospital B" } });
      expect(r.status).toBe(409);
      expect(r.body.message).toMatch(/rastreabilidade/);
      await amb.db.query("UPDATE tenants SET status = 'ativo' WHERE id = $1", [tenantB]);
    });

    it("inativar mantém o código e o histórico", async () => {
      const c = await gerar(chefe, "Inativar");
      expect((await chamar(amb.app, "POST", "/cme/codigos/situacao", { token: chefe, body: { id: c.id, ativo: false } })).status).toBe(200);
      const ativos = (await chamar(amb.app, "GET", "/cme/codigos?busca=Inativar", { token: chefe })).body;
      expect(ativos.total).toBe(0);
      const todos = (await chamar(amb.app, "GET", "/cme/codigos?busca=Inativar&inativos=true", { token: chefe })).body;
      expect(todos.total).toBe(1);
    });
  });

  it("a migração é reversível e não toca giro de sala nem check-in", async () => {
    const outro = await criarAmbiente();
    const t = await criarHospital(outro.db, "Reversão");
    await outro.db.query("INSERT INTO salas (tenant_id, nome) VALUES ($1, 'Sala 1')", [t]);
    await outro.db.query("CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY)");
    const pg = outro.db as unknown as { query: (s: string) => Promise<unknown> };
    // Desfaz da mais nova para a mais antiga, como deve ser feito no servidor.
    for (const arquivo of ["0010_cme_conferencias.down.sql", "0009_cme_cadastros.down.sql", "0008_cme_codigos.down.sql"]) {
      const down = readFileSync(join(aqui, "db", "down", arquivo), "utf8")
        .replace(/^--.*$/gm, "")
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s && s !== "BEGIN" && s !== "COMMIT");
      for (const comando of down) await pg.query(comando);
    }
    expect((await outro.db.query("SELECT to_regclass('cme_codigos') AS t")).rows[0]!.t).toBeNull();
    expect((await outro.db.query("SELECT to_regclass('cme_colaboradores') AS t")).rows[0]!.t).toBeNull();
    expect((await outro.db.query("SELECT count(*)::int AS n FROM salas")).rows[0]!.n).toBe(1);
    expect((await outro.db.query("SELECT count(*)::int AS n FROM features WHERE chave = 'giro_de_sala'")).rows[0]!.n).toBe(1);
    await outro.fechar();
  });
});
