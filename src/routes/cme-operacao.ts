import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Queryable } from "../db/index.js";
import type { Deps } from "../deps.js";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { SQL_STATUS_CAIXA, auditarCme, configCme, devolverCaixa, exigirChefeCme, exigirEstacaoCme, exigirLeituraCme, moverCaixa, type StatusCaixa } from "../lib/cme.js";
import { normalizarLeitura } from "../lib/datamatrix.js";
import { limitarTentativas } from "../lib/limites.js";
import { leituraSchema, sessaoValida } from "./cme-sala.js";

const uuid = z.string().uuid();
const token = z.string().min(10).max(200);
const nome = z.string().trim().min(2).max(60);

type MaquinaLinha = { id: string; nome: string; ativo: boolean };
type CicloLinha = { id: string; maquina_id: string; nome: string; duracao_min: number };
type CargaLinha = {
  id: string;
  maquina_id: string;
  ciclo_id: string;
  ciclo_nome: string;
  duracao_min: number;
  status: "montando" | "iniciada";
  iniciada_em: string | null;
  termina_em: string | null;
  em_ciclo: boolean;
  /** O ciclo terminou e ninguém confirmou ainda que as caixas foram para o arsenal. */
  aguardando_retirada: boolean;
  caixas: number;
};

const COLUNAS_CARGA = `g.id, g.maquina_id, g.ciclo_id, g.ciclo_nome, g.duracao_min, g.status, g.iniciada_em, g.termina_em,
  (g.status = 'iniciada' AND g.termina_em > now()) AS em_ciclo,
  (g.status = 'iniciada' AND g.termina_em <= now() AND g.retirada_em IS NULL) AS aguardando_retirada,
  (SELECT count(*)::int FROM cme_carga_caixas cc WHERE cc.carga_id = g.id) AS caixas`;

const cargaResumo = (g: CargaLinha) => ({
  id: g.id,
  status:
    g.status === "montando"
      ? ("montando" as const)
      : g.em_ciclo
        ? ("em_ciclo" as const)
        : g.aguardando_retirada
          ? ("aguardando_retirada" as const)
          : ("concluida" as const),
  cicloId: g.ciclo_id,
  cicloNome: g.ciclo_nome,
  duracaoMin: g.duracao_min,
  iniciadaEm: g.iniciada_em,
  terminaEm: g.termina_em,
  caixas: g.caixas,
});

/**
 * Máquinas do hospital com os ciclos ativos e a situação de agora:
 * a carga em montagem, em ciclo ou esperando ir para o arsenal (`carga`) e, com a máquina livre, o último ciclo que terminou (`ultimoCiclo`).
 */
async function situacaoDasMaquinas(q: Queryable, tenantId: string | null, soAtivas: boolean) {
  const [maquinas, ciclos, cargas] = await Promise.all([
    q.query<MaquinaLinha>(
      "SELECT id, nome, ativo FROM cme_maquinas WHERE ($1::uuid IS NULL OR tenant_id = $1) AND ($2::boolean IS FALSE OR ativo) ORDER BY nome, id",
      [tenantId, soAtivas],
    ),
    q.query<CicloLinha>(
      "SELECT id, maquina_id, nome, duracao_min FROM cme_maquina_ciclos WHERE ($1::uuid IS NULL OR tenant_id = $1) AND ativo ORDER BY duracao_min, nome",
      [tenantId],
    ),
    // De cada máquina: a carga em montagem, a que está em ciclo e a última que terminou.
    q.query<CargaLinha>(
      `SELECT ${COLUNAS_CARGA} FROM cme_cargas g
        WHERE ($1::uuid IS NULL OR g.tenant_id = $1)
          AND (g.status = 'montando' OR g.id = (SELECT u.id FROM cme_cargas u WHERE u.maquina_id = g.maquina_id AND u.status = 'iniciada' ORDER BY u.termina_em DESC LIMIT 1))`,
      [tenantId],
    ),
  ]);
  return maquinas.rows.map((m) => {
    const dela = cargas.rows.filter((g) => g.maquina_id === m.id);
    const emCiclo = dela.find((g) => g.em_ciclo);
    const montando = dela.find((g) => g.status === "montando");
    const retirar = dela.find((g) => g.aguardando_retirada);
    const ultima = dela.find((g) => g.status === "iniciada" && !g.em_ciclo && !g.aguardando_retirada);
    const atual = emCiclo ?? retirar ?? montando;
    return {
      id: m.id,
      nome: m.nome,
      ativo: m.ativo,
      ciclos: ciclos.rows.filter((c) => c.maquina_id === m.id).map((c) => ({ id: c.id, nome: c.nome, duracaoMin: c.duracao_min })),
      carga: atual ? cargaResumo(atual) : null,
      ultimoCiclo: !atual && ultima ? cargaResumo(ultima) : null,
    };
  });
}

