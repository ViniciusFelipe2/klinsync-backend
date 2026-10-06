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
import { giroRoutes } from "./routes/giro.js";
import { hospitalRoutes } from "./routes/hospital.js";
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
    const status = (err as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) {
      const msg =
        status === 413 ? "Requisição grande demais." : status === 429 ? "Muitas requisições. Aguarde um instante." : "Requisição inválida.";
      return reply.code(status).send({ message: msg });
    }
    req.log.error({ err }, "erro não tratado");
    return reply.code(500).send({ message: MSG_GENERICA });
  });

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

    await protegido.register(authProtegidas(deps));
    await protegido.register(sessaoRoutes(deps));
    await protegido.register(masterRoutes(deps));
    await protegido.register(segurancaRoutes(deps));
    await protegido.register(auditoriaRoutes(deps));
    await protegido.register(conviteRoutesProtegidas(deps));
    await protegido.register(hospitalRoutes(deps));
    await protegido.register(checkinsRoutes(deps));
    await protegido.register(giroRoutes(deps));
  });

  return app;
}
