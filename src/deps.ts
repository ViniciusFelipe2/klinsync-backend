import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import type { Externos } from "./services/externos.js";
import type { PhotoStorage } from "./services/storage.js";

/** Dependências injetadas nas rotas (permite trocar banco/serviços externos nos testes). */
export interface Deps {
  config: Config;
  db: Db;
  externos: Externos;
  storage: PhotoStorage;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Preenchido pelo hook de autenticação nas rotas protegidas. */
    auth: { userId: string; email: string };
  }
}
