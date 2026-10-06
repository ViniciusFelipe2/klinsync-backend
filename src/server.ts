import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPgDb } from "./db/index.js";
import { criarExternos } from "./services/externos.js";
import { criarStorageS3 } from "./services/storage.js";

async function main() {
  const config = loadConfig();
  const db = createPgDb({ connectionString: config.DATABASE_URL, max: config.DB_POOL_MAX });
  const app = await buildApp({ config, db, externos: criarExternos(config), storage: criarStorageS3(config) });

  let encerrando = false;
  const encerrar = async (sinal: string) => {
    if (encerrando) return;
    encerrando = true;
    app.log.info({ sinal }, "encerrando o servidor");
    // O PM2 espera até 10 s (kill_timeout) antes de matar o processo.
    setTimeout(() => process.exit(1), 9_000).unref();
    try {
      await app.close();
      await db.close();
      process.exit(0);
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void encerrar("SIGINT"));
  process.on("SIGTERM", () => void encerrar("SIGTERM"));
  process.on("unhandledRejection", (err) => {
    app.log.error({ err }, "unhandledRejection");
  });

  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