/** A carga com as caixas dela. `agora` é o relógio do servidor: a contagem da tela não depende da hora do computador. */
async function detalheDaCarga(q: Queryable, cargaId: string) {
  const g = (
    await q.query<CargaLinha & { maquina_nome: string }>(
      `SELECT ${COLUNAS_CARGA}, m.nome AS maquina_nome FROM cme_cargas g JOIN cme_maquinas m ON m.id = g.maquina_id WHERE g.id = $1`,
      [cargaId],
    )
  ).rows[0];
  if (!g) throw notFound("Carga não encontrada.");
  const caixas = await q.query<{ id: string; rotulo: string; tipo_caixa: string; medico_nome: string | null; adicionada_em: string }>(
    `SELECT c.id, c.rotulo, cx.tipo_caixa, cx.medico_nome, cc.adicionada_em
       FROM cme_carga_caixas cc JOIN cme_codigos c ON c.id = cc.caixa_id JOIN cme_caixas cx ON cx.codigo_id = c.id
      WHERE cc.carga_id = $1 ORDER BY cc.adicionada_em, c.id`,
    [cargaId],
  );
  return {
    ...cargaResumo(g),
    maquina: { id: g.maquina_id, nome: g.maquina_nome },
    caixas: caixas.rows.map((c) => ({ id: c.id, rotulo: c.rotulo, tipoCaixa: c.tipo_caixa, medicoNome: c.medico_nome, adicionadaEm: c.adicionada_em })),
    agora: new Date().toISOString(),
  };
}

