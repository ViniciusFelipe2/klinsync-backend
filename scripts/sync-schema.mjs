// Copia as migrations do repositório klinsync-db (irmão deste) para test/db/, usadas pelos testes.
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const aqui = dirname(fileURLToPath(import.meta.url));
const origem = resolve(aqui, "..", "..", "klinsync-db", "migrations");
const destino = resolve(aqui, "..", "test", "db");

if (!existsSync(origem)) {
  console.error(`Pasta não encontrada: ${origem}\nClone o klinsync-db ao lado do klinsync-backend.`);
  process.exit(1);
}
mkdirSync(destino, { recursive: true });
cpSync(origem, destino, { recursive: true });
console.log(`Migrations copiadas (${readdirSync(destino).filter((f) => f.endsWith(".sql")).length} arquivos) para test/db/`);
