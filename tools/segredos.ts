import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RAIZ } from "./pglite-local.js";

const arquivo = join(RAIZ, ".local-db", "segredos.json");

/**
 * Segredos de desenvolvimento, gerados uma vez e guardados em .local-db/ (fora do Git).
 * Precisam ser os mesmos na importação (cifra o MFA) e no servidor local.
 */
export function segredosLocais(): { jwtAccess: string; jwtRefresh: string } {
  if (!existsSync(arquivo)) {
    mkdirSync(dirname(arquivo), { recursive: true });
    writeFileSync(
      arquivo,
      JSON.stringify({ jwtAccess: randomBytes(32).toString("hex"), jwtRefresh: randomBytes(32).toString("hex") }, null, 2),
    );
  }
  return JSON.parse(readFileSync(arquivo, "utf8")) as { jwtAccess: string; jwtRefresh: string };
}
