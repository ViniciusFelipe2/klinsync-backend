import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Queryable } from "../db/index.js";
import type { Deps } from "../deps.js";
import { HttpError, conflict, notFound, unprocessable } from "../errors.js";
import { auditarCme, configCme, exigirEstacaoSala, normalizarCracha, pareceLeitor } from "../lib/cme.js";
import { sha256Hex, tokenAleatorio } from "../lib/crypto.js";
import { normalizarLeitura } from "../lib/datamatrix.js";
import { limitarTentativas } from "../lib/limites.js";

/** A sala é compartilhada: sem nenhuma ação por este tempo, o colaborador sai sozinho. */
export const INATIVIDADE_CRACHA_MIN = 15;
/** Mesmo com uso contínuo, ninguém fica logado mais do que um plantão. */
const DURACAO_MAXIMA_CRACHA_H = 12;
const TENTATIVAS_DE_CRACHA_POR_MINUTO = 20;

/**
 * Sessão de crachá vencida ou recusada responde 422, e não 401: o 401 faria a tela derrubar
 * o login do próprio computador da sala, que continua válido.
 */
const sessaoEncerrada = () => new HttpError(422, "Sua sessão terminou. Bipe o crachá de novo.", { sessaoEncerrada: true });

type Sessao = { id: string; colaborador_id: string; nome: string; numero_cracha: string; perfil: string };

const leituraSchema = {
  duracaoMs: z.number().int().min(0).max(3_600_000).optional(),
  teclas: z.number().int().min(0).max(1000).optional(),
  digitado: z.boolean().default(false),
};

