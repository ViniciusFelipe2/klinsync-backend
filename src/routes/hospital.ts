import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { registrarAcao } from "../lib/auditoria-log.js";
import { exigirHospitalAdmin } from "../lib/perfil.js";
import { salvarSala } from "../lib/salas.js";
import { Where, dataLocal, dataValida, ehUuid, escaparLike, limitesDoPeriodo } from "../lib/sql.js";

const paginacao = {
  pagina: z.number().int().min(1).default(1),
  porPagina: z.number().int().min(5).max(200).default(20),
  de: z.string().max(10).optional(),
  ate: z.string().max(10).optional(),
};

type EventoGiro = {
  id: string;
  sala_id: string;
  tipo_evento: string;
  inicio: string;
  fim: string | null;
  duracao_segundos: number | null;
};

const segundosEntre = (inicio: string, fim: string) => Math.round((new Date(fim).getTime() - new Date(inicio).getTime()) / 1000);

type Ciclo = { salaId: string; inicio: string; enfermagem: number; limpeza: number; geral: number };

/**
 * Monta os ciclos de giro a partir de eventos finalizados: cada enfermagem (desmontagem) é um ciclo;
 * a limpeza que começou dentro dela é descontada da enfermagem (tempo líquido) e o geral é a soma.
 */
function montarCiclos(evs: EventoGiro[]): Ciclo[] {
  const limpezas = evs.filter((e) => e.tipo_evento === "limpeza");
  return evs
    .filter((e) => e.tipo_evento === "desmontagem")
    .map((enf) => {
      const ini = new Date(enf.inicio).getTime();
      const fim = enf.fim ? new Date(enf.fim).getTime() : ini;
      const limpezaSeg = limpezas
        .filter((l) => {
          const li = new Date(l.inicio).getTime();
          return l.sala_id === enf.sala_id && li >= ini && li <= fim;
        })
        .reduce((a, l) => a + (l.duracao_segundos ?? 0), 0);
      const geral = enf.duracao_segundos ?? Math.round((fim - ini) / 1000);
      return { salaId: enf.sala_id, inicio: enf.inicio, enfermagem: Math.max(0, geral - limpezaSeg), limpeza: limpezaSeg, geral };
    });
}

/** Registros finalizados mais curtos que isso são sinalizados para conferência (possível falha de apontamento). */
const LIMITE_REVISAO_SEG = 30;

const mediaDe = (valores: number[]) => (valores.length === 0 ? null : Math.round(valores.reduce((a, b) => a + b, 0) / valores.length));

