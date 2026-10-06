import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import type { PhotoStorage } from "../src/services/storage.js";

/** Fotos em disco (.local-db/fotos) servidas pela própria API local. Só para desenvolvimento. */
export function criarStorageLocal(dir: string, baseUrl: string): { storage: PhotoStorage; registrarRota: (app: FastifyInstance) => void } {
  const raiz = resolve(dir);
  mkdirSync(raiz, { recursive: true });
  const seguro = (caminho: string) => {
    const alvo = resolve(raiz, caminho);
    if (alvo !== raiz && !alvo.startsWith(raiz + sep)) throw new Error("caminho inválido");
    return alvo;
  };

  const storage: PhotoStorage = {
    async put(caminho, corpo) {
      const alvo = seguro(caminho);
      mkdirSync(dirname(alvo), { recursive: true });
      writeFileSync(alvo, corpo);
    },
    async remove(caminho) {
      rmSync(seguro(caminho), { force: true });
    },
    async signedUrl(caminho) {
      return `${baseUrl}/_dev/fotos/${caminho.split("/").map(encodeURIComponent).join("/")}`;
    },
    async usage(prefixo) {
      const base = seguro(prefixo);
      let bytes = 0;
      let count = 0;
      const percorrer = (d: string) => {
        if (!existsSync(d)) return;
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) percorrer(p);
          else {
            bytes += statSync(p).size;
            count += 1;
          }
        }
      };
      percorrer(base);
      return { bytes, count };
    },
  };

  const registrarRota = (app: FastifyInstance) => {
    app.get<{ Params: { "*": string } }>("/_dev/fotos/*", async (req, reply) => {
      try {
        const alvo = seguro(decodeURIComponent(req.params["*"]));
        if (!existsSync(alvo)) return reply.code(404).send({ message: "Foto não encontrada." });
        const ext = alvo.split(".").pop()?.toLowerCase();
        return reply.type(ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg").send(readFileSync(alvo));
      } catch {
        return reply.code(400).send({ message: "Caminho inválido." });
      }
    });
  };
  return { storage, registrarRota };
}
