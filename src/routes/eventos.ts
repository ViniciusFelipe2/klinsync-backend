import type { OutgoingHttpHeaders } from "node:http";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { Deps } from "../deps.js";
import { HttpError } from "../errors.js";
import type { TipoEvento } from "../lib/eventos.js";
import { escopoTenant, perfilDe } from "../lib/perfil.js";

const MAX_CONEXOES_POR_USUARIO = 30;
const BATIMENTO_MS = 20_000;
/** A conexão é encerrada de tempos em tempos para o cliente se autenticar de novo (perfil desativado perde o acesso). */
const VIDA_MAXIMA_MS = 10 * 60_000;

/** Quais mutações bem-sucedidas geram aviso em tempo real. */
function tipoDaMutacao(url: string): TipoEvento | null {
  const rota = url.split("?")[0]!;
  if (rota.startsWith("/giro/etapas/") || rota.startsWith("/giro/paradas/")) return "giro";
  if (rota === "/giro/reservas/reservar" || rota === "/giro/reservas/liberar") return "reserva";
  if (rota === "/checkins" || rota === "/checkins/excluir") return "checkin";
  if (rota === "/hospital/salas/salvar" || rota === "/master/salas/salvar" || rota === "/master/salas/excluir") return "salas";
  return null;
}

/**
 * Registra, no escopo protegido (antes das demais rotas), o aviso em tempo real depois de qualquer alteração
 * bem-sucedida. Fica fora do plugin de propósito: hooks do Fastify só valem para o escopo onde são adicionados.
 */
export function avisarMutacoes(app: FastifyInstance, { db, eventos }: Deps): void {
  app.addHook("onResponse", async (req, reply) => {
    if (req.method !== "POST" || reply.statusCode >= 300 || !req.auth) return;
    const tipo = tipoDaMutacao(req.url);
    if (!tipo) return;
    const perfil = await perfilDe(db, req.auth.userId).catch(() => null);
    // Sem hospital (master agindo em nome de um): vale para todos; quem não tem nada a atualizar só busca de novo.
    eventos.publicar({ tipo, tenantId: perfil?.tenant_id ?? null });
  });
}

export const eventosRoutes =
  ({ db, eventos }: Deps): FastifyPluginAsync =>
  async (app) => {
    const abertas = new Map<string, number>();

    app.get("/eventos/stream", async (req, reply) => {
      const { tenantId } = await escopoTenant(db, req.auth.userId);
      const n = abertas.get(req.auth.userId) ?? 0;
      if (n >= MAX_CONEXOES_POR_USUARIO) throw new HttpError(429, "Muitas conexões em tempo real abertas para este usuário.");
      abertas.set(req.auth.userId, n + 1);

      reply.hijack();
      const raw = reply.raw;
      // CORS e cabeçalhos de segurança já definidos pelos plugins seguem junto com os do fluxo.
      reply
        .header("Content-Type", "text/event-stream; charset=utf-8")
        .header("Cache-Control", "no-cache, no-transform")
        .header("Connection", "keep-alive")
        .header("X-Accel-Buffering", "no"); // o Nginx não pode acumular a resposta
      raw.writeHead(200, reply.getHeaders() as OutgoingHttpHeaders);
      raw.write("retry: 3000\n\nevent: pronto\ndata: {}\n\n");

      const cancelar = eventos.assinar((e) => {
        if (tenantId === null || e.tenantId === null || e.tenantId === tenantId) raw.write(`event: ${e.tipo}\ndata: {}\n\n`);
      });
      const batimento = setInterval(() => raw.write(": ping\n\n"), BATIMENTO_MS);
      const fim = setTimeout(() => raw.end(), VIDA_MAXIMA_MS);

      let limpo = false;
      const limpar = () => {
        if (limpo) return;
        limpo = true;
        clearInterval(batimento);
        clearTimeout(fim);
        cancelar();
        const restante = (abertas.get(req.auth.userId) ?? 1) - 1;
        if (restante <= 0) abertas.delete(req.auth.userId);
        else abertas.set(req.auth.userId, restante);
      };
      raw.on("close", limpar);
      raw.on("error", limpar);
      req.raw.on("close", limpar);
    });
  };
