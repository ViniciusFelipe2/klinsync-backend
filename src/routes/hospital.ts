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
  de: z.string().optional(),
  ate: z.string().optional(),
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
      const d = z.object({ busca: z.string().optional(), ...paginacao }).parse(req.body ?? {});
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
          salaId: z.string().optional(),
          etapa: z.enum(["todas", "desmontagem", "limpeza", "remontagem"]).default("todas"),
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
        }>(
          `SELECT e.id, e.tipo_evento, e.inicio, e.fim, e.duracao_segundos, e.cirurgia_anterior, e.cirurgia_proxima,
                  e.sala_id, s.nome AS sala_nome
             FROM eventos_giro e JOIN salas s ON s.id = e.sala_id ${w.sql}
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
      const d = z.object({ busca: z.string().optional(), ...paginacao }).parse(req.body ?? {});
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
      const d = z.object({ de: z.string().optional(), ate: z.string().optional() }).parse(req.body ?? {});
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
      const enfermagens = evs.filter((e) => e.tipo_evento === "desmontagem");
      const limpezas = evs.filter((e) => e.tipo_evento === "limpeza");

      const ciclos = enfermagens.map((enf) => {
        const ini = new Date(enf.inicio).getTime();
        const fim = enf.fim ? new Date(enf.fim).getTime() : ini;
        const limpezaSeg = limpezas
          .filter((l) => {
            const li = new Date(l.inicio).getTime();
            return l.sala_id === enf.sala_id && li >= ini && li <= fim;
          })
          .reduce((a, l) => a + (l.duracao_segundos ?? 0), 0);
        const geral = enf.duracao_segundos ?? Math.round((fim - ini) / 1000);
        return {
          dia: dataLocal(enf.inicio, tz),
          inicio: enf.inicio,
          enfermagem: Math.max(0, geral - limpezaSeg),
          limpeza: limpezaSeg,
          geral,
        };
      });

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

    /** Paradas de sala: lista detalhada com filtro por dia/sala e paginação. */
    app.post("/hospital/paradas", async (req) => {
      const d = z.object({ salaId: z.string().optional(), ...paginacao }).parse(req.body ?? {});
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
        .object({ salaId: z.string().optional(), de: z.string().optional(), ate: z.string().optional() })
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