export const hospitalRoutes =
  ({ db, config }: Deps): FastifyPluginAsync =>
  async (app) => {
    const tz = config.APP_TIMEZONE;

    /** Adiciona o filtro de período (colunas timestamptz) usando os limites do dia no fuso do hospital. */
    const filtroPeriodo = async (w: Where, coluna: string, de?: string, ate?: string) => {
      const dDe = dataValida(de);
      const dAte = dataValida(ate);
      if (!dDe && !dAte) return;
      const l = await limitesDoPeriodo(db, tz, dDe, dAte, { dias: 36500 });
      if (dDe) w.add(`${coluna} >= ?`, l.de);
      if (dAte) w.add(`${coluna} < ?`, l.ate);
    };

    app.get("/hospital/usuarios", async (req) => {
      const perfil = await exigirHospitalAdmin(db, req.auth.userId);
      return (await db.query("SELECT * FROM usuarios_perfil WHERE tenant_id = $1 ORDER BY created_at DESC", [perfil.tenant_id])).rows;
    });

    /** Visão geral consolidada do hospital do administrador logado. */
    app.get("/hospital/resumo", async (req) => {
      const perfil = await exigirHospitalAdmin(db, req.auth.userId);
      const t = perfil.tenant_id;

      const [tenant, tf, usuarios, salas, hoje, ultimos30, eventos30, acessos] = await Promise.all([
        db.query("SELECT * FROM tenants WHERE id = $1", [t]),
        db.query(
          `SELECT tf.habilitada, tf.habilitada_em, f.id, f.chave, f.nome_exibicao, f.descricao
             FROM tenant_features tf JOIN features f ON f.id = tf.feature_id WHERE tf.tenant_id = $1`,
          [t],
        ),
        db.query<{ ativo: boolean; role: string }>(
          "SELECT id, nome, email, role, ativo, feature_id, created_at FROM usuarios_perfil WHERE tenant_id = $1",
          [t],
        ),
        db.query<{ ativa: boolean; status_atual: string }>(
          "SELECT id, nome, ativa, status_atual, cirurgia_atual, updated_at FROM salas WHERE tenant_id = $1",
          [t],
        ),
        db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM check_ins
            WHERE tenant_id = $1 AND checked_in_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2`,
          [t, tz],
        ),
        db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM check_ins WHERE tenant_id = $1 AND checked_in_at >= now() - interval '30 days'",
          [t],
        ),
        db.query<{ tipo_evento: string; duracao_segundos: number | null; fim: string | null }>(
          `SELECT e.tipo_evento, e.duracao_segundos, e.inicio, e.fim
             FROM eventos_giro e JOIN salas s ON s.id = e.sala_id
            WHERE s.tenant_id = $1 AND e.inicio >= now() - interval '30 days'`,
          [t],
        ),
        db.query(
          `SELECT id, email_tentado, sucesso, ip, pais_regiao, created_at FROM log_acessos
            WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 10`,
          [t],
        ),
      ]);

      const evs = eventos30.rows;
      const media = (tipo: string) => {
        const v = evs.filter((e) => e.tipo_evento === tipo && e.duracao_segundos != null).map((e) => e.duracao_segundos!);
        return v.length === 0 ? null : Math.round(v.reduce((a, b) => a + b, 0) / v.length);
      };
      // Um "evento de giro" = 1 ciclo completo; contamos só as enfermagens (desmontagem) já finalizadas.
      const ciclosCompletos = evs.filter((e) => e.tipo_evento === "desmontagem" && e.fim).length;
      const listaSalas = salas.rows;
      const lista = usuarios.rows;

      return {
        tenant: tenant.rows[0] ?? null,
        features: tf.rows.map((r) => ({
          habilitada: r["habilitada"],
          habilitadaEm: r["habilitada_em"],
          id: r["id"],
          chave: r["chave"],
          nome_exibicao: r["nome_exibicao"],
          descricao: r["descricao"],
        })),
        usuarios: {
          total: lista.length,
          ativos: lista.filter((u) => u.ativo).length,
          operadores: lista.filter((u) => u.role === "operador").length,
        },
        salas: {
          total: listaSalas.length,
          ativas: listaSalas.filter((s) => s.ativa).length,
          emProcesso: listaSalas.filter((s) => s.status_atual !== "livre").length,
          limite: (tenant.rows[0]?.["limite_salas"] as number | null | undefined) ?? null,
        },
        checkins: { hoje: hoje.rows[0]?.n ?? 0, ultimos30: ultimos30.rows[0]?.n ?? 0 },
        giro: { eventos30: ciclosCompletos, mediaDesmontagem: media("desmontagem"), mediaLimpeza: media("limpeza") },
        acessos: acessos.rows,
      };
    });

    /** Check-ins do hospital com filtro por nome/período e paginação. */
    app.post("/hospital/checkins", async (req) => {
      const d = z.object({ busca: z.string().max(120).optional(), ...paginacao }).parse(req.body ?? {});
      const perfil = await exigirHospitalAdmin(db, req.auth.userId);
      const w = new Where().add("tenant_id = ?", perfil.tenant_id);
      if (d.busca) w.add("doctor_name ILIKE ?", `%${escaparLike(d.busca)}%`);
      await filtroPeriodo(w, "checked_in_at", d.de, d.ate);

      const [linhas, total] = await Promise.all([
        db.query(
          `SELECT id, doctor_name, checked_in_at, created_at FROM check_ins ${w.sql}
            ORDER BY checked_in_at DESC LIMIT $${w.proximo} OFFSET $${w.proximo + 1}`,
          [...w.params, d.porPagina, (d.pagina - 1) * d.porPagina],
        ),
        db.query<{ n: number }>(`SELECT count(*)::int AS n FROM check_ins ${w.sql}`, w.params),
      ]);
      return { linhas: linhas.rows, total: total.rows[0]?.n ?? 0 };
    });

    /** Eventos de giro de sala do hospital com filtro e paginação. */
    app.post("/hospital/giro", async (req) => {
      const d = z
        .object({
          salaId: z.string().max(40).optional(),
          etapa: z.enum(["todas", "desmontagem", "limpeza"]).default("todas"),
          ...paginacao,
        })
        .parse(req.body ?? {});
      const perfil = await exigirHospitalAdmin(db, req.auth.userId);

      const w = new Where().add("s.tenant_id = ?", perfil.tenant_id);
      if (d.salaId && d.salaId !== "todas") {
        if (!ehUuid(d.salaId)) return { linhas: [], total: 0 };
        w.add("e.sala_id = ?", d.salaId);
      }
      if (d.etapa !== "todas") w.add("e.tipo_evento = ?::tipo_evento_giro", d.etapa);
      await filtroPeriodo(w, "e.inicio", d.de, d.ate);

      const [res, total] = await Promise.all([
        db.query<{
          id: string;
          tipo_evento: string;
          inicio: string;
          fim: string | null;
          duracao_segundos: number | null;
          cirurgia_anterior: string | null;
          cirurgia_proxima: string | null;
          sala_id: string;
          sala_nome: string;
          usuario_inicio: string | null;
          usuario_fim: string | null;
        }>(
          `SELECT e.id, e.tipo_evento, e.inicio, e.fim, e.duracao_segundos, e.cirurgia_anterior, e.cirurgia_proxima,
                  e.sala_id, s.nome AS sala_nome,
                  COALESCE(NULLIF(ui.nome, ''), ui.email) AS usuario_inicio,
                  COALESCE(NULLIF(uf.nome, ''), uf.email) AS usuario_fim
             FROM eventos_giro e JOIN salas s ON s.id = e.sala_id
             LEFT JOIN usuarios_perfil ui ON ui.id = e.usuario_inicio_id
             LEFT JOIN usuarios_perfil uf ON uf.id = e.usuario_fim_id ${w.sql}
            ORDER BY e.inicio DESC LIMIT $${w.proximo} OFFSET $${w.proximo + 1}`,
          [...w.params, d.porPagina, (d.pagina - 1) * d.porPagina],
        ),
        db.query<{ n: number }>(`SELECT count(*)::int AS n FROM eventos_giro e JOIN salas s ON s.id = e.sala_id ${w.sql}`, w.params),
      ]);

      const base = res.rows;
      // A limpeza acontece dentro do ciclo da enfermagem e não guarda as cirurgias;
      // buscamos a enfermagem correspondente para exibi-las.
      const limpezas = base.filter((l) => l.tipo_evento === "limpeza");
      let enfermagens: { sala_id: string; inicio: string; fim: string | null; cirurgia_anterior: string | null; cirurgia_proxima: string | null }[] = [];
      if (limpezas.length > 0) {
        const salaIds = [...new Set(limpezas.map((l) => l.sala_id))];
        const maisAntiga = limpezas.reduce((a, l) => (new Date(l.inicio) < new Date(a) ? l.inicio : a), limpezas[0]!.inicio);
        enfermagens = (
          await db.query(
            `SELECT sala_id, inicio, fim, cirurgia_anterior, cirurgia_proxima FROM eventos_giro
              WHERE tipo_evento = 'desmontagem' AND sala_id = ANY($1::uuid[]) AND inicio >= $2
              ORDER BY inicio DESC`,
            [salaIds, new Date(new Date(maisAntiga).getTime() - 24 * 3600 * 1000)],
          )
        ).rows as typeof enfermagens;
      }
      const cirurgiasDaLimpeza = (salaId: string, inicioLimpeza: string) => {
        const t = new Date(inicioLimpeza).getTime();
        const enf = enfermagens.find(
          (e) => e.sala_id === salaId && new Date(e.inicio).getTime() <= t && (!e.fim || new Date(e.fim).getTime() >= t),
        );
        return { anterior: enf?.cirurgia_anterior ?? null, proxima: enf?.cirurgia_proxima ?? null };
      };

      return {
        linhas: base.map((l) => {
          const extra = l.tipo_evento === "limpeza" ? cirurgiasDaLimpeza(l.sala_id, l.inicio) : { anterior: l.cirurgia_anterior, proxima: l.cirurgia_proxima };
          return {
            id: l.id,
            tipo_evento: l.tipo_evento,
            inicio: l.inicio,
            fim: l.fim,
            duracao_segundos: l.duracao_segundos,
            cirurgia_anterior: l.cirurgia_anterior ?? extra.anterior,
            cirurgia_proxima: l.cirurgia_proxima ?? extra.proxima,
            sala: l.sala_nome ?? "-",
            usuario_inicio: l.usuario_inicio ?? null,
            usuario_fim: l.usuario_fim ?? null,
          };
        }),
        total: total.rows[0]?.n ?? 0,
      };
    });

    /** Salas do hospital (gestão administrativa). */
    app.get("/hospital/salas", async (req) => {
      const perfil = await exigirHospitalAdmin(db, req.auth.userId);
      return (
        await db.query(
          "SELECT id, nome, ativa, status_atual, cirurgia_atual, updated_at FROM salas WHERE tenant_id = $1 ORDER BY nome",
          [perfil.tenant_id],
        )
      ).rows;
    });

    app.post("/hospital/salas/salvar", async (req) => {
      const d = z
        .object({ id: z.string().uuid().optional(), nome: z.string().min(1).max(60), ativa: z.boolean().default(true) })
        .parse(req.body);
      const perfil = await exigirHospitalAdmin(db, req.auth.userId);
      await db.tx(async (q) => {
        await salvarSala(q, {
          tenantId: perfil.tenant_id,
          ...d,
          mensagemLimite: (l) => `Limite de ${l} sala(s) contratado com a Trizion Tech já foi atingido.`,
        });
        await registrarAcao(q, perfil.id, "salvou_sala", { nome: d.nome });
      });
      return { ok: true as const };
    });

    /** Registro de acessos do próprio hospital, com paginação. */
    app.post("/hospital/acessos", async (req) => {
      const d = z.object({ busca: z.string().max(120).optional(), ...paginacao }).parse(req.body ?? {});
      const perfil = await exigirHospitalAdmin(db, req.auth.userId);
      const w = new Where().add("tenant_id = ?", perfil.tenant_id);
      await filtroPeriodo(w, "created_at", d.de, d.ate);
      if (d.busca) w.add("email_tentado ILIKE ?", `%${escaparLike(d.busca)}%`);

      const [linhas, total] = await Promise.all([
        db.query(
          `SELECT id, email_tentado, sucesso, ip, pais_regiao, created_at FROM log_acessos ${w.sql}
            ORDER BY created_at DESC LIMIT $${w.proximo} OFFSET $${w.proximo + 1}`,
          [...w.params, d.porPagina, (d.pagina - 1) * d.porPagina],
        ),
        db.query<{ n: number }>(`SELECT count(*)::int AS n FROM log_acessos ${w.sql}`, w.params),
      ]);
      return { linhas: linhas.rows, total: total.rows[0]?.n ?? 0 };
    });

    /**
     * Estatísticas de giro por período: tempo líquido da enfermagem (sem o tempo em que a limpeza
     * estava rodando), tempo da limpeza e ciclo geral (enfermagem + limpeza).
     */
    app.post("/hospital/giro/estatisticas", async (req) => {
      const d = z.object({ de: z.string().max(10).optional(), ate: z.string().max(10).optional() }).parse(req.body ?? {});
      const perfil = await exigirHospitalAdmin(db, req.auth.userId);
      const { de, ate } = await limitesDoPeriodo(db, tz, dataValida(d.de), dataValida(d.ate), { dias: 30 });

      const evs = (
        await db.query<EventoGiro>(
          `SELECT e.id, e.sala_id, e.tipo_evento, e.inicio, e.fim, e.duracao_segundos
             FROM eventos_giro e JOIN salas s ON s.id = e.sala_id
            WHERE s.tenant_id = $1 AND e.inicio >= $2 AND e.inicio < $3 AND e.fim IS NOT NULL
            ORDER BY e.inicio ASC`,
          [perfil.tenant_id, de, ate],
        )
      ).rows;
      const ciclos = montarCiclos(evs).map((c) => ({ ...c, dia: dataLocal(c.inicio, tz) }));

      const medias = (chave: "enfermagem" | "limpeza" | "geral") =>
        ciclos.length === 0 ? null : Math.round(ciclos.reduce((a, c) => a + c[chave], 0) / ciclos.length);

      const porDiaMap = new Map<string, { enfermagem: number; limpeza: number; geral: number; n: number }>();
      for (const c of ciclos) {
        const atual = porDiaMap.get(c.dia) ?? { enfermagem: 0, limpeza: 0, geral: 0, n: 0 };
        atual.enfermagem += c.enfermagem;
        atual.limpeza += c.limpeza;
        atual.geral += c.geral;
        atual.n += 1;
        porDiaMap.set(c.dia, atual);
      }
      const porDia = [...porDiaMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([dia, v]) => ({
          dia,
          enfermagem: Math.round(v.enfermagem / v.n / 60),
          limpeza: Math.round(v.limpeza / v.n / 60),
          geral: Math.round(v.geral / v.n / 60),
        }));

      const paradas = (
        await db.query<{ duracao_segundos: number | null; inicio: string; fim: string | null }>(
          `SELECT p.duracao_segundos, p.inicio, p.fim
             FROM eventos_sala_parada p JOIN salas s ON s.id = p.sala_id
            WHERE s.tenant_id = $1 AND p.inicio >= $2 AND p.inicio < $3 AND p.fim IS NOT NULL`,
          [perfil.tenant_id, de, ate],
        )
      ).rows;
      const paradaSegundos = paradas.map((p) => p.duracao_segundos ?? (p.fim ? segundosEntre(p.inicio, p.fim) : 0));
      const mediaParada =
        paradaSegundos.length === 0 ? null : Math.round(paradaSegundos.reduce((a, b) => a + b, 0) / paradaSegundos.length);

      return {
        periodo: { de: dataLocal(de, tz), ate: dataLocal(new Date(ate.getTime() - 1), tz) },
        ciclos: ciclos.length,
        mediaEnfermagem: medias("enfermagem"),
        mediaLimpeza: medias("limpeza"),
        mediaGeral: medias("geral"),
        mediaParada,
        paradas: paradaSegundos.length,
        porDia,
        porCiclo: ciclos.map((c, i) => ({
          rotulo: new Date(c.inicio).toLocaleString("pt-BR", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            timeZone: tz,
          }),
          indice: i + 1,
          enfermagem: Math.round((c.enfermagem / 60) * 10) / 10,
          limpeza: Math.round((c.limpeza / 60) * 10) / 10,
          geral: Math.round((c.geral / 60) * 10) / 10,
        })),
      };
    });

    /**
     * Resumo do período por sala (o "resumão do mês"): para cada sala, quantidade, tempo total e média de
     * enfermagem (líquida, sem a limpeza), de limpeza, giro total por ciclo e paradas, mais a linha de total.
     * Regra: entram só eventos FINALIZADOS que começaram dentro do período; o que está em andamento
     * aparece em `paradaDesde`/`emAndamento` (situação de agora), sem somar nos totais.
     * `indicadores` conta os registros de giro do período (concluídos, em andamento e os < 30 s, a revisar)
     * e `porDia` traz o volume de registros por data local do hospital.
     */
    app.post("/hospital/giro/por-sala", async (req) => {
      const d = z
        .object({ salaId: z.string().max(40).optional(), de: z.string().max(10).optional(), ate: z.string().max(10).optional() })
        .parse(req.body ?? {});
      const perfil = await exigirHospitalAdmin(db, req.auth.userId);
      const t = perfil.tenant_id;
      const { de, ate } = await limitesDoPeriodo(db, tz, dataValida(d.de), dataValida(d.ate), { dias: 30 });
      const filtrarSala = !!d.salaId && d.salaId !== "todas";
      const salaId = filtrarSala && ehUuid(d.salaId) ? d.salaId : null;
      const periodo = { de: dataLocal(de, tz), ate: dataLocal(new Date(ate.getTime() - 1), tz) };

      const [salas, registros, paradas, abertos] = await Promise.all([
        db.query<{ id: string; nome: string; ativa: boolean; status_atual: string }>(
          "SELECT id, nome, ativa, status_atual FROM salas WHERE tenant_id = $1 ORDER BY nome",
          [t],
        ),
        db.query<EventoGiro>(
          `SELECT e.id, e.sala_id, e.tipo_evento, e.inicio, e.fim, e.duracao_segundos
             FROM eventos_giro e JOIN salas s ON s.id = e.sala_id
            WHERE s.tenant_id = $1 AND e.inicio >= $2 AND e.inicio < $3
            ORDER BY e.inicio ASC`,
          [t, de, ate],
        ),
        db.query<{ sala_id: string; inicio: string; fim: string; duracao_segundos: number | null }>(
          `SELECT p.sala_id, p.inicio, p.fim, p.duracao_segundos
             FROM eventos_sala_parada p JOIN salas s ON s.id = p.sala_id
            WHERE s.tenant_id = $1 AND p.inicio >= $2 AND p.inicio < $3 AND p.fim IS NOT NULL`,
          [t, de, ate],
        ),
        db.query<{ sala_id: string; inicio: string; tipo: string }>(
          `SELECT p.sala_id, p.inicio, 'parada' AS tipo FROM eventos_sala_parada p JOIN salas s ON s.id = p.sala_id
            WHERE s.tenant_id = $1 AND p.fim IS NULL
           UNION ALL
           SELECT e.sala_id, e.inicio, e.tipo_evento::text AS tipo FROM eventos_giro e JOIN salas s ON s.id = e.sala_id
            WHERE s.tenant_id = $1 AND e.fim IS NULL`,
          [t],
        ),
      ]);

      const evs = { rows: registros.rows.filter((e) => e.fim != null) }; // só finalizados entram nas somas
      const ciclos = montarCiclos(evs.rows);
      const limpezas = evs.rows.filter((e) => e.tipo_evento === "limpeza");
      const durLimpeza = (e: EventoGiro) => e.duracao_segundos ?? (e.fim ? segundosEntre(e.inicio, e.fim) : 0);
      const durEvento = (e: EventoGiro) => e.duracao_segundos ?? (e.fim ? segundosEntre(e.inicio, e.fim) : 0);
      const durParada = (p: (typeof paradas.rows)[number]) => p.duracao_segundos ?? segundosEntre(p.inicio, p.fim);

      const bloco = (valores: number[]) => {
        const total = valores.reduce((a, b) => a + b, 0);
        return { quantidade: valores.length, total, media: mediaDe(valores) };
      };
      const agregar = (filtro: (salaId: string) => boolean) => {
        const cs = ciclos.filter((c) => filtro(c.salaId));
        return {
          enfermagem: bloco(cs.map((c) => c.enfermagem)),
          limpeza: bloco(limpezas.filter((l) => filtro(l.sala_id)).map(durLimpeza)),
          giroTotal: bloco(cs.map((c) => c.geral)),
          paradas: bloco(paradas.rows.filter((p) => filtro(p.sala_id)).map(durParada)),
          aRevisar: evs.rows.filter((e) => filtro(e.sala_id) && durEvento(e) < LIMITE_REVISAO_SEG).length,
        };
      };

      const comMovimento = new Set([...registros.rows.map((e) => e.sala_id), ...paradas.rows.map((p) => p.sala_id)]);
      const lista = salas.rows
        .filter((s) => (filtrarSala ? s.id === salaId : s.ativa || comMovimento.has(s.id)))
        .map((s) => {
          const parada = abertos.rows.find((a) => a.sala_id === s.id && a.tipo === "parada");
          const andamento = abertos.rows.find((a) => a.sala_id === s.id && a.tipo !== "parada");
          return {
            id: s.id,
            nome: s.nome,
            ativa: s.ativa,
            statusAtual: s.status_atual,
            paradaDesde: parada?.inicio ?? null,
            emAndamento: andamento ? { tipo: andamento.tipo, desde: andamento.inicio } : null,
            ...agregar((id) => id === s.id),
          };
        })
        .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR", { numeric: true }));

      const ids = new Set(lista.map((s) => s.id));
      const doFiltro = registros.rows.filter((e) => ids.has(e.sala_id));
      const finalizados = doFiltro.filter((e) => e.fim != null);

      // Por dia (data local do hospital): volume de registros (inclui em andamento) e, dos concluídos,
      // quantidade e duração média de cada etapa (enfermagem líquida, como na tabela por sala).
      type Dia = { enfermagem: number; limpeza: number; total: number; enf: number[]; lim: number[] };
      const porDiaMap = new Map<string, Dia>();
      const doDia = (dia: string) => {
        const v = porDiaMap.get(dia) ?? { enfermagem: 0, limpeza: 0, total: 0, enf: [], lim: [] };
        porDiaMap.set(dia, v);
        return v;
      };
      for (const e of doFiltro) {
        const v = doDia(dataLocal(e.inicio, tz));
        if (e.tipo_evento === "desmontagem") v.enfermagem += 1;
        else if (e.tipo_evento === "limpeza") v.limpeza += 1;
        v.total += 1;
      }
      for (const c of ciclos.filter((c) => ids.has(c.salaId))) doDia(dataLocal(c.inicio, tz)).enf.push(c.enfermagem);
      for (const l of limpezas.filter((l) => ids.has(l.sala_id))) doDia(dataLocal(l.inicio, tz)).lim.push(durEvento(l));
      const porDia = [...porDiaMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([dia, v]) => ({
          dia,
          enfermagem: v.enfermagem,
          limpeza: v.limpeza,
          total: v.total,
          enfermagemConcluidos: v.enf.length,
          mediaEnfermagem: mediaDe(v.enf),
          limpezaConcluidos: v.lim.length,
          mediaLimpeza: mediaDe(v.lim),
        }));

      return {
        periodo,
        indicadores: {
          registros: doFiltro.length,
          concluidos: finalizados.length,
          emAndamento: doFiltro.length - finalizados.length,
          aRevisar: finalizados.filter((e) => durEvento(e) < LIMITE_REVISAO_SEG).length,
          salasMonitoradas: lista.length,
          limiteRevisaoSegundos: LIMITE_REVISAO_SEG,
        },
        salas: lista,
        total: agregar((id) => ids.has(id)),
        porDia,
      };
    });

    /** Paradas de sala: lista detalhada com filtro por dia/sala e paginação. */
    app.post("/hospital/paradas", async (req) => {
      const d = z.object({ salaId: z.string().max(40).optional(), ...paginacao }).parse(req.body ?? {});
      const perfil = await exigirHospitalAdmin(db, req.auth.userId);

      const w = new Where().add("s.tenant_id = ?", perfil.tenant_id);
      if (d.salaId && d.salaId !== "todas") {
        if (!ehUuid(d.salaId)) return { linhas: [], total: 0 };
        w.add("p.sala_id = ?", d.salaId);
      }
      await filtroPeriodo(w, "p.inicio", d.de, d.ate);

      const [res, total] = await Promise.all([
        db.query<{ id: string; sala_nome: string; inicio: string; fim: string | null; duracao_segundos: number | null }>(
          `SELECT p.id, s.nome AS sala_nome, p.inicio, p.fim, p.duracao_segundos
             FROM eventos_sala_parada p JOIN salas s ON s.id = p.sala_id ${w.sql}
            ORDER BY p.inicio DESC LIMIT $${w.proximo} OFFSET $${w.proximo + 1}`,
          [...w.params, d.porPagina, (d.pagina - 1) * d.porPagina],
        ),
        db.query<{ n: number }>(`SELECT count(*)::int AS n FROM eventos_sala_parada p JOIN salas s ON s.id = p.sala_id ${w.sql}`, w.params),
      ]);
      return {
        linhas: res.rows.map((l) => ({
          id: l.id,
          sala: l.sala_nome ?? "-",
          inicio: l.inicio,
          fim: l.fim,
          duracao_segundos: l.duracao_segundos ?? (l.fim ? segundosEntre(l.inicio, l.fim) : null),
        })),
        total: total.rows[0]?.n ?? 0,
      };
    });

    /** Tempo de sala parada por sala: total no período e médias nas janelas de 7/15/30/45 dias. */
    app.post("/hospital/paradas/estatisticas", async (req) => {
      const d = z
        .object({ salaId: z.string().max(40).optional(), de: z.string().max(10).optional(), ate: z.string().max(10).optional() })
        .parse(req.body ?? {});
      const perfil = await exigirHospitalAdmin(db, req.auth.userId);

      const agora = Date.now();
      const desde = new Date(agora - 45 * 24 * 3600 * 1000);
      const w = new Where().add("s.tenant_id = ?", perfil.tenant_id).add("p.inicio >= ?", desde);
      if (d.salaId && d.salaId !== "todas") {
        if (!ehUuid(d.salaId)) w.add("false");
        else w.add("p.sala_id = ?", d.salaId);
      }
      const evs = (
        await db.query<{ sala_id: string; inicio: string; fim: string | null; duracao_segundos: number | null; sala_nome: string }>(
          `SELECT p.sala_id, p.inicio, p.fim, p.duracao_segundos, s.nome AS sala_nome
             FROM eventos_sala_parada p JOIN salas s ON s.id = p.sala_id ${w.sql}`,
          w.params,
        )
      ).rows;
      const dur = (e: (typeof evs)[number]) => e.duracao_segundos ?? (e.fim ? segundosEntre(e.inicio, e.fim) : 0);

      const janelas = [7, 15, 30, 45] as const;
      const porSala = new Map<string, { sala: string; total: number; ocorrencias: number; medias: Record<number, number | null> }>();
      for (const e of evs) {
        if (!porSala.has(e.sala_id)) porSala.set(e.sala_id, { sala: e.sala_nome ?? "-", total: 0, ocorrencias: 0, medias: {} });
      }

      const limites = await limitesDoPeriodo(db, tz, dataValida(d.de), dataValida(d.ate), { dias: 45 });
      const deTs = limites.de.getTime();
      const ateTs = d.ate ? limites.ate.getTime() : agora;

      for (const [salaId, info] of porSala) {
        const doSala = evs.filter((e) => e.sala_id === salaId);
        const noPeriodo = doSala.filter((e) => {
          const t = new Date(e.inicio).getTime();
          return t >= deTs && t <= ateTs;
        });
        info.total = noPeriodo.reduce((a, e) => a + dur(e), 0);
        info.ocorrencias = noPeriodo.length;
        for (const dias of janelas) {
          const corte = agora - dias * 24 * 3600 * 1000;
          const janela = doSala.filter((e) => new Date(e.inicio).getTime() >= corte);
          info.medias[dias] = janela.length === 0 ? null : Math.round(janela.reduce((a, e) => a + dur(e), 0) / janela.length);
        }
      }

      const salas = [...porSala.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => a.sala.localeCompare(b.sala));
      return {
        janelas: [...janelas] as number[],
        periodo: { de: dataLocal(new Date(deTs), tz), ate: dataLocal(new Date(ateTs), tz) },
        salas,
        totalPeriodo: salas.reduce((a, s) => a + s.total, 0),
        ocorrenciasPeriodo: salas.reduce((a, s) => a + s.ocorrencias, 0),
      };
    });
  };