export const cmeSalaRoutes =
  ({ db }: Deps): FastifyPluginAsync =>
  async (app) => {
    /**
     * Confere o token do crachá (do computador desta sala, aberto e dentro do prazo) e renova o prazo de inatividade.
     * Chame fora de transação: o registro de "saiu por inatividade" precisa ficar gravado mesmo com o erro que vem depois.
     */
    const sessaoValida = async (q: Queryable, estacaoId: string, token: string): Promise<Sessao> => {
      const r = await q.query<Sessao & { vencida: boolean }>(
        `SELECT s.id, s.colaborador_id, c.nome, c.numero_cracha, c.perfil,
                (s.ultimo_uso < now() - make_interval(mins => $3::int) OR s.criada_em < now() - make_interval(hours => $4::int)) AS vencida
           FROM cme_sessoes_cracha s JOIN cme_colaboradores c ON c.id = s.colaborador_id
          WHERE s.token_hash = $1 AND s.estacao_id = $2 AND s.encerrada_em IS NULL AND c.ativo`,
        [sha256Hex(token), estacaoId, INATIVIDADE_CRACHA_MIN, DURACAO_MAXIMA_CRACHA_H],
      );
      const s = r.rows[0];
      if (!s) throw sessaoEncerrada();
      if (s.vencida) {
        await q.query("UPDATE cme_sessoes_cracha SET encerrada_em = now(), motivo_fim = 'inatividade' WHERE id = $1", [s.id]);
        throw sessaoEncerrada();
      }
      await q.query("UPDATE cme_sessoes_cracha SET ultimo_uso = now() WHERE id = $1", [s.id]);
      return s;
    };

    const resposta = (s: Sessao) => ({
      colaborador: { id: s.colaborador_id, nome: s.nome, numeroCracha: s.numero_cracha, perfil: s.perfil },
      inatividadeMin: INATIVIDADE_CRACHA_MIN,
    });

    /** Login por crachá. Só funciona no computador da sala, já logado; o crachá sozinho não abre nada pela internet. */
    app.post("/cme/sala/entrar", async (req) => {
      const d = z.object({ cracha: z.string().max(100), ...leituraSchema }).parse(req.body);
      const { tenantId, salaId, perfil } = await exigirEstacaoSala(db, req.auth.userId);
      await limitarTentativas(db, `cme-cracha:${perfil.id}`, TENTATIVAS_DE_CRACHA_POR_MINUTO, 60_000, "Muitas tentativas de crachá. Aguarde um minuto.");

      const cfg = await configCme(db, tenantId);
      if (!cfg.permitirCrachaDigitado && (d.digitado || !pareceLeitor(d.duracaoMs, d.teclas))) {
        await auditarCme(db, { tenantId, usuarioId: perfil.id, ip: req.ip, acao: "cme_cracha_digitado_recusado", detalhes: { salaId } });
        throw unprocessable("Bipe o crachá no leitor. A digitação do número do crachá está desligada.");
      }

      return db.tx(async (q) => {
        const colaborador = (
          await q.query<{ id: string }>("SELECT id FROM cme_colaboradores WHERE tenant_id = $1 AND numero_cracha = $2 AND ativo", [
            tenantId,
            normalizarCracha(d.cracha),
          ])
        ).rows[0];
        if (!colaborador) {
          await auditarCme(q, { tenantId, usuarioId: perfil.id, ip: req.ip, acao: "cme_cracha_recusado", detalhes: { salaId } });
          throw unprocessable("Crachá não reconhecido ou inativo. Procure o chefe do CME.");
        }
        // Um computador, uma pessoa logada por vez.
        await q.query(
          "UPDATE cme_sessoes_cracha SET encerrada_em = now(), motivo_fim = 'novo_login' WHERE estacao_id = $1 AND encerrada_em IS NULL",
          [perfil.id],
        );
        const token = tokenAleatorio(32);
        const sessao = (
          await q.query<{ id: string }>(
            "INSERT INTO cme_sessoes_cracha (tenant_id, estacao_id, sala_id, colaborador_id, token_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id",
            [tenantId, perfil.id, salaId, colaborador.id, sha256Hex(token)],
          )
        ).rows[0]!;
        await auditarCme(q, {
          tenantId,
          usuarioId: perfil.id,
          ip: req.ip,
          acao: "cme_cracha_entrou",
          detalhes: { colaboradorId: colaborador.id, sessaoId: sessao.id, salaId, digitado: d.digitado },
        });
        return { token, ...resposta(await sessaoValida(q, perfil.id, token)) };
      });
    });

    app.post("/cme/sala/sessao", async (req) => {
      const { token } = z.object({ token: z.string().min(10).max(200) }).parse(req.body);
      const { perfil } = await exigirEstacaoSala(db, req.auth.userId);
      return resposta(await sessaoValida(db, perfil.id, token));
    });

    app.post("/cme/sala/sair", async (req) => {
      const d = z.object({ token: z.string().min(10).max(200), motivo: z.enum(["manual", "inatividade"]).default("manual") }).parse(req.body);
      const { tenantId, perfil, salaId } = await exigirEstacaoSala(db, req.auth.userId);
      await db.tx(async (q) => {
        const r = await q.query<{ id: string; colaborador_id: string }>(
          `UPDATE cme_sessoes_cracha SET encerrada_em = now(), motivo_fim = $3
            WHERE token_hash = $1 AND estacao_id = $2 AND encerrada_em IS NULL RETURNING id, colaborador_id`,
          [sha256Hex(d.token), perfil.id, d.motivo],
        );
        const s = r.rows[0];
        if (s) {
          await auditarCme(q, { tenantId, usuarioId: perfil.id, ip: req.ip, acao: "cme_cracha_saiu", detalhes: { sessaoId: s.id, colaboradorId: s.colaborador_id, salaId, motivo: d.motivo } });
        }
      });
      return { ok: true as const };
    });

    /** Bipou a caixa: devolve os itens que devem estar nela (o gabarito). */
    app.post("/cme/sala/caixa", async (req) => {
      const d = z
        .object({ token: z.string().min(10).max(200), texto: z.string().max(500), textoVisivel: z.string().max(2000).optional(), motivo: z.string().trim().max(300).optional(), ...leituraSchema })
        .parse(req.body);
      const { tenantId, perfil, salaId } = await exigirEstacaoSala(db, req.auth.userId);
      await limitarTentativas(db, `cme-leitura:${perfil.id}`, 300, 60_000);
      const normalizado = normalizarLeitura(d.texto);
      if (!normalizado) throw unprocessable("Nenhum código foi recebido.");
      if (d.digitado && (d.motivo?.length ?? 0) < 3) throw unprocessable("Informe o motivo da digitação manual.");

      const sessao = await sessaoValida(db, perfil.id, d.token);
      // A leitura fica gravada mesmo quando a caixa não existe: o erro só sai depois da transação.
      const r = await db.tx(async (q) => {
        const caixa = (
          await q.query<{ id: string; rotulo: string; codigo: string; tipo_caixa: string }>(
            `SELECT c.id, c.rotulo, c.codigo, cx.tipo_caixa FROM cme_caixas cx JOIN cme_codigos c ON c.id = cx.codigo_id
              WHERE cx.tenant_id = $1 AND c.codigo = $2 AND c.ativo`,
            [tenantId, normalizado],
          )
        ).rows[0];
        await q.query(
          `INSERT INTO cme_leituras (tenant_id, codigo_id, usuario_id, colaborador_id, origem, resultado, texto_bruto, texto_normalizado, duracao_ms, motivo, tela, ip)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'sala_caixa', $11)`,
          [
            tenantId,
            caixa?.id ?? null,
            perfil.id,
            sessao.colaborador_id,
            d.digitado ? "manual" : "leitor",
            caixa ? "reconhecido" : "desconhecido",
            d.textoVisivel ?? null,
            normalizado,
            d.duracaoMs ?? null,
            d.motivo ?? null,
            req.ip,
          ],
        );
        if (!caixa) return null;

        // Retoma a conferência que ficou aberta neste computador para esta caixa, ou começa uma nova.
        let conferencia = (
          await q.query<{ id: string }>(
            "SELECT id FROM cme_conferencias WHERE estacao_id = $1 AND caixa_id = $2 AND status = 'em_andamento' ORDER BY iniciada_em DESC LIMIT 1",
            [perfil.id, caixa.id],
          )
        ).rows[0];
        if (!conferencia) {
          const esperados = await q.query("SELECT 1 FROM cme_caixa_itens ci JOIN cme_codigos c ON c.id = ci.item_id WHERE ci.caixa_id = $1 AND c.ativo", [caixa.id]);
          conferencia = (
            await q.query<{ id: string }>(
              `INSERT INTO cme_conferencias (tenant_id, caixa_id, estacao_id, sala_id, colaborador_id, itens_esperados)
               VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
              [tenantId, caixa.id, perfil.id, salaId, sessao.colaborador_id, esperados.rowCount],
            )
          ).rows[0]!;
          await auditarCme(q, {
            tenantId,
            usuarioId: perfil.id,
            ip: req.ip,
            acao: "cme_conferencia_iniciada",
            detalhes: { conferenciaId: conferencia.id, caixaId: caixa.id, colaboradorId: sessao.colaborador_id, salaId },
          });
        }
        return {
          conferenciaId: conferencia.id,
          caixa: { id: caixa.id, rotulo: caixa.rotulo, codigo: caixa.codigo, tipoCaixa: caixa.tipo_caixa },
          itens: await gabarito(q, conferencia.id, caixa.id),
        };
      });
      if (!r) throw notFound("Caixa não encontrada. Confira se o código bipado é o da caixa.");
      return r;
    });

    /** Itens ativos da caixa, marcando os que já foram conferidos nesta conferência. */
    const gabarito = async (q: Queryable, conferenciaId: string, caixaId: string) =>
      (
        await q.query<{ id: string; rotulo: string; codigo: string; conferido: boolean }>(
          `SELECT c.id, c.rotulo, c.codigo, (ci.item_id IS NOT NULL) AS conferido
             FROM cme_caixa_itens cx JOIN cme_codigos c ON c.id = cx.item_id
             LEFT JOIN cme_conferencia_itens ci ON ci.conferencia_id = $1 AND ci.item_id = c.id
            WHERE cx.caixa_id = $2 AND c.ativo ORDER BY c.rotulo, c.id`,
          [conferenciaId, caixaId],
        )
      ).rows;

    /** Conferência aberta deste computador, travada para a leitura não contar a mesma peça duas vezes. */
    const conferenciaDaEstacao = async (q: Queryable, conferenciaId: string, estacaoId: string) =>
      (
        await q.query<{ id: string; caixa_id: string; status: string; iniciada_em: string }>(
          "SELECT id, caixa_id, status, iniciada_em FROM cme_conferencias WHERE id = $1 AND estacao_id = $2 FOR UPDATE",
          [conferenciaId, estacaoId],
        )
      ).rows[0];

    /**
     * Bipou uma peça durante a conferência. Toda leitura fica gravada, inclusive as recusadas
     * (desconhecida, de outra caixa ou repetida): por isso o erro só é lançado depois da transação.
     */
    app.post("/cme/sala/item", async (req) => {
      const d = z
        .object({
          token: z.string().min(10).max(200),
          conferenciaId: z.string().uuid(),
          texto: z.string().max(500),
          textoVisivel: z.string().max(2000).optional(),
          motivo: z.string().trim().max(300).optional(),
          ...leituraSchema,
        })
        .parse(req.body);
      const { tenantId, perfil } = await exigirEstacaoSala(db, req.auth.userId);
      await limitarTentativas(db, `cme-leitura:${perfil.id}`, 300, 60_000);
      const normalizado = normalizarLeitura(d.texto);
      if (!normalizado) throw unprocessable("Nenhum código foi recebido.");
      if (d.digitado && (d.motivo?.length ?? 0) < 3) throw unprocessable("Informe o motivo da digitação manual.");
      const sessao = await sessaoValida(db, perfil.id, d.token);

      const r = await db.tx(async (q) => {
        const conf = await conferenciaDaEstacao(q, d.conferenciaId, perfil.id);
        if (!conf) return { erro: notFound("Conferência não encontrada. Bipe a caixa de novo.") };
        if (conf.status !== "em_andamento") return { erro: conflict("Esta conferência já foi finalizada.") };

        const codigo = (
          await q.query<{ id: string; tipo: string; rotulo: string; ativo: boolean; caixa_id: string | null; caixa_nome: string | null }>(
            `SELECT c.id, c.tipo, c.rotulo, c.ativo, ci.caixa_id, cx.rotulo AS caixa_nome
               FROM cme_codigos c
               LEFT JOIN cme_caixa_itens ci ON ci.item_id = c.id
               LEFT JOIN cme_codigos cx ON cx.id = ci.caixa_id
              WHERE c.tenant_id = $1 AND c.codigo = $2`,
            [tenantId, normalizado],
          )
        ).rows[0];
        const leitura = (
          await q.query<{ id: string }>(
            `INSERT INTO cme_leituras (tenant_id, codigo_id, usuario_id, colaborador_id, origem, resultado, texto_bruto, texto_normalizado, duracao_ms, motivo, tela, ip)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'sala_conferencia', $11) RETURNING id`,
            [
              tenantId,
              codigo?.id ?? null,
              perfil.id,
              sessao.colaborador_id,
              d.digitado ? "manual" : "leitor",
              codigo ? "reconhecido" : "desconhecido",
              d.textoVisivel ?? null,
              normalizado,
              d.duracaoMs ?? null,
              d.motivo ?? null,
              req.ip,
            ],
          )
        ).rows[0]!;

        if (!codigo) return { erro: notFound("Código não cadastrado. Confira a peça ou chame o CME.") };
        if (codigo.tipo === "caixa") return { erro: unprocessable("Este é o código de uma caixa, não de uma peça.") };
        if (codigo.caixa_id !== conf.caixa_id || !codigo.ativo) {
          const onde = codigo.caixa_nome && codigo.caixa_id !== conf.caixa_id ? ` Ela é da caixa "${codigo.caixa_nome}".` : "";
          return { erro: unprocessable(`"${codigo.rotulo}" não pertence a esta caixa.${onde}`) };
        }
        const entrou = await q.query(
          `INSERT INTO cme_conferencia_itens (conferencia_id, item_id, leitura_id, colaborador_id) VALUES ($1, $2, $3, $4)
           ON CONFLICT (conferencia_id, item_id) DO NOTHING RETURNING item_id`,
          [conf.id, codigo.id, leitura.id, sessao.colaborador_id],
        );
        if (entrou.rows.length === 0) return { erro: conflict(`"${codigo.rotulo}" já foi conferido. Não conte duas vezes.`) };
        return { ok: { item: { id: codigo.id, rotulo: codigo.rotulo }, itens: await gabarito(q, conf.id, conf.caixa_id) } };
      });
      if (r.erro) throw r.erro;
      return r.ok;
    });

    /** Fecha a conferência. Só com todos os itens da caixa conferidos. */
    app.post("/cme/sala/finalizar", async (req) => {
      const d = z.object({ token: z.string().min(10).max(200), conferenciaId: z.string().uuid() }).parse(req.body);
      const { tenantId, perfil, salaId } = await exigirEstacaoSala(db, req.auth.userId);
      const sessao = await sessaoValida(db, perfil.id, d.token);
      return db.tx(async (q) => {
        const conf = await conferenciaDaEstacao(q, d.conferenciaId, perfil.id);
        if (!conf) throw notFound("Conferência não encontrada.");
        if (conf.status !== "em_andamento") throw conflict("Esta conferência já foi finalizada.");
        const itens = await gabarito(q, conf.id, conf.caixa_id);
        const faltam = itens.filter((i) => !i.conferido).length;
        if (faltam > 0) throw unprocessable(`Ainda ${faltam === 1 ? "falta 1 item" : `faltam ${faltam} itens`} para conferir.`);
        const r = await q.query<{ segundos: number }>(
          `UPDATE cme_conferencias SET status = 'concluida', finalizada_em = now(), finalizada_por = $2 WHERE id = $1
           RETURNING floor(extract(epoch FROM (finalizada_em - iniciada_em)))::int AS segundos`,
          [conf.id, sessao.colaborador_id],
        );
        await auditarCme(q, {
          tenantId,
          usuarioId: perfil.id,
          ip: req.ip,
          acao: "cme_conferencia_concluida",
          detalhes: { conferenciaId: conf.id, caixaId: conf.caixa_id, colaboradorId: sessao.colaborador_id, salaId, itens: itens.length },
        });
        return { ok: true as const, itens: itens.length, duracaoSegundos: r.rows[0]?.segundos ?? 0 };
      });
    });
  };
