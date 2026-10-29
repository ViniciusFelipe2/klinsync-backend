import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import type { BarramentoEventos } from "./lib/eventos.js";
import type { ColetorMetricas } from "./lib/metricas-api.js";
import type { Monitor } from "./services/monitor.js";
import type { Externos } from "./services/externos.js";
import type { PhotoStorage } from "./services/storage.js";

/** Dependências injetadas nas rotas (permite trocar banco/serviços externos nos testes). */
export interface Deps {
  config: Config;
  db: Db;
  externos: Externos;
  storage: PhotoStorage;
  /** Leitura de EC2/CloudWatch/custos da AWS para a aba de observabilidade do master. */
  monitor: Monitor;
  /** Avisos em tempo real (SSE) para os painéis e tablets abertos. */
  eventos: BarramentoEventos;
  /** Acumula volume, erros e latência da API (opcional: sem ele nada é medido). */
  metricas?: ColetorMetricas;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Preenchido pelo hook de autenticação nas rotas protegidas. */
    auth: { userId: string; email: string };
  }
}
