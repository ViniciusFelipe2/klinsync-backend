import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Queryable } from "../db/index.js";
import type { Deps } from "../deps.js";
import { HttpError, conflict, notFound, unprocessable } from "../errors.js";
import {
  COLUNAS_CODIGO,
  NUMERO_CRACHA,
  auditarCme,
  configCme,
  criarCodigo,
  exigirChefeCme,
  exigirLeituraCme,
  normalizarCracha,
  type CodigoLinha,
} from "../lib/cme.js";
import { TAMANHO_MAX_MM, TAMANHO_MIN_MM, avaliarCodigo, matrizDoConteudo } from "../lib/datamatrix.js";

const uuid = z.string().uuid();
const rotulo = z.string().trim().min(2).max(120);
const tipoCaixa = z.enum(["casa", "consignada"]);
const descricao = z.string().trim().max(300).optional();
const codigoGravado = z.string().max(500).optional();
const tamanhoMm = z.number().min(TAMANHO_MIN_MM).max(TAMANHO_MAX_MM);

type CaixaLinha = CodigoLinha & { tipo_caixa: "casa" | "consignada"; descricao: string | null };
type ItemLinha = CodigoLinha & { caixa_id: string | null };
type ColaboradorLinha = { id: string; nome: string; numero_cracha: string; perfil: "cme" | "sala"; ativo: boolean; created_at: string };

const COLUNAS_CODIGO_C = COLUNAS_CODIGO.split(", ")
  .map((c) => `c.${c}`)
  .join(", ");
const COLUNAS_COLABORADOR = "id, nome, numero_cracha, perfil, ativo, created_at";

const numeroCracha = z
  .string()
  .max(100)
  .transform(normalizarCracha)
  .refine((v) => NUMERO_CRACHA.test(v), "O número do crachá deve ter de 4 a 30 letras, números ou hífen.");

