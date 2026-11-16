import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Queryable } from "../db/index.js";
import type { Deps } from "../deps.js";
import { HttpError, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { registrarAcao } from "../lib/auditoria-log.js";
import {
  COLUNAS_CODIGO,
  acessoCme,
  auditarCme,
  configCme,
  criarCodigo,
  exigirChefeCme,
  exigirEquipeCme,
  exigirLeituraCme,
  type CodigoLinha,
} from "../lib/cme.js";
import { TAMANHOS_FOLHA_TESTE, TAMANHO_MAX_MM, TAMANHO_MIN_MM, avaliarCodigo, matrizDoConteudo, normalizarLeitura } from "../lib/datamatrix.js";
import { limitarTentativas } from "../lib/limites.js";
import { exigirMaster } from "../lib/perfil.js";
import { Where, dataValida, escaparLike, limitesDoPeriodo } from "../lib/sql.js";

const uuid = z.string().uuid();
const tamanhoMm = z.number().min(TAMANHO_MIN_MM).max(TAMANHO_MAX_MM);
const tipoCodigo = z.enum(["item", "caixa"]);
const rotulo = z.string().trim().min(2).max(120);
const idsSchema = z.array(uuid).min(1).max(200);


export const cmeRoutes =
  ({ db, config }: Deps): FastifyPluginAsync =>
  async (app) => {
    const tz = config.APP_TIMEZONE;

    /** Códigos ativos do hospital na ordem pedida; id que não existe (ou de outro hospital) é erro. */
    const codigosAtivos = async (q: Queryable, tenantId: string, ids: string[]): Promise<CodigoLinha[]> => {
      const r = await q.query<CodigoLinha>(`SELECT ${COLUNAS_CODIGO} FROM cme_codigos WHERE tenant_id = $1 AND ativo AND id = ANY($2::uuid[])`, [
        tenantId,
        ids,
      ]);
      if (r.rows.length !== new Set(ids).size) throw notFound("Algum dos códigos selecionados não foi encontrado ou está inativo.");
      return r.rows.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    };

    /* ---------------------------------------- Acesso e configuração ---------------------------------------- */

    app.get("/cme/acesso", async (req) => {
      const { tipo, tenantId, salaId } = await acessoCme(db, req.auth.userId);
      const sala = salaId ? (await db.query<{ id: string; nome: string }>("SELECT id, nome FROM salas WHERE id = $1", [salaId])).rows[0] ?? null : null;
      return {
        tipo,
        podeEditar: tipo === "chefe",
        podeTestar: tipo === "chefe" || tipo === "colaborador",
        sala,
        config: await configCme(db, tenantId),
      };
    });

    app.post("/cme/config", async (req) => {
      const d = z
        .object({
          tamanhoPadraoMm: tamanhoMm,
          moduloMinimoMm: z.number().min(0.05).max(2),
          moduloAvisoMm: z.number().min(0.05).max(2),
          matrizMaxima5mm: z.number().int().min(10).max(144),
          tamanhoCrachaMm: tamanhoMm.optional(),
          permitirCrachaDigitado: z.boolean().optional(),
        })
        .parse(req.body);
      if (d.moduloAvisoMm < d.moduloMinimoMm) throw unprocessable("O limite de aviso não pode ser menor que o mínimo do leitor.");
      const { tenantId, perfil } = await exigirChefeCme(db, req.auth.userId);
      await db.tx(async (q) => {
        // Campo ausente mantém o valor salvo (ou o padrão, na primeira vez).
        await q.query(
          `INSERT INTO cme_config (tenant_id, tamanho_padrao_mm, modulo_minimo_mm, modulo_aviso_mm, matriz_maxima_5mm, tamanho_cracha_mm, permitir_cracha_digitado)
           VALUES ($1, $2, $3, $4, $5, COALESCE($6, 12), COALESCE($7, false))
           ON CONFLICT (tenant_id) DO UPDATE SET tamanho_padrao_mm = EXCLUDED.tamanho_padrao_mm, modulo_minimo_mm = EXCLUDED.modulo_minimo_mm,
             modulo_aviso_mm = EXCLUDED.modulo_aviso_mm, matriz_maxima_5mm = EXCLUDED.matriz_maxima_5mm,
             tamanho_cracha_mm = COALESCE($6, cme_config.tamanho_cracha_mm),
             permitir_cracha_digitado = COALESCE($7, cme_config.permitir_cracha_digitado), updated_at = now()`,
          [tenantId, d.tamanhoPadraoMm, d.moduloMinimoMm, d.moduloAvisoMm, d.matrizMaxima5mm, d.tamanhoCrachaMm ?? null, d.permitirCrachaDigitado ?? null],
        );
        await auditarCme(q, { tenantId, usuarioId: perfil.id, ip: req.ip, acao: "cme_config_alterada", detalhes: d });
      });
      return { ok: true as const };
    });

    /* ---------------------------------------- Códigos ---------------------------------------- */

    app.get("/cme/codigos", async (req) => {
      const f = z
        .object({
          busca: z.string().trim().max(120).optional(),
          inativos: z.enum(["true", "false"]).optional(),
          tamanhoMm: z.coerce.number().min(TAMANHO_MIN_MM).max(TAMANHO_MAX_MM).optional(),
          pagina: z.coerce.number().int().min(1).max(100000).default(1),
        })
        .parse(req.query);
      const { tenantId } = await exigirLeituraCme(db, req.auth.userId);
      const cfg = await configCme(db, tenantId);
      const tamanho = f.tamanhoMm ?? cfg.tamanhoPadraoMm;

      const w = new Where();
      if (tenantId) w.add("tenant_id = ?", tenantId);
      if (f.inativos !== "true") w.add("ativo");
      if (f.busca) {
        const termo = `%${escaparLike(f.busca)}%`;
        w.add("(rotulo ILIKE ? OR codigo ILIKE ?)", termo, termo);
      }
      const porPagina = 50;
      const [linhas, total] = await Promise.all([
        db.query<CodigoLinha>(
          `SELECT ${COLUNAS_CODIGO} FROM cme_codigos ${w.sql} ORDER BY created_at DESC, id LIMIT ${porPagina} OFFSET ${(f.pagina - 1) * porPagina}`,
          w.params,
        ),
        db.query<{ n: number }>(`SELECT count(*)::int AS n FROM cme_codigos ${w.sql}`, w.params),
      ]);
      return {
        tamanhoMm: tamanho,
        total: total.rows[0]?.n ?? 0,
        porPagina,
        linhas: linhas.rows.map((c) => ({ ...c, avaliacao: avaliarCodigo(c.matriz_lado, tamanho, cfg) })),
      };
    });

    app.post("/cme/codigos/gerar", async (req) => {
      const d = z.object({ tipo: tipoCodigo, rotulo }).parse(req.body);
      const { tenantId, perfil } = await exigirChefeCme(db, req.auth.userId);
      return db.tx((q) => criarCodigo(q, { tenantId, usuarioId: perfil.id, ip: req.ip, tipo: d.tipo, rotulo: d.rotulo }));
    });

    /** Código que já está gravado na peça: o sistema só passa a reconhecê-lo. */
    app.post("/cme/codigos/existente", async (req) => {
      const d = z.object({ tipo: tipoCodigo, rotulo, codigo: z.string().max(500) }).parse(req.body);
      const { tenantId, perfil } = await exigirChefeCme(db, req.auth.userId);
      return db.tx((q) => criarCodigo(q, { tenantId, usuarioId: perfil.id, ip: req.ip, tipo: d.tipo, rotulo: d.rotulo, codigoGravado: d.codigo }));
    });

    /** Não existe exclusão: inativar mantém o histórico de leituras. */
    app.post("/cme/codigos/situacao", async (req) => {
      const d = z.object({ id: uuid, ativo: z.boolean() }).parse(req.body);
      const { tenantId, perfil } = await exigirChefeCme(db, req.auth.userId);
      await db.tx(async (q) => {
        const r = await q.query("UPDATE cme_codigos SET ativo = $3 WHERE id = $1 AND tenant_id = $2", [d.id, tenantId, d.ativo]);
        if (r.rowCount === 0) throw notFound("Código não encontrado.");
        await auditarCme(q, { tenantId, usuarioId: perfil.id, ip: req.ip, acao: d.ativo ? "cme_codigo_reativado" : "cme_codigo_inativado", detalhes: { id: d.id } });
      });
      return { ok: true as const };
    });

    /** Mostra, antes de salvar, a matriz e o quadradinho que um conteúdo daria. A matriz não sai quando está bloqueada. */
    app.post("/cme/codigos/previa", async (req) => {
      const d = z.object({ conteudo: z.string().trim().min(1).max(500), tamanhoMm }).parse(req.body);
      const { tenantId } = await exigirChefeCme(db, req.auth.userId);
      const matriz = matrizDoConteudo(d.conteudo);
      const avaliacao = avaliarCodigo(matriz.length, d.tamanhoMm, await configCme(db, tenantId));
      return { avaliacao, matriz: avaliacao.situacao === "bloqueado" ? null : matriz };
    });

    /* ---------------------------------------- Impressão e exportação ---------------------------------------- */

    /** Avalia todos os códigos e recusa o lote inteiro se algum estiver abaixo do mínimo. */
    const lotePermitido = async (q: Queryable, tenantId: string, ids: string[], tamanho: number) => {
      const cfg = await configCme(q, tenantId);
      const avaliados = (await codigosAtivos(q, tenantId, ids)).map((c) => ({ c, avaliacao: avaliarCodigo(c.matriz_lado, tamanho, cfg) }));
      const bloqueados = avaliados.filter((a) => a.avaliacao.situacao === "bloqueado");
      if (bloqueados.length > 0) {
        throw new HttpError(422, bloqueados[0]!.avaliacao.mensagem!, {
          bloqueados: bloqueados.map((b) => ({ id: b.c.id, rotulo: b.c.rotulo })),
        });
      }
      return avaliados;
    };

    app.post("/cme/impressao", async (req) => {
      const d = z.object({ ids: idsSchema, tamanhoMm }).parse(req.body);
      const { tenantId, perfil } = await exigirChefeCme(db, req.auth.userId);
      return db.tx(async (q) => {
        const avaliados = await lotePermitido(q, tenantId, d.ids, d.tamanhoMm);
        await auditarCme(q, { tenantId, usuarioId: perfil.id, ip: req.ip, acao: "cme_codigos_impressos", detalhes: { ids: d.ids, tamanhoMm: d.tamanhoMm } });
        return { linhas: avaliados.map(({ c, avaliacao }) => ({ id: c.id, rotulo: c.rotulo, codigo: c.codigo, avaliacao, matriz: matrizDoConteudo(c.codigo) })) };
      });
    });

    /** O mesmo código em vários tamanhos. Um tamanho abaixo do mínimo sai sem matriz: a folha indica o motivo no lugar dele. */
    app.post("/cme/folha-teste", async (req) => {
      const { id } = z.object({ id: uuid }).parse(req.body);
      const { tenantId, perfil } = await exigirChefeCme(db, req.auth.userId);
      return db.tx(async (q) => {
        const [c] = await codigosAtivos(q, tenantId, [id]);
        const cfg = await configCme(q, tenantId);
        const matriz = matrizDoConteudo(c!.codigo);
        await auditarCme(q, { tenantId, usuarioId: perfil.id, ip: req.ip, acao: "cme_folha_teste_impressa", detalhes: { id } });
        return {
          id: c!.id,
          rotulo: c!.rotulo,
          codigo: c!.codigo,
          tamanhos: TAMANHOS_FOLHA_TESTE.map((t) => {
            const avaliacao = avaliarCodigo(matriz.length, t, cfg);
            return { avaliacao, matriz: avaliacao.situacao === "bloqueado" ? null : matriz };
          }),
        };
      });
    });

    /** Lista para a empresa que grava as peças a laser. Códigos já gravados ficam de fora: não há o que gravar. */
    app.post("/cme/exportar", async (req) => {
      const d = z.object({ ids: idsSchema, tamanhoMm }).parse(req.body);
      const { tenantId, perfil } = await exigirChefeCme(db, req.auth.userId);
      return db.tx(async (q) => {
        const avaliados = await lotePermitido(q, tenantId, d.ids, d.tamanhoMm);
        const jaGravado = avaliados.find((a) => a.c.origem === "existente");
        if (jaGravado) throw unprocessable(`"${jaGravado.c.rotulo}" já está gravado na peça e não precisa ser enviado para a gravação.`);
        await auditarCme(q, { tenantId, usuarioId: perfil.id, ip: req.ip, acao: "cme_codigos_exportados", detalhes: { ids: d.ids, tamanhoMm: d.tamanhoMm } });
        return { linhas: avaliados.map(({ c, avaliacao }) => ({ id: c.id, tipo: c.tipo, rotulo: c.rotulo, codigo: c.codigo, avaliacao, matriz: matrizDoConteudo(c.codigo) })) };
      });
    });

    /* ---------------------------------------- Teste de leitura ---------------------------------------- */

    app.post("/cme/testes", async (req) => {
      const d = z
        .object({
          origem: z.enum(["leitor", "manual", "nao_leu"]),
          texto: z.string().max(500).optional(),
          /** O texto como chegou, com os caracteres invisíveis escritos por extenso (ex.: "[GS]"). Só para diagnóstico. */
          textoVisivel: z.string().max(2000).optional(),
          duracaoMs: z.number().int().min(0).max(3_600_000).optional(),
          motivo: z.string().trim().max(300).optional(),
          codigoId: uuid.optional(),
          tipoPeca: z.enum(["papel", "inox_liso", "inox_curvo", "peca_pequena", "peca_gasta"]),
          tentativas: z.number().int().min(1).max(1000),
          tamanhoMm: tamanhoMm.optional(),
          observacao: z.string().trim().max(300).optional(),
        })
        .parse(req.body);
      const { tenantId, perfil } = await exigirEquipeCme(db, req.auth.userId);
      await limitarTentativas(db, `cme-leitura:${perfil.id}`, 300, 60_000);

      const normalizado = d.texto ? normalizarLeitura(d.texto) : "";
      if (d.origem !== "nao_leu" && !normalizado) throw unprocessable("Nenhum código foi recebido.");
      if (d.origem === "manual" && (d.motivo?.length ?? 0) < 3) throw unprocessable("Informe o motivo da digitação manual.");

      return db.tx(async (q) => {
        const codigo = (
          await (d.origem === "nao_leu"
            ? d.codigoId
              ? q.query<CodigoLinha>(`SELECT ${COLUNAS_CODIGO} FROM cme_codigos WHERE tenant_id = $1 AND id = $2`, [tenantId, d.codigoId])
              : Promise.resolve({ rows: [] as CodigoLinha[] })
            : q.query<CodigoLinha>(`SELECT ${COLUNAS_CODIGO} FROM cme_codigos WHERE tenant_id = $1 AND codigo = $2`, [tenantId, normalizado]))
        ).rows[0];
        if (d.origem === "nao_leu" && d.codigoId && !codigo) throw notFound("Código não encontrado.");

        const resultadoLeitura = d.origem === "nao_leu" ? "nao_leu" : codigo ? "reconhecido" : "desconhecido";
        const leitura = await q.query<{ id: string }>(
          `INSERT INTO cme_leituras (tenant_id, codigo_id, usuario_id, origem, resultado, texto_bruto, texto_normalizado, duracao_ms, motivo, tela, ip)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'teste_leitura', $10) RETURNING id`,
          [tenantId, codigo?.id ?? null, perfil.id, d.origem, resultadoLeitura, d.textoVisivel ?? null, normalizado || null, d.duracaoMs ?? null, d.motivo ?? null, req.ip],
        );
        // Só conta como sucesso o que o leitor entregou sozinho: digitar à mão significa que a peça não leu.
        const resultado = d.origem === "leitor" ? "sucesso" : "falha";
        await q.query(
          `INSERT INTO cme_testes_leitura (tenant_id, leitura_id, usuario_id, tipo_peca, resultado, tentativas, tamanho_mm, observacao)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [tenantId, leitura.rows[0]!.id, perfil.id, d.tipoPeca, resultado, d.tentativas, d.tamanhoMm ?? null, d.observacao ?? null],
        );
        await auditarCme(q, {
          tenantId,
          usuarioId: perfil.id,
          ip: req.ip,
          acao: d.origem === "manual" ? "cme_leitura_manual" : "cme_leitura_teste",
          detalhes: { leituraId: leitura.rows[0]!.id, origem: d.origem, resultado: resultadoLeitura },
        });
        return {
          resultado,
          reconhecido: !!codigo,
          normalizado,
          codigo: codigo ? { id: codigo.id, rotulo: codigo.rotulo, tipo: codigo.tipo, ativo: codigo.ativo } : null,
        };
      });
    });

    app.get("/cme/testes/resumo", async (req) => {
      const { tenantId } = await exigirLeituraCme(db, req.auth.userId);
      const r = await db.query(
        `SELECT t.tipo_peca, count(*)::int AS total,
                count(*) FILTER (WHERE t.resultado = 'sucesso')::int AS sucessos,
                count(*) FILTER (WHERE t.resultado = 'sucesso' AND t.tentativas = 1)::int AS de_primeira,
                round(avg(t.tentativas), 1)::float8 AS media_tentativas,
                round(avg(l.duracao_ms) FILTER (WHERE l.origem = 'leitor'))::int AS media_ms
           FROM cme_testes_leitura t JOIN cme_leituras l ON l.id = t.leitura_id
          WHERE ($1::uuid IS NULL OR t.tenant_id = $1)
          GROUP BY t.tipo_peca ORDER BY t.tipo_peca`,
        [tenantId],
      );
      return r.rows;
    });

    /* ---------------------------------------- Relatório de falhas ---------------------------------------- */

    /** Itens com mais falhas (para decidir o que remarcar) e códigos lidos que não existem no cadastro. */
    app.get("/cme/relatorio-falhas", async (req) => {
      const f = z.object({ de: z.string().max(10).optional(), ate: z.string().max(10).optional() }).parse(req.query);
      const { tenantId } = await exigirLeituraCme(db, req.auth.userId);
      const limites = await limitesDoPeriodo(db, tz, dataValida(f.de), dataValida(f.ate), { dias: 36500 });
      const params = [tenantId, limites.de, limites.ate];
      const periodo = "($1::uuid IS NULL OR l.tenant_id = $1) AND l.created_at >= $2 AND l.created_at < $3";
      const [itens, desconhecidos, manuais] = await Promise.all([
        db.query(
          `SELECT c.id, c.rotulo, c.codigo, c.tipo, c.ativo, count(*)::int AS leituras,
                  count(*) FILTER (WHERE l.origem = 'manual')::int AS manuais,
                  count(*) FILTER (WHERE l.origem = 'nao_leu')::int AS nao_leu,
                  count(*) FILTER (WHERE l.origem <> 'leitor')::int AS falhas,
                  max(l.created_at) FILTER (WHERE l.origem <> 'leitor') AS ultima_falha
             FROM cme_leituras l JOIN cme_codigos c ON c.id = l.codigo_id
            WHERE ${periodo}
            GROUP BY c.id, c.rotulo, c.codigo, c.tipo, c.ativo
           HAVING count(*) FILTER (WHERE l.origem <> 'leitor') > 0
            ORDER BY falhas DESC, c.rotulo LIMIT 200`,
          params,
        ),
        db.query(
          `SELECT l.texto_normalizado AS texto, count(*)::int AS vezes, max(l.created_at) AS ultima
             FROM cme_leituras l
            WHERE ${periodo} AND l.resultado = 'desconhecido'
            GROUP BY l.texto_normalizado ORDER BY vezes DESC, ultima DESC LIMIT 50`,
          params,
        ),
        db.query(
          `SELECT l.id, l.created_at, l.motivo, l.texto_normalizado AS texto, c.rotulo, p.nome AS quem
             FROM cme_leituras l
             LEFT JOIN cme_codigos c ON c.id = l.codigo_id
             LEFT JOIN usuarios_perfil p ON p.id = l.usuario_id
            WHERE ${periodo} AND l.origem = 'manual'
            ORDER BY l.created_at DESC LIMIT 50`,
          params,
        ),
      ]);
      return { itens: itens.rows, desconhecidos: desconhecidos.rows, manuais: manuais.rows };
    });

    /* ---------------------------------------- Equipe master ---------------------------------------- */

    app.get("/master/cme/contas", async (req) => {
      await exigirMaster(db, req.auth.userId);
      return (await db.query("SELECT c.usuario_id, c.tenant_id, c.tipo, c.sala_id, s.nome AS sala_nome FROM cme_contas c LEFT JOIN salas s ON s.id = c.sala_id")).rows;
    });

    /**
     * Define a função de um login no CME: chefe, computador de uma sala cirúrgica, ou nenhuma.
     * O login precisa ser operacional e vinculado ao módulo CME.
     */
    app.post("/master/cme/funcao", async (req) => {
      const d = z
        .object({ usuarioId: uuid, funcao: z.enum(["chefe", "estacao_sala"]).nullable(), salaId: uuid.optional() })
        .parse(req.body);
      const master = await exigirMaster(db, req.auth.userId);
      await db.tx(async (q) => {
        const perfil = (
          await q.query<{ tenant_id: string | null; chave: string | null; role: string }>(
            `SELECT p.tenant_id, p.role, f.chave FROM usuarios_perfil p LEFT JOIN features f ON f.id = p.feature_id WHERE p.id = $1`,
            [d.usuarioId],
          )
        ).rows[0];
        if (!perfil) throw notFound("Usuário não encontrado.");
        if (perfil.role !== "operador" || perfil.chave !== "cme" || !perfil.tenant_id) {
          throw forbidden("Somente um login operacional vinculado ao módulo CME pode ter uma função no CME.");
        }
        let salaId: string | null = null;
        if (d.funcao === "estacao_sala") {
          if (!d.salaId) throw unprocessable("Escolha a sala deste computador.");
          const sala = await q.query("SELECT 1 FROM salas WHERE id = $1 AND tenant_id = $2 AND ativa", [d.salaId, perfil.tenant_id]);
          if (sala.rowCount === 0) throw notFound("Sala não encontrada neste hospital.");
          salaId = d.salaId;
        }
        if (d.funcao) {
          await q.query(
            `INSERT INTO cme_contas (usuario_id, tenant_id, tipo, sala_id, criado_por) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (usuario_id) DO UPDATE SET tipo = EXCLUDED.tipo, sala_id = EXCLUDED.sala_id`,
            [d.usuarioId, perfil.tenant_id, d.funcao, salaId, master.id],
          );
        } else {
          await q.query("DELETE FROM cme_contas WHERE usuario_id = $1", [d.usuarioId]);
        }
        // Trocar a função de um computador de sala derruba quem estava logado nele pelo crachá.
        await q.query(
          "UPDATE cme_sessoes_cracha SET encerrada_em = now(), motivo_fim = 'funcao_alterada' WHERE estacao_id = $1 AND encerrada_em IS NULL",
          [d.usuarioId],
        );
        const acao = d.funcao === "chefe" ? "cme_chefe_definido" : d.funcao === "estacao_sala" ? "cme_estacao_definida" : "cme_funcao_removida";
        await auditarCme(q, { tenantId: perfil.tenant_id, usuarioId: master.id, ip: req.ip, acao, detalhes: { usuarioId: d.usuarioId, salaId } });
        await registrarAcao(q, master.id, acao, { usuario_id: d.usuarioId, tenant_id: perfil.tenant_id, sala_id: salaId });
      });
      return { ok: true as const };
    });
  };
