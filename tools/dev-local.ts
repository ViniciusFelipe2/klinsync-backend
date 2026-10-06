/**
 * Sobe a API localmente em cima do banco de teste em disco (.local-db/).
 *
 *   npm run local:dev            # http://127.0.0.1:3000
 *
 * Variáveis opcionais: PORT, CORS_ORIGIN, CHECKIN_PHOTOS_BUCKET (usa o S3 real com as suas credenciais da AWS),
 * LOCAL_DB_DIR. Aponte o front para ela com VITE_API_URL=http://127.0.0.1:3000.
 */
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { criarExternos } from "../src/services/externos.js";
import { criarStorageS3 } from "../src/services/storage.js";
import { abrirBancoLocal, RAIZ } from "./pglite-local.js";
import { criarStorageLocal } from "./storage-local.js";
import { segredosLocais } from "./segredos.js";
import { join } from "node:path";

const { jwtAccess, jwtRefresh } = segredosLocais();
const config = loadConfig({
  NODE_ENV: "development",
  HOST: process.env["HOST"] ?? "127.0.0.1",
  PORT: process.env["PORT"] ?? "3000",
  DATABASE_URL: "postgresql://local/local",
  JWT_ACCESS_SECRET: jwtAccess,
  JWT_REFRESH_SECRET: jwtRefresh,
  CORS_ORIGIN: process.env["CORS_ORIGIN"] ?? "http://localhost:5173,http://127.0.0.1:5173",
  CHECKIN_PHOTOS_BUCKET: process.env["CHECKIN_PHOTOS_BUCKET"] ?? "",
  AWS_REGION: process.env["AWS_REGION"] ?? "us-east-2",
  TRUST_PROXY: "false",
  GEOIP_ENABLED: "false",
  HIBP_ENABLED: "false",
  LOG_LEVEL: process.env["LOG_LEVEL"] ?? "info",
});

const banco = await abrirBancoLocal();
// Fotos: S3 real se CHECKIN_PHOTOS_BUCKET estiver definido; senão, em disco (.local-db/fotos), servidas por esta API.
const local = criarStorageLocal(join(RAIZ, ".local-db", "fotos"), `http://${config.HOST}:${config.PORT}`);
const storage = config.CHECKIN_PHOTOS_BUCKET ? criarStorageS3(config) : local.storage;
const app = await buildApp({ config, db: banco.db, externos: criarExternos(config), storage });
if (!config.CHECKIN_PHOTOS_BUCKET) local.registrarRota(app);

const encerrar = async () => {
  await app.close();
  await banco.db.close();
  process.exit(0);
};
process.on("SIGINT", () => void encerrar());
process.on("SIGTERM", () => void encerrar());

await app.listen({ host: config.HOST, port: config.PORT });
console.log(`\nAPI local em http://${config.HOST}:${config.PORT}  (banco: ${banco.dir}${banco.novo ? ", recém-criado" : ""})`);
console.log(config.CHECKIN_PHOTOS_BUCKET ? `Fotos de check-in no S3 (${config.CHECKIN_PHOTOS_BUCKET}).` : "Fotos de check-in salvas em disco (.local-db/fotos).");
