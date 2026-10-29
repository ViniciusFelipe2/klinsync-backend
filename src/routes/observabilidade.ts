import os from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { limitarTentativas } from "../lib/limites.js";
import { LIMITE_LENTA_MS } from "../lib/metricas-api.js";
import { exigirMaster } from "../lib/perfil.js";
import { avaliarSaude, saudeGeral, type Alerta, type ResumoApp, type ResumoBanco } from "../lib/saude.js";
import { MonitorIndisponivel, classificarErroAws, type Custos, type Infra } from "../services/monitor.js";

type Fonte = { ok: true } | { ok: false; motivo: string; mensagem: string; acao?: string | undefined };

const TTL_INFRA_MS = 30_000;
const TTL_ERRO_MS = 20_000;
const TTL_CUSTOS_MS = 3 * 3600_000; // o Cost Explorer só atualiza algumas vezes ao dia e cobra por consulta
const INTERVALO_MIN_ATUALIZAR_MS = 10 * 60_000;

const periodoSchema = z.object({ horas: z.union([z.literal(1), z.literal(6), z.literal(24), z.literal(72)]).default(1) });

/** Cache com deduplicação de chamadas simultâneas; falhas ficam em cache por pouco tempo para não martelar a AWS. */
function cacheado<T>(ttlMs: number) {
  const itens = new Map<string, { em: number; valor?: T; erro?: unknown; pendente?: Promise<T> }>();
  return async (chave: string, buscar: () => Promise<T>, forcar = false): Promise<T> => {
    const atual = itens.get(chave);
    if (atual?.pendente) return atual.pendente;
    if (atual && !forcar) {
      const idade = Date.now() - atual.em;
      if (atual.erro !== undefined && idade < TTL_ERRO_MS) throw atual.erro;
      if (atual.valor !== undefined && idade < ttlMs) return atual.valor;
    }
    const pendente = buscar().then(
      (valor) => {
        itens.set(chave, { em: Date.now(), valor });
        return valor;
      },
      (erro: unknown) => {
        itens.set(chave, { em: Date.now(), erro });
        throw erro;
      },
    );
    itens.set(chave, { ...(atual ?? { em: 0 }), pendente });
    return pendente;
  };
}

const PASSO_SERIE: Record<number, number> = { 1: 60, 6: 300, 24: 900, 72: 3600 };