export const cmeCadastrosRoutes =
  ({ db }: Deps): FastifyPluginAsync =>
  async (app) => {
    /** Caixa ativa do hospital (para receber itens). */
    const caixaAtiva = async (q: Queryable, tenantId: string, caixaId: string) => {
      const r = await q.query(
        "SELECT 1 FROM cme_caixas cx JOIN cme_codigos c ON c.id = cx.codigo_id WHERE cx.codigo_id = $1 AND cx.tenant_id = $2 AND c.ativo",
        [caixaId, tenantId],
      );
      if (r.rowCount === 0) throw notFound("Caixa não encontrada ou inativa.");
    };

    /* ---------------------------------------- Caixas e itens ---------------------------------------- */

    /** Todas as caixas com os seus itens, mais os itens que ainda não estão em nenhuma caixa. */
    app.get("/cme/caixas", async (req) => {
      const f = z
        .object({
          busca: z.string().trim().max(120).optional(),
          inativos: z.enum(["true", "false"]).optional(),
          tamanhoMm: z.coerce.number().min(TAMANHO_MIN_MM).max(TAMANHO_MAX_MM).optional(),
        })
        .parse(req.query);
      const { tenantId } = await exigirLeituraCme(db, req.auth.userId);
      const cfg = await configCme(db, tenantId);
      const tamanho = f.tamanhoMm ?? cfg.tamanhoPadraoMm;
      const comInativos = f.inativos === "true";

      const [caixas, itens] = await Promise.all([
        db.query<CaixaLinha>(
          `SELECT ${COLUNAS_CODIGO_C}, cx.tipo_caixa, cx.descricao FROM cme_caixas cx JOIN cme_codigos c ON c.id = cx.codigo_id
            WHERE ($1::uuid IS NULL OR cx.tenant_id = $1) AND ($2 OR c.ativo) ORDER BY c.rotulo, c.id`,
          [tenantId, comInativos],
        ),
        db.query<ItemLinha>(
          `SELECT ${COLUNAS_CODIGO_C}, ci.caixa_id FROM cme_codigos c LEFT JOIN cme_caixa_itens ci ON ci.item_id = c.id
            WHERE c.tipo = 'item' AND ($1::uuid IS NULL OR c.tenant_id = $1) AND ($2 OR c.ativo) ORDER BY c.rotulo, c.id`,
          [tenantId, comInativos],
        ),
      ]);

      const termo = f.busca?.toLowerCase();
      const bate = (c: CodigoLinha) => !termo || c.rotulo.toLowerCase().includes(termo) || c.codigo.toLowerCase().includes(termo);
      const comAvaliacao = <T extends CodigoLinha>(c: T) => ({ ...c, avaliacao: avaliarCodigo(c.matriz_lado, tamanho, cfg) });

      const porCaixa = new Map<string, ItemLinha[]>();
      for (const i of itens.rows) {
        if (!i.caixa_id) continue;
        porCaixa.set(i.caixa_id, [...(porCaixa.get(i.caixa_id) ?? []), i]);
      }
      return {
        tamanhoMm: tamanho,
        // A busca acha a caixa pelo nome dela ou pelo de qualquer item; a caixa aparece sempre com todos os itens.
        caixas: caixas.rows
          .filter((cx) => bate(cx) || (porCaixa.get(cx.id) ?? []).some(bate))
          .map((cx) => ({ ...comAvaliacao(cx), itens: (porCaixa.get(cx.id) ?? []).map(comAvaliacao) })),
        semCaixa: itens.rows.filter((i) => !i.caixa_id && bate(i)).map(comAvaliacao),
      };
    });

    app.post("/cme/caixas/criar", async (req) => {
      const d = z.object({ rotulo, tipoCaixa, descricao, codigoGravado }).parse(req.body);
      const { tenantId, perfil } = await exigirChefeCme(db, req.auth.userId);
      return db.tx(async (q) => {
        const c = await criarCodigo(q, { tenantId, usuarioId: perfil.id, ip: req.ip, tipo: "caixa", rotulo: d.rotulo, codigoGravado: d.codigoGravado });
        await q.query("INSERT INTO cme_caixas (codigo_id, tenant_id, tipo_caixa, descricao) VALUES ($1, $2, $3, $4)", [
          c.id,
          tenantId,
          d.tipoCaixa,
          d.descricao || null,
        ]);
        await auditarCme(q, { tenantId, usuarioId: perfil.id, ip: req.ip, acao: "cme_caixa_criada", detalhes: { id: c.id, tipoCaixa: d.tipoCaixa } });
        return c;
      });
    });

    app.post("/cme/caixas/editar", async (req) => {
      const d = z.object({ id: uuid, rotulo, tipoCaixa, descricao }).parse(req.body);
      const { tenantId, perfil } = await exigirChefeCme(db, req.auth.userId);
      await db.tx(async (q) => {
        const r = await q.query("UPDATE cme_caixas SET tipo_caixa = $3, descricao = $4 WHERE codigo_id = $1 AND tenant_id = $2", [
          d.id,
          tenantId,
          d.tipoCaixa,
          d.descricao || null,
        ]);
        if (r.rowCount === 0) throw notFound("Caixa não encontrada.");
        await q.query("UPDATE cme_codigos SET rotulo = $3 WHERE id = $1 AND tenant_id = $2", [d.id, tenantId, d.rotulo]);
        await auditarCme(q, { tenantId, usuarioId: perfil.id, ip: req.ip, acao: "cme_caixa_editada", detalhes: { id: d.id } });
      });
      return { ok: true as const };
    });

    app.post("/cme/itens/criar", async (req) => {
      const d = z.object({ caixaId: uuid, rotulo, codigoGravado }).parse(req.body);
      const { tenantId, perfil } = await exigirChefeCme(db, req.auth.userId);
      return db.tx(async (q) => {
        await caixaAtiva(q, tenantId, d.caixaId);
        const c = await criarCodigo(q, { tenantId, usuarioId: perfil.id, ip: req.ip, tipo: "item", rotulo: d.rotulo, codigoGravado: d.codigoGravado });
        await q.query("INSERT INTO cme_caixa_itens (item_id, caixa_id, tenant_id) VALUES ($1, $2, $3)", [c.id, d.caixaId, tenantId]);
        await auditarCme(q, { tenantId, usuarioId: perfil.id, ip: req.ip, acao: "cme_item_criado", detalhes: { id: c.id, caixaId: d.caixaId } });
        return c;
      });
    });

    app.post("/cme/itens/editar", async (req) => {
      const d = z.object({ id: uuid, rotulo }).parse(req.body);
      const { tenantId, perfil } = await exigirChefeCme(db, req.auth.userId);
      await db.tx(async (q) => {
        const r = await q.query("UPDATE cme_codigos SET rotulo = $3 WHERE id = $1 AND tenant_id = $2 AND tipo = 'item'", [d.id, tenantId, d.rotulo]);
        if (r.rowCount === 0) throw notFound("Item não encontrado.");
        await auditarCme(q, { tenantId, usuarioId: perfil.id, ip: req.ip, acao: "cme_item_editado", detalhes: { id: d.id } });
      });
      return { ok: true as const };
    });

    /** Coloca o item em uma caixa (vale para itens sem caixa e para trocar de caixa). */
    app.post("/cme/itens/mover", async (req) => {
      const d = z.object({ id: uuid, caixaId: uuid }).parse(req.body);
      const { tenantId, perfil } = await exigirChefeCme(db, req.auth.userId);
      await db.tx(async (q) => {
        const item = await q.query("SELECT 1 FROM cme_codigos WHERE id = $1 AND tenant_id = $2 AND tipo = 'item'", [d.id, tenantId]);
        if (item.rowCount === 0) throw notFound("Item não encontrado.");
        await caixaAtiva(q, tenantId, d.caixaId);
        const antes = (await q.query<{ caixa_id: string }>("SELECT caixa_id FROM cme_caixa_itens WHERE item_id = $1", [d.id])).rows[0];
        await q.query(
          `INSERT INTO cme_caixa_itens (item_id, caixa_id, tenant_id) VALUES ($1, $2, $3)
           ON CONFLICT (item_id) DO UPDATE SET caixa_id = EXCLUDED.caixa_id`,
          [d.id, d.caixaId, tenantId],
        );
        await auditarCme(q, {
          tenantId,
          usuarioId: perfil.id,
          ip: req.ip,
          acao: "cme_item_movido",
          detalhes: { id: d.id, de: antes?.caixa_id ?? null, para: d.caixaId },
        });
      });
      return { ok: true as const };
    });

    /* ---------------------------------------- Colaboradores ---------------------------------------- */

    app.get("/cme/colaboradores", async (req) => {
      const f = z.object({ busca: z.string().trim().max(120).optional(), inativos: z.enum(["true", "false"]).optional() }).parse(req.query);
      const { tenantId } = await exigirLeituraCme(db, req.auth.userId);
      const cfg = await configCme(db, tenantId);
      const termo = f.busca ? `%${f.busca.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
      const r = await db.query<ColaboradorLinha>(
        `SELECT ${COLUNAS_COLABORADOR} FROM cme_colaboradores
          WHERE ($1::uuid IS NULL OR tenant_id = $1) AND ($2 OR ativo) AND ($3::text IS NULL OR nome ILIKE $3 OR numero_cracha ILIKE $3)
          ORDER BY nome, id`,
        [tenantId, f.inativos === "true", termo],
      );
      return {
        tamanhoMm: cfg.tamanhoCrachaMm,
        linhas: r.rows.map((c) => ({ ...c, avaliacao: avaliarCodigo(matrizDoConteudo(c.numero_cracha).length, cfg.tamanhoCrachaMm, cfg) })),
      };
    });

    app.post("/cme/colaboradores/salvar", async (req) => {
      const d = z
        .object({ id: uuid.optional(), nome: z.string().trim().min(3).max(120), numeroCracha, perfil: z.enum(["cme", "sala"]) })
        .parse(req.body);
      const { tenantId, perfil } = await exigirChefeCme(db, req.auth.userId);
      return db.tx(async (q) => {
        const repetido = await q.query("SELECT 1 FROM cme_colaboradores WHERE tenant_id = $1 AND numero_cracha = $2 AND id <> COALESCE($3::uuid, gen_random_uuid())", [
          tenantId,
          d.numeroCracha,
          d.id ?? null,
        ]);
        if (repetido.rowCount > 0) throw conflict("Já existe um colaborador com este número de crachá.");

        let id = d.id;
        if (id) {
          const r = await q.query("UPDATE cme_colaboradores SET nome = $3, numero_cracha = $4, perfil = $5 WHERE id = $1 AND tenant_id = $2", [
            id,
            tenantId,
            d.nome,
            d.numeroCracha,
            d.perfil,
          ]);
          if (r.rowCount === 0) throw notFound("Colaborador não encontrado.");
        } else {
          id = (
            await q.query<{ id: string }>(
              "INSERT INTO cme_colaboradores (tenant_id, nome, numero_cracha, perfil, criado_por) VALUES ($1, $2, $3, $4, $5) RETURNING id",
              [tenantId, d.nome, d.numeroCracha, d.perfil, perfil.id],
            )
          ).rows[0]!.id;
        }
        // Só identificadores na auditoria: nome e número do crachá ficam no cadastro.
        await auditarCme(q, { tenantId, usuarioId: perfil.id, ip: req.ip, acao: d.id ? "cme_colaborador_editado" : "cme_colaborador_criado", detalhes: { id } });
        return (await q.query<ColaboradorLinha>(`SELECT ${COLUNAS_COLABORADOR} FROM cme_colaboradores WHERE id = $1`, [id])).rows[0]!;
      });
    });

    /** Colaborador desligado: o crachá para de valer na hora, inclusive quem já estava logado numa sala. */
    app.post("/cme/colaboradores/situacao", async (req) => {
      const d = z.object({ id: uuid, ativo: z.boolean() }).parse(req.body);
      const { tenantId, perfil } = await exigirChefeCme(db, req.auth.userId);
      await db.tx(async (q) => {
        const r = await q.query("UPDATE cme_colaboradores SET ativo = $3 WHERE id = $1 AND tenant_id = $2", [d.id, tenantId, d.ativo]);
        if (r.rowCount === 0) throw notFound("Colaborador não encontrado.");
        if (!d.ativo) {
          await q.query(
            "UPDATE cme_sessoes_cracha SET encerrada_em = now(), motivo_fim = 'colaborador_inativado' WHERE colaborador_id = $1 AND encerrada_em IS NULL",
            [d.id],
          );
        }
        await auditarCme(q, { tenantId, usuarioId: perfil.id, ip: req.ip, acao: d.ativo ? "cme_colaborador_reativado" : "cme_colaborador_inativado", detalhes: { id: d.id } });
      });
      return { ok: true as const };
    });

    /** Crachás para imprimir. Recusa o lote se algum código ficar abaixo do mínimo do leitor. */
    app.post("/cme/crachas/impressao", async (req) => {
      const d = z.object({ ids: z.array(uuid).min(1).max(200), tamanhoMm: tamanhoMm.optional() }).parse(req.body);
      const { tenantId, perfil } = await exigirChefeCme(db, req.auth.userId);
      return db.tx(async (q) => {
        const cfg = await configCme(q, tenantId);
        const tamanho = d.tamanhoMm ?? cfg.tamanhoCrachaMm;
        const r = await q.query<ColaboradorLinha>(
          `SELECT ${COLUNAS_COLABORADOR} FROM cme_colaboradores WHERE tenant_id = $1 AND ativo AND id = ANY($2::uuid[])`,
          [tenantId, d.ids],
        );
        if (r.rows.length !== new Set(d.ids).size) throw notFound("Algum colaborador selecionado não foi encontrado ou está inativo.");
        const linhas = r.rows
          .sort((a, b) => d.ids.indexOf(a.id) - d.ids.indexOf(b.id))
          .map((c) => {
            const matriz = matrizDoConteudo(c.numero_cracha);
            return { ...c, matriz, avaliacao: avaliarCodigo(matriz.length, tamanho, cfg) };
          });
        const bloqueado = linhas.find((l) => l.avaliacao.situacao === "bloqueado");
        if (bloqueado) throw new HttpError(422, bloqueado.avaliacao.mensagem!, { bloqueados: [{ id: bloqueado.id, rotulo: bloqueado.nome }] });
        if (linhas.length === 0) throw unprocessable("Selecione ao menos um colaborador.");
        await auditarCme(q, { tenantId, usuarioId: perfil.id, ip: req.ip, acao: "cme_crachas_impressos", detalhes: { ids: d.ids, tamanhoMm: tamanho } });
        return { tamanhoMm: tamanho, linhas };
      });
    });
  };