export const cmeOperacaoRoutes =
  ({ db }: Deps): FastifyPluginAsync =>
  async (app) => {
    /* ---------------------------------------- Máquinas e ciclos (chefe do CME) ---------------------------------------- */

    app.get("/cme/maquinas", async (req) => {
      const { tenantId } = await exigirLeituraCme(db, req.auth.userId);
      return { maquinas: await situacaoDasMaquinas(db, tenantId, false), agora: new Date().toISOString() };
    });

    /** Cria ou edita a máquina com a lista completa de ciclos. Ciclo que sair da lista é inativado (o histórico fica). */
    app.post("/cme/maquinas/salvar", async (req) => {
      const d = z
        .object({
          id: uuid.optional(),
          nome,
          ativo: z.boolean().default(true),
          ciclos: z
            .array(z.object({ id: uuid.optional(), nome, duracaoMin: z.number().int().min(1).max(1440) }))
            .min(1, "Cadastre pelo menos um ciclo com o tempo.")
            .max(20),
        })
        .parse(req.body);
      const { tenantId, perfil } = await exigirChefeCme(db, req.auth.userId);
      const nomes = d.ciclos.map((c) => c.nome.toLowerCase());
      if (new Set(nomes).size !== nomes.length) throw unprocessable("Dois ciclos desta máquina estão com o mesmo nome.");

      return db.tx(async (q) => {
        const repetida = await q.query("SELECT 1 FROM cme_maquinas WHERE tenant_id = $1 AND lower(nome) = lower($2) AND id IS DISTINCT FROM $3::uuid", [
          tenantId,
          d.nome,
          d.id ?? null,
        ]);
        if ((repetida.rowCount ?? 0) > 0) throw conflict("Já existe uma máquina com este nome.");

        let maquinaId = d.id;
        if (maquinaId) {
          const r = await q.query("UPDATE cme_maquinas SET nome = $3, ativo = $4 WHERE id = $1 AND tenant_id = $2", [maquinaId, tenantId, d.nome, d.ativo]);
          if (r.rowCount === 0) throw notFound("Máquina não encontrada.");
        } else {
          maquinaId = (
            await q.query<{ id: string }>("INSERT INTO cme_maquinas (tenant_id, nome, ativo, criado_por) VALUES ($1, $2, $3, $4) RETURNING id", [
              tenantId,
              d.nome,
              d.ativo,
              perfil.id,
            ])
          ).rows[0]!.id;
        }

        const mantidos: string[] = [];
        for (const c of d.ciclos) {
          if (c.id) {
            const r = await q.query("UPDATE cme_maquina_ciclos SET nome = $3, duracao_min = $4, ativo = true WHERE id = $1 AND maquina_id = $2", [
              c.id,
              maquinaId,
              c.nome,
              c.duracaoMin,
            ]);
            if (r.rowCount === 0) throw notFound("Ciclo não encontrado nesta máquina.");
            mantidos.push(c.id);
          } else {
            mantidos.push(
              (
                await q.query<{ id: string }>("INSERT INTO cme_maquina_ciclos (maquina_id, tenant_id, nome, duracao_min) VALUES ($1, $2, $3, $4) RETURNING id", [
                  maquinaId,
                  tenantId,
                  c.nome,
                  c.duracaoMin,
                ])
              ).rows[0]!.id,
            );
          }
        }
        await q.query("UPDATE cme_maquina_ciclos SET ativo = false WHERE maquina_id = $1 AND NOT (id = ANY($2::uuid[]))", [maquinaId, mantidos]);
        await auditarCme(q, {
          tenantId,
          usuarioId: perfil.id,
          ip: req.ip,
          acao: d.id ? "cme_maquina_editada" : "cme_maquina_criada",
          detalhes: { id: maquinaId, ativo: d.ativo, ciclos: d.ciclos.length },
        });
        return { id: maquinaId };
      });
    });

    /* ---------------------------------------- Esterilização (computador do CME) ---------------------------------------- */

    /** Computador do CME + crachá válido. Devolve o que as rotas de esterilização precisam. */
    const operador = async (userId: string, tk: string) => {
      const { tenantId, perfil } = await exigirEstacaoCme(db, userId);
      const sessao = await sessaoValida(db, perfil.id, tk);
      return { tenantId, estacaoId: perfil.id, colaboradorId: sessao.colaborador_id };
    };

    /** Carga do hospital, travada para duas leituras ao mesmo tempo não se atropelarem. */
    const cargaTravada = async (q: Queryable, tenantId: string, cargaId: string) => {
      const g = (
        await q.query<{ id: string; maquina_id: string; status: string; duracao_min: number }>(
          "SELECT id, maquina_id, status, duracao_min FROM cme_cargas WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
          [cargaId, tenantId],
        )
      ).rows[0];
      if (!g) throw notFound("Carga não encontrada.");
      return g;
    };

    /**
     * Máquinas e tempo restante de cada ciclo. É só leitura: não pede crachá e não renova
     * a sessão de quem está logado, por isso a tela pode atualizar a lista sozinha.
     */
    app.get("/cme/esterilizacao/maquinas", async (req) => {
      const { tenantId } = await exigirEstacaoCme(db, req.auth.userId);
      return { maquinas: await situacaoDasMaquinas(db, tenantId, true), agora: new Date().toISOString() };
    });

    /**
     * Abre a máquina: se ela está em ciclo (ou com o ciclo terminado esperando o arsenal), mostra essa carga; se já tem carga em montagem, continua nela
     * (trocando o ciclo, se outro foi escolhido); senão começa uma carga nova com o ciclo escolhido.
     */
    app.post("/cme/esterilizacao/carga/abrir", async (req) => {
      const d = z.object({ token, maquinaId: uuid, cicloId: uuid.optional() }).parse(req.body);
      const { tenantId, estacaoId, colaboradorId } = await operador(req.auth.userId, d.token);
      return db.tx(async (q) => {
        const maquina = (await q.query("SELECT 1 FROM cme_maquinas WHERE id = $1 AND tenant_id = $2 AND ativo FOR UPDATE", [d.maquinaId, tenantId])).rowCount;
        if (!maquina) throw notFound("Máquina não encontrada ou inativa.");
        const ciclo = d.cicloId
          ? (
              await q.query<{ id: string; nome: string; duracao_min: number }>(
                "SELECT id, nome, duracao_min FROM cme_maquina_ciclos WHERE id = $1 AND maquina_id = $2 AND ativo",
                [d.cicloId, d.maquinaId],
              )
            ).rows[0]
          : undefined;
        if (d.cicloId && !ciclo) throw notFound("Ciclo não encontrado nesta máquina.");

        const emCiclo = (
          await q.query<{ id: string }>("SELECT id FROM cme_cargas WHERE maquina_id = $1 AND status = 'iniciada' AND termina_em > now() LIMIT 1", [d.maquinaId])
        ).rows[0];
        if (emCiclo) return detalheDaCarga(q, emCiclo.id);

        // Ciclo terminado e ainda não retirado: a máquina só recebe carga nova depois da confirmação do arsenal.
        const retirar = (
          await q.query<{ id: string }>(
            "SELECT id FROM cme_cargas WHERE maquina_id = $1 AND status = 'iniciada' AND termina_em <= now() AND retirada_em IS NULL ORDER BY termina_em DESC LIMIT 1",
            [d.maquinaId],
          )
        ).rows[0];
        if (retirar) return detalheDaCarga(q, retirar.id);

        const montando = (await q.query<{ id: string }>("SELECT id FROM cme_cargas WHERE maquina_id = $1 AND status = 'montando'", [d.maquinaId])).rows[0];
        if (montando) {
          if (ciclo) {
            await q.query("UPDATE cme_cargas SET ciclo_id = $2, ciclo_nome = $3, duracao_min = $4 WHERE id = $1", [montando.id, ciclo.id, ciclo.nome, ciclo.duracao_min]);
          }
          return detalheDaCarga(q, montando.id);
        }

        if (!ciclo) throw unprocessable("Escolha o ciclo desta carga.");
        const nova = (
          await q.query<{ id: string }>(
            `INSERT INTO cme_cargas (tenant_id, maquina_id, ciclo_id, ciclo_nome, duracao_min, estacao_id, colaborador_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [tenantId, d.maquinaId, ciclo.id, ciclo.nome, ciclo.duracao_min, estacaoId, colaboradorId],
          )
        ).rows[0]!;
        await auditarCme(q, { tenantId, usuarioId: estacaoId, ip: req.ip, acao: "cme_carga_aberta", detalhes: { cargaId: nova.id, maquinaId: d.maquinaId, cicloId: ciclo.id, colaboradorId } });
        return detalheDaCarga(q, nova.id);
      });
    });

    /** Bipou uma caixa para a carga. Toda leitura fica gravada; o erro só sai depois da transação. */
    app.post("/cme/esterilizacao/carga/caixa", async (req) => {
      const d = z
        .object({
          token,
          cargaId: uuid,
          texto: z.string().max(500),
          textoVisivel: z.string().max(2000).optional(),
          motivo: z.string().trim().max(300).optional(),
          ...leituraSchema,
        })
        .parse(req.body);
      const { tenantId, estacaoId, colaboradorId } = await operador(req.auth.userId, d.token);
      await limitarTentativas(db, `cme-leitura:${estacaoId}`, 300, 60_000);
      const normalizado = normalizarLeitura(d.texto);
      if (!normalizado) throw unprocessable("Nenhum código foi recebido.");
      if (d.digitado && (d.motivo?.length ?? 0) < 3) throw unprocessable("Informe o motivo da digitação manual.");

      const r = await db.tx(async (q) => {
        const carga = await cargaTravada(q, tenantId, d.cargaId);
        const codigo = (
          await q.query<{ id: string; tipo: string; rotulo: string; ativo: boolean }>("SELECT id, tipo, rotulo, ativo FROM cme_codigos WHERE tenant_id = $1 AND codigo = $2", [
            tenantId,
            normalizado,
          ])
        ).rows[0];
        await q.query(
          `INSERT INTO cme_leituras (tenant_id, codigo_id, usuario_id, colaborador_id, origem, resultado, texto_bruto, texto_normalizado, duracao_ms, motivo, tela, ip)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'esterilizacao_caixa', $11)`,
          [
            tenantId,
            codigo?.id ?? null,
            estacaoId,
            colaboradorId,
            d.digitado ? "manual" : "leitor",
            codigo ? "reconhecido" : "desconhecido",
            d.textoVisivel ?? null,
            normalizado,
            d.duracaoMs ?? null,
            d.motivo ?? null,
            req.ip,
          ],
        );
        if (carga.status !== "montando") return { erro: conflict("O ciclo desta carga já foi iniciado. Não dá para incluir mais caixas.") };
        if (!codigo) return { erro: notFound("Caixa não encontrada. Confira se o código bipado é o da caixa.") };
        if (codigo.tipo !== "caixa") return { erro: unprocessable("Este é o código de uma peça. Na esterilização, bipe só a caixa.") };
        if (!codigo.ativo) return { erro: unprocessable(`A caixa "${codigo.rotulo}" está inativa.`) };

        const emOutroCiclo = (
          await q.query<{ nome: string }>(
            `SELECT m.nome FROM cme_carga_caixas cc JOIN cme_cargas g ON g.id = cc.carga_id JOIN cme_maquinas m ON m.id = g.maquina_id
              WHERE cc.caixa_id = $1 AND g.status = 'iniciada' AND g.termina_em > now() LIMIT 1`,
            [codigo.id],
          )
        ).rows[0];
        if (emOutroCiclo) return { erro: conflict(`"${codigo.rotulo}" está em ciclo na ${emOutroCiclo.nome}.`) };

        // Antes de incluir: se a caixa estava em outra carga ainda em montagem, moverCaixa a tira de lá.
        await moverCaixa(q, { tenantId, caixaId: codigo.id, setor: "esterilizacao", cargaId: carga.id, colaboradorId, estacaoId });
        const entrou = await q.query(
          "INSERT INTO cme_carga_caixas (carga_id, caixa_id, colaborador_id) VALUES ($1, $2, $3) ON CONFLICT (carga_id, caixa_id) DO NOTHING RETURNING caixa_id",
          [carga.id, codigo.id, colaboradorId],
        );
        if (entrou.rows.length === 0) return { erro: conflict(`"${codigo.rotulo}" já está nesta carga.`) };
        return { ok: { caixa: { id: codigo.id, rotulo: codigo.rotulo }, carga: await detalheDaCarga(q, carga.id) } };
      });
      if (r.erro) throw r.erro;
      return r.ok;
    });

    /** Caixa bipada por engano: sai da carga enquanto o ciclo não começou. Ela volta para o setor em que estava antes. */
    app.post("/cme/esterilizacao/carga/remover", async (req) => {
      const d = z.object({ token, cargaId: uuid, caixaId: uuid }).parse(req.body);
      const { tenantId, estacaoId, colaboradorId } = await operador(req.auth.userId, d.token);
      return db.tx(async (q) => {
        const carga = await cargaTravada(q, tenantId, d.cargaId);
        if (carga.status !== "montando") throw conflict("O ciclo já foi iniciado. Não dá para retirar caixas.");
        const r = await q.query("DELETE FROM cme_carga_caixas WHERE carga_id = $1 AND caixa_id = $2", [carga.id, d.caixaId]);
        if (r.rowCount === 0) throw notFound("Esta caixa não está na carga.");
        await devolverCaixa(q, { tenantId, caixaId: d.caixaId, colaboradorId, estacaoId });
        await auditarCme(q, { tenantId, usuarioId: estacaoId, ip: req.ip, acao: "cme_carga_caixa_retirada", detalhes: { cargaId: carga.id, caixaId: d.caixaId, colaboradorId } });
        return detalheDaCarga(q, carga.id);
      });
    });

    /** Dá a partida no ciclo. A hora de término é calculada aqui, pelo relógio do servidor. */
    app.post("/cme/esterilizacao/carga/iniciar", async (req) => {
      const d = z.object({ token, cargaId: uuid }).parse(req.body);
      const { tenantId, estacaoId, colaboradorId } = await operador(req.auth.userId, d.token);
      return db.tx(async (q) => {
        const carga = await cargaTravada(q, tenantId, d.cargaId);
        if (carga.status !== "montando") throw conflict("O ciclo desta carga já foi iniciado.");
        const caixas = (await q.query("SELECT 1 FROM cme_carga_caixas WHERE carga_id = $1", [carga.id])).rowCount ?? 0;
        if (caixas === 0) throw unprocessable("Bipe pelo menos uma caixa antes de iniciar o ciclo.");
        const rodando = await q.query("SELECT 1 FROM cme_cargas WHERE maquina_id = $1 AND status = 'iniciada' AND termina_em > now()", [carga.maquina_id]);
        if ((rodando.rowCount ?? 0) > 0) throw conflict("Esta máquina ainda está em ciclo.");
        await q.query(
          "UPDATE cme_cargas SET status = 'iniciada', iniciada_em = now(), iniciada_por = $2, termina_em = now() + make_interval(mins => duracao_min) WHERE id = $1",
          [carga.id, colaboradorId],
        );
        await auditarCme(q, {
          tenantId,
          usuarioId: estacaoId,
          ip: req.ip,
          acao: "cme_ciclo_iniciado",
          detalhes: { cargaId: carga.id, maquinaId: carga.maquina_id, colaboradorId, caixas, duracaoMin: carga.duracao_min },
        });
        return detalheDaCarga(q, carga.id);
      });
    });

    /**
     * Ciclo terminado: o colaborador confirma que tirou as caixas da máquina e levou para o arsenal.
     * As caixas passam para "no arsenal" e a máquina fica livre para a próxima carga.
     */
    app.post("/cme/esterilizacao/carga/arsenal", async (req) => {
      const d = z.object({ token, cargaId: uuid }).parse(req.body);
      const { tenantId, estacaoId, colaboradorId } = await operador(req.auth.userId, d.token);
      return db.tx(async (q) => {
        const carga = await cargaTravada(q, tenantId, d.cargaId);
        const situacao = (
          await q.query<{ terminou: boolean; retirada: boolean }>(
            "SELECT (status = 'iniciada' AND termina_em <= now()) AS terminou, (retirada_em IS NOT NULL) AS retirada FROM cme_cargas WHERE id = $1",
            [carga.id],
          )
        ).rows[0]!;
        if (situacao.retirada) throw conflict("Esta carga já foi confirmada no arsenal.");
        if (!situacao.terminou) throw conflict("O ciclo ainda não terminou.");
        await q.query("UPDATE cme_cargas SET retirada_em = now(), retirada_por = $2 WHERE id = $1", [carga.id, colaboradorId]);
        // Só as caixas que ainda estão nesta carga: uma que já foi bipada em outro lugar fica onde está.
        const caixas = await q.query<{ caixa_id: string }>(
          `SELECT cc.caixa_id FROM cme_carga_caixas cc JOIN cme_caixas cx ON cx.codigo_id = cc.caixa_id
            WHERE cc.carga_id = $1 AND cx.local = 'esterilizacao' AND cx.local_carga_id = $1`,
          [carga.id],
        );
        for (const c of caixas.rows) await moverCaixa(q, { tenantId, caixaId: c.caixa_id, setor: "arsenal", colaboradorId, estacaoId });
        await auditarCme(q, {
          tenantId,
          usuarioId: estacaoId,
          ip: req.ip,
          acao: "cme_carga_no_arsenal",
          detalhes: { cargaId: carga.id, maquinaId: carga.maquina_id, colaboradorId, caixas: caixas.rows.length },
        });
        return { ok: true as const, caixas: caixas.rows.length };
      });
    });

    /**
     * SÓ PARA TESTE: apaga a carga (montando, em ciclo ou já terminada) para repetir o teste sem esperar o tempo.
     * Só funciona com o "modo de teste" ligado em CME → Configuração. As caixas voltam para o setor em que estavam antes.
     */
    app.post("/cme/esterilizacao/carga/cancelar", async (req) => {
      const d = z.object({ token, cargaId: uuid }).parse(req.body);
      const { tenantId, estacaoId, colaboradorId } = await operador(req.auth.userId, d.token);
      if (!(await configCme(db, tenantId)).permitirCrachaDigitado) throw forbidden("Cancelar o ciclo só é permitido com o modo de teste ligado.");
      await db.tx(async (q) => {
        const carga = await cargaTravada(q, tenantId, d.cargaId);
        // Só as caixas que ainda estão nesta carga: as que já foram para o arsenal ou outro setor ficam onde estão.
        const caixas = await q.query<{ codigo_id: string }>("SELECT codigo_id FROM cme_caixas WHERE local = 'esterilizacao' AND local_carga_id = $1", [carga.id]);
        await q.query("DELETE FROM cme_carga_caixas WHERE carga_id = $1", [carga.id]);
        // O banco esvazia sozinho a referência à carga nas caixas e no histórico (ON DELETE SET NULL).
        await q.query("DELETE FROM cme_cargas WHERE id = $1", [carga.id]);
        for (const c of caixas.rows) await devolverCaixa(q, { tenantId, caixaId: c.codigo_id, colaboradorId, estacaoId });
        await auditarCme(q, { tenantId, usuarioId: estacaoId, ip: req.ip, acao: "cme_carga_cancelada_teste", detalhes: { cargaId: carga.id, maquinaId: carga.maquina_id, colaboradorId } });
      });
      return { ok: true as const };
    });

    /* ---------------------------------------- Painel (chefe e administração) ---------------------------------------- */

    /**
     * Onde está cada caixa ativa do hospital, a contagem por status e a situação das máquinas.
     * Vai tudo de uma vez (são centenas de linhas curtas): a busca e os filtros ficam instantâneos na tela.
     */
    app.get("/cme/painel", async (req) => {
      const { tenantId } = await exigirLeituraCme(db, req.auth.userId);
      const [caixas, maquinas, hoje] = await Promise.all([
        db.query<{
          id: string;
          rotulo: string;
          tipo_caixa: string;
          medico_nome: string | null;
          status: StatusCaixa;
          desde: string | null;
          sala_nome: string | null;
          maquina_nome: string | null;
          ciclo_nome: string | null;
          termina_em: string | null;
          itens: number;
        }>(
          `SELECT c.id, c.rotulo, cx.tipo_caixa, cx.medico_nome, ${SQL_STATUS_CAIXA} AS status,
                  cx.local_desde AS desde,
                  s.nome AS sala_nome, m.nome AS maquina_nome, g.ciclo_nome, g.termina_em,
                  (SELECT count(*)::int FROM cme_caixa_itens ci JOIN cme_codigos i ON i.id = ci.item_id WHERE ci.caixa_id = c.id AND i.ativo) AS itens
             FROM cme_caixas cx JOIN cme_codigos c ON c.id = cx.codigo_id
             LEFT JOIN salas s ON s.id = cx.local_sala_id
             LEFT JOIN cme_cargas g ON g.id = cx.local_carga_id
             LEFT JOIN cme_maquinas m ON m.id = g.maquina_id
            WHERE ($1::uuid IS NULL OR cx.tenant_id = $1) AND c.ativo ORDER BY c.rotulo, c.id`,
          [tenantId],
        ),
        situacaoDasMaquinas(db, tenantId, true),
        db.query<{ ciclos: number; caixas: number }>(
          `SELECT count(DISTINCT g.id)::int AS ciclos, count(cc.caixa_id)::int AS caixas
             FROM cme_cargas g LEFT JOIN cme_carga_caixas cc ON cc.carga_id = g.id
            WHERE ($1::uuid IS NULL OR g.tenant_id = $1) AND g.status = 'iniciada' AND g.iniciada_em >= now() - interval '24 hours'`,
          [tenantId],
        ),
      ]);
      const resumo: Record<StatusCaixa, number> = { sem_movimento: 0, sala: 0, expurgo: 0, preparo: 0, esterilizacao: 0, arsenal: 0 };
      for (const c of caixas.rows) resumo[c.status] += 1;
      return {
        agora: new Date().toISOString(),
        resumo,
        ultimas24h: { ciclos: hoje.rows[0]?.ciclos ?? 0, caixasEsterilizadas: hoje.rows[0]?.caixas ?? 0 },
        maquinas,
        caixas: caixas.rows.map((c) => ({
          id: c.id,
          rotulo: c.rotulo,
          tipoCaixa: c.tipo_caixa,
          medicoNome: c.medico_nome,
          status: c.status,
          desde: c.desde,
          salaNome: c.sala_nome,
          maquinaNome: c.maquina_nome,
          cicloNome: c.ciclo_nome,
          terminaEm: c.termina_em,
          itens: c.itens,
        })),
      };
    });
  };