export const observabilidadeRoutes =
  ({ db, config, monitor }: Deps): FastifyPluginAsync =>
  async (app) => {
    const infraCache = cacheado<Infra>(TTL_INFRA_MS);
    const custosCache = cacheado<Custos>(TTL_CUSTOS_MS);
    let custosAtualizadoEm = 0;

    const atrasoLoop = monitorEventLoopDelay({ resolution: 20 });
    atrasoLoop.enable();
    app.addHook("onClose", async () => {
      atrasoLoop.disable();
    });

    const guard = async (userId: string) => {
      await exigirMaster(db, userId);
      await limitarTentativas(db, `observabilidade:${userId}`, 240, 60_000, "Muitas atualizações seguidas. Aguarde um instante.");
    };

    async function tentar<T>(fn: () => Promise<T>, acao: string): Promise<{ dados: T | null; fonte: Fonte }> {
      try {
        return { dados: await fn(), fonte: { ok: true } };
      } catch (err) {
        const e = err instanceof MonitorIndisponivel ? err : classificarErroAws(err, acao);
        return { dados: null, fonte: { ok: false, motivo: e.motivo, mensagem: e.message, acao: e.acao } };
      }
    }

    const infra = (horas: number, forcar = false) => tentar(() => infraCache(`h${horas}`, () => monitor.infra(horas), forcar), "ec2/cloudwatch");
    const custos = (forcar = false) =>
      tentar(
        () =>
          custosCache(
            "c",
            async () => {
              const c = await monitor.custos();
              custosAtualizadoEm = Date.now();
              return c;
            },
            forcar,
          ),
        "ce:GetCostAndUsage",
      );

    /* ------------------------------------------- Aplicação e banco ------------------------------------------- */

    async function resumoApp(minutos: number): Promise<ResumoApp> {
      const r = await db.query<{ req: number; e4: number; e5: number; lentas: number; soma: number }>(
        `SELECT coalesce(sum(requisicoes),0)::int AS req, coalesce(sum(erros_4xx),0)::int AS e4, coalesce(sum(erros_5xx),0)::int AS e5,
                coalesce(sum(lentas),0)::int AS lentas, coalesce(sum(soma_ms),0)::float8 AS soma
           FROM metricas_api WHERE minuto >= now() - make_interval(mins => $1::int)`,
        [minutos],
      );
      const x = r.rows[0]!;
      return { requisicoes: x.req, erros4xx: x.e4, erros5xx: x.e5, lentas: x.lentas, latenciaMediaMs: x.req ? x.soma / x.req : 0 };
    }

    async function bancoStats() {
      try {
        const t0 = Date.now();
        await db.query("SELECT 1");
        const latenciaMs = Date.now() - t0;
        const r = await db.query<{ conexoes: number; max: number; tamanho: number; ativas: number; maisLonga: number; versao: string }>(
          `SELECT (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS conexoes,
                  current_setting('max_connections')::int AS max,
                  pg_database_size(current_database())::float8 AS tamanho,
                  (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND pid <> pg_backend_pid()) AS ativas,
                  (SELECT coalesce(max(extract(epoch FROM now() - query_start)), 0)::int FROM pg_stat_activity
                    WHERE datname = current_database() AND state = 'active' AND pid <> pg_backend_pid()) AS "maisLonga",
                  current_setting('server_version') AS versao`,
        );
        const x = r.rows[0]!;
        return { disponivel: true as const, latenciaMs, conexoes: x.conexoes, maxConexoes: x.max, tamanhoBytes: x.tamanho, consultasAtivas: x.ativas, consultaMaisLongaSeg: x.maisLonga, versao: x.versao };
      } catch {
        return { disponivel: false as const };
      }
    }

    function processoStats() {
      const mem = process.memoryUsage();
      return {
        pid: process.pid,
        node: process.version,
        ambiente: config.NODE_ENV,
        uptimeSeg: Math.round(process.uptime()),
        rssMb: Math.round(mem.rss / 1048576),
        heapUsadoMb: Math.round(mem.heapUsed / 1048576),
        atrasoLoopMs: Math.round((atrasoLoop.mean / 1e6) * 10) / 10,
        atrasoLoopP99Ms: Math.round((atrasoLoop.percentile(99) / 1e6) * 10) / 10,
        host: {
          cpus: os.cpus().length,
          cargaMedia1m: Math.round(os.loadavg()[0]! * 100) / 100,
          memoriaTotalMb: Math.round(os.totalmem() / 1048576),
          memoriaLivreMb: Math.round(os.freemem() / 1048576),
        },
      };
    }

    app.post("/master/observabilidade/aplicacao", async (req) => {
      const { horas } = periodoSchema.parse(req.body ?? {});
      await guard(req.auth.userId);
      const passo = PASSO_SERIE[horas]!;
      const [serie, rotas, recente, banco] = await Promise.all([
        db.query(
          `SELECT to_timestamp(floor(extract(epoch FROM minuto) / $2) * $2) AS t,
                  sum(requisicoes)::int AS req, sum(erros_4xx)::int AS e4, sum(erros_5xx)::int AS e5, sum(lentas)::int AS lentas,
                  (sum(soma_ms)::float8 / greatest(sum(requisicoes), 1)) AS media_ms, max(max_ms)::int AS max_ms
             FROM metricas_api WHERE minuto >= now() - make_interval(hours => $1::int) GROUP BY 1 ORDER BY 1`,
          [horas, passo],
        ),
        db.query(
          `SELECT metodo, rota, sum(requisicoes)::int AS req, sum(erros_4xx)::int AS e4, sum(erros_5xx)::int AS e5, sum(lentas)::int AS lentas,
                  (sum(soma_ms)::float8 / greatest(sum(requisicoes), 1)) AS media_ms, max(max_ms)::int AS max_ms
             FROM metricas_api WHERE minuto >= now() - make_interval(hours => $1::int)
            GROUP BY metodo, rota ORDER BY sum(erros_5xx) DESC, sum(soma_ms) DESC LIMIT 25`,
          [horas],
        ),
        resumoApp(15),
        bancoStats(),
      ]);
      return {
        horas,
        limiteLentaMs: LIMITE_LENTA_MS,
        serie: serie.rows.map((r) => ({
          t: new Date(r["t"]).getTime(),
          requisicoes: r["req"],
          erros4xx: r["e4"],
          erros5xx: r["e5"],
          lentas: r["lentas"],
          latenciaMediaMs: Math.round(r["media_ms"]),
          latenciaMaxMs: r["max_ms"],
        })),
        rotas: rotas.rows.map((r) => ({
          metodo: r["metodo"],
          rota: r["rota"],
          requisicoes: r["req"],
          erros4xx: r["e4"],
          erros5xx: r["e5"],
          lentas: r["lentas"],
          latenciaMediaMs: Math.round(r["media_ms"]),
          latenciaMaxMs: r["max_ms"],
        })),
        recente,
        banco,
        processo: processoStats(),
      };
    });

    /* ------------------------------------------------ Servidores ------------------------------------------------ */

    app.post("/master/observabilidade/servidores", async (req) => {
      const { horas } = periodoSchema.parse(req.body ?? {});
      await guard(req.auth.userId);
      const r = await infra(horas);
      return { modo: monitor.modo, horas, fonte: r.fonte, ...(r.dados ?? { instancias: [], series: {}, alarmes: [], periodoSegundos: 0 }), geradoEm: new Date().toISOString() };
    });

    /* -------------------------------------------------- Custos -------------------------------------------------- */

    app.post("/master/observabilidade/custos", async (req) => {
      const { atualizar } = z.object({ atualizar: z.boolean().default(false) }).parse(req.body ?? {});
      await guard(req.auth.userId);
      const pode = atualizar && Date.now() - custosAtualizadoEm >= INTERVALO_MIN_ATUALIZAR_MS;
      const r = await custos(pode);
      return {
        modo: monitor.modo,
        fonte: r.fonte,
        orcamento: config.ORCAMENTO_MENSAL_USD ?? null,
        proximaAtualizacaoManualEm: custosAtualizadoEm ? new Date(custosAtualizadoEm + INTERVALO_MIN_ATUALIZAR_MS).toISOString() : null,
        custos: r.dados,
      };
    });

    /* ------------------------------------------- Visão geral e alertas ------------------------------------------- */

    app.get("/master/observabilidade/resumo", async (req) => {
      await guard(req.auth.userId);
      const [inf, cus, apl, banco] = await Promise.all([infra(24), custos(), resumoApp(15), bancoStats()]);
      const resumoBanco: ResumoBanco = banco.disponivel ? { conexoes: banco.conexoes, maxConexoes: banco.maxConexoes } : null;

      const alertas: Alerta[] = avaliarSaude({
        agora: Date.now(),
        infra: inf.dados,
        app: apl,
        banco: resumoBanco,
        custos: cus.dados,
        orcamento: config.ORCAMENTO_MENSAL_USD,
      });
      if (!inf.fonte.ok) {
        alertas.unshift({
          id: "obs-aws-indisponivel",
          severidade: "aviso",
          categoria: "observabilidade",
          titulo: "Monitoramento dos servidores indisponível",
          detalhe: inf.fonte.mensagem,
          recomendacao: inf.fonte.acao ?? "Verifique as permissões da role da EC2 e a região configurada.",
        });
      }
      if (!cus.fonte.ok) {
        alertas.push({
          id: "obs-custos-indisponivel",
          severidade: "info",
          categoria: "observabilidade",
          titulo: "Dados de custo indisponíveis",
          detalhe: cus.fonte.mensagem,
          recomendacao: cus.fonte.acao ?? "Habilite o Cost Explorer na conta e conceda ce:GetCostAndUsage.",
        });
      }
      if (!banco.disponivel) {
        alertas.unshift({
          id: "banco-indisponivel",
          severidade: "critico",
          categoria: "banco",
          titulo: "Banco de dados não respondeu à verificação",
          detalhe: "A consulta de teste ao Postgres falhou.",
          recomendacao: "Confira a EC2 do banco (aba Servidores), o serviço postgresql e o security group da porta 5432.",
        });
      }

      const instancias = inf.dados?.instancias ?? [];
      const problemasPorRecurso = new Set(alertas.filter((a) => a.categoria === "servidor" && a.severidade !== "info" && a.recurso).map((a) => a.recurso));
      return {
        geradoEm: new Date().toISOString(),
        modo: monitor.modo,
        saude: saudeGeral(alertas),
        alertas,
        kpis: {
          servidores: { total: instancias.length, emExecucao: instancias.filter((i) => i.estado === "running").length, comProblema: problemasPorRecurso.size },
          api: {
            requisicoes15m: apl.requisicoes,
            taxaErros5xx: apl.requisicoes ? Math.round((apl.erros5xx / apl.requisicoes) * 10000) / 100 : 0,
            latenciaMediaMs: Math.round(apl.latenciaMediaMs),
          },
          banco: banco.disponivel ? { latenciaMs: banco.latenciaMs, conexoes: banco.conexoes, maxConexoes: banco.maxConexoes } : null,
          custos: cus.dados
            ? { mesAtual: cus.dados.mesAtual.total, previsaoFimMes: cus.dados.previsaoFimMes, hoje: cus.dados.hoje, orcamento: config.ORCAMENTO_MENSAL_USD ?? null }
            : null,
        },
        fontes: { servidores: inf.fonte, custos: cus.fonte },
      };
    });
  };
