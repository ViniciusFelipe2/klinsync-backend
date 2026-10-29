import { readFileSync } from "node:fs";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { ZodError, z } from "zod";
import { origensCors } from "./config.js";
import type { Deps } from "./deps.js";
import { HttpError, MSG_GENERICA, unauthorized } from "./errors.js";
import { verificarAccessToken } from "./lib/tokens.js";
import { authRoutes, authProtegidas } from "./routes/auth.js";
import { auditoriaRoutes } from "./routes/auditoria.js";
import { checkinsRoutes } from "./routes/checkins.js";
import { conviteRoutesProtegidas, conviteRoutesPublicas } from "./routes/convites.js";
import { avisarMutacoes, eventosRoutes } from "./routes/eventos.js";
import { giroRoutes } from "./routes/giro.js";
import { hospitalRoutes } from "./routes/hospital.js";
import { observabilidadeRoutes } from "./routes/observabilidade.js";
import { masterRoutes } from "./routes/master.js";
import { segurancaRoutes } from "./routes/seguranca.js";
import { sessaoRoutes } from "./routes/sessao.js";

// Mensagem genérica em português para qualquer validação sem mensagem própria.
z.setErrorMap(() => ({ message: "Dados inválidos. Verifique os campos informados." }));

function versaoDoApp(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const { config, db } = deps;

  const app = Fastify({
    logger: config.NODE_ENV === "test" ? false : { level: config.LOG_LEVEL },
    trustProxy: config.TRUST_PROXY === "false" ? false : config.TRUST_PROXY,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(helmet, { crossOriginResourcePolicy: { policy: "cross-origin" } });
  await app.register(cors, {
    origin: origensCors(config),
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
    maxAge: 600,
  });

  // Respostas da API têm dados pessoais e tokens: nada de cache em navegador, proxy ou CDN.
  app.addHook("onSend", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
  });

  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ message: err.message, ...err.extra });
    }
    if (err instanceof ZodError) {
      return reply.code(422).send({ message: err.issues[0]?.message ?? "Dados inválidos." });
    }
    // Violação de unicidade no Postgres (ex.: duas criações simultâneas do mesmo e-mail).
    if ((err as { code?: string }).code === "23505") {
      return reply.code(409).send({ message: "Já existe um registro com estes dados." });
    }
    // Chave estrangeira inexistente (ex.: id de hospital que não existe): erro do cliente, não 500.
    if ((err as { code?: string }).code === "23503") {
      return reply.code(422).send({ message: "Registro relacionado não encontrado." });
    }
    const status = (err as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) {
      const msg =
        status === 413 ? "Requisição grande demais." : status === 429 ? "Muitas requisições. Aguarde um instante." : "Requisição inválida.";
      return reply.code(status).send({ message: msg });
    }
    // O detalhe técnico fica só no log; o cliente recebe uma mensagem genérica e o id da requisição para o suporte correlacionar.
    req.log.error({ err, requestId: req.id }, "erro não tratado");
    return reply.code(500).send({ message: MSG_GENERICA, requestId: req.id });
  });

  // Métricas da aba de observabilidade: volume, erros e latência por rota (sem dados do usuário).
  app.addHook("onClose", async () => {
    await deps.eventos.encerrar();
  });

  if (deps.metricas) {
    const metricas = deps.metricas;
    app.addHook("onResponse", async (req, reply) => {
      const rota = req.routeOptions?.url;
      if (!rota || rota === "/health") return;
      metricas.registrar(req.method, rota, reply.statusCode, reply.elapsedTime);
    });
    app.addHook("onClose", async () => {
      await metricas.parar();
    });
  }

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ message: "Rota não encontrada." }));

  const versao = versaoDoApp();
  app.get("/health", async (_req, reply) => {
    try {
      await db.query("SELECT 1");
      return { status: "ok", version: versao };
    } catch {
      return reply.code(503).send({ status: "erro" });
    }
  });

  // Rotas públicas (sem Bearer token)
  await app.register(authRoutes(deps));
  await app.register(conviteRoutesPublicas(deps));

  // Rotas protegidas: exigem access token válido
  await app.register(async (protegido) => {
    protegido.decorateRequest("auth", undefined as never);
    protegido.addHook("onRequest", async (req) => {
      const h = req.headers.authorization;
      if (!h || !h.startsWith("Bearer ")) throw unauthorized();
      try {
        const claims = await verificarAccessToken(config.JWT_ACCESS_SECRET, h.slice(7));
        req.auth = { userId: claims.sub, email: claims.email };
      } catch {
        throw unauthorized();
      }
    });

    avisarMutacoes(protegido, deps);

    await protegido.register(authProtegidas(deps));
    await protegido.register(sessaoRoutes(deps));
    await protegido.register(masterRoutes(deps));
    await protegido.register(segurancaRoutes(deps));
    await protegido.register(auditoriaRoutes(deps));
    await protegido.register(conviteRoutesProtegidas(deps));
    await protegido.register(hospitalRoutes(deps));
    await protegido.register(checkinsRoutes(deps));
    await protegido.register(giroRoutes(deps));
    await protegido.register(observabilidadeRoutes(deps));
    await protegido.register(eventosRoutes(deps));
  });

  return app;
}
