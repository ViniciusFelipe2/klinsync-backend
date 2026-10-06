import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { HttpError, notFound } from "../errors.js";
import { limitarTentativas } from "../lib/limites.js";
import { escopoTenant, exigirTenant } from "../lib/perfil.js";
import { Where, dataValida, escaparLike, limitesDoPeriodo } from "../lib/sql.js";

const DEFAULT_DISK_GB = 1; // tamanho do disco contratado exibido na barra de uso

const createSchema = z.object({
  doctorName: z.string().trim().min(3).max(120),
  photoBase64: z
    .string()
    .min(100)
    .max(1_500_000)
    .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/),
});
const idSchema = z.object({ id: z.string().uuid() });
const idsSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(5000) });

const filtroSchema = z.object({
  busca: z.string().optional(),
  de: z.string().optional(),
  ate: z.string().optional(),
});

/** Confere se os bytes realmente são do tipo de imagem declarado (evita enviar outro conteúdo como "foto"). */
function assinaturaConfere(tipo: string, b: Buffer): boolean {
  if (tipo === "jpeg") return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (tipo === "png") return b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (tipo === "webp") return b.length > 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

export const checkinsRoutes =
  ({ db, config, storage }: Deps): FastifyPluginAsync =>
  async (app) => {
    const tz = config.APP_TIMEZONE;

    app.post("/checkins", async (req) => {
      const ip = req.ip || "desconhecido";
      // O limite vale antes de qualquer validação (inclui requisições inválidas em massa).
      // Vários médicos compartilham o IP do hospital e chegam em lotes: janela folgada para picos legítimos.
      await limitarTentativas(db, `checkin:${ip}`, 60, 60_000);
      const d = createSchema.parse(req.body);
      const perfil = await exigirTenant(db, req.auth.userId);

      const [meta, b64] = d.photoBase64.split(",") as [string, string];
      const tipo = meta.slice(11, meta.indexOf(";")); // data:image/<tipo>;base64
      const foto = Buffer.from(b64, "base64");
      if (!assinaturaConfere(tipo, foto)) throw new HttpError(422, "A foto enviada não é uma imagem válida.");

      const path = `${perfil.tenant_id}/${randomUUID()}.${tipo}`;
      await storage.put(path, foto, `image/${tipo}`);
      try {
        const r = await db.query(
          `INSERT INTO check_ins (doctor_name, photo_path, tenant_id) VALUES ($1, $2, $3)
           RETURNING id, doctor_name, checked_in_at`,
          [d.doctorName, path, perfil.tenant_id],
        );
        return r.rows[0];
      } catch (err) {
        await storage.remove(path).catch(() => undefined); // não deixa foto órfã
        throw err;
      }
    });

    app.post("/checkins/foto-url", async (req) => {
      const { id } = idSchema.parse(req.body);
      const perfil = await exigirTenant(db, req.auth.userId);
      const row = (await db.query<{ photo_path: string }>("SELECT photo_path FROM check_ins WHERE id = $1 AND tenant_id = $2", [id, perfil.tenant_id]))
        .rows[0];
      if (!row) throw notFound();
      return { url: await storage.signedUrl(row.photo_path, 300) };
    });

    app.post("/checkins/fotos-urls", async (req) => {
      const { ids } = idsSchema.parse(req.body);
      const perfil = await exigirTenant(db, req.auth.userId);
      const rows = (
        await db.query<{ id: string; photo_path: string }>(
          "SELECT id, photo_path FROM check_ins WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
          [perfil.tenant_id, ids],
        )
      ).rows;
      const urls: Record<string, string> = {};
      // Links curtos: fotos são dado pessoal (LGPD).
      for (let i = 0; i < rows.length; i += 100) {
        await Promise.all(
          rows.slice(i, i + 100).map(async (r) => {
            urls[r.id] = await storage.signedUrl(r.photo_path, 60 * 30);
          }),
        );
      }
      return { urls };
    });

    app.post("/checkins/excluir", async (req) => {
      const { id } = idSchema.parse(req.body);
      const perfil = await exigirTenant(db, req.auth.userId);
      const r = await db.query<{ photo_path: string }>(
        "DELETE FROM check_ins WHERE id = $1 AND tenant_id = $2 RETURNING photo_path",
        [id, perfil.tenant_id],
      );
      const row = r.rows[0];
      if (!row) throw notFound();
      await storage.remove(row.photo_path).catch((err) => req.log.warn({ err }, "falha ao remover a foto do check-in"));
      return { ok: true as const };
    });

    app.post("/checkins/uso", async (req) => {
      const perfil = await exigirTenant(db, req.auth.userId);
      const uso = await storage.usage(perfil.tenant_id);
      return {
        usedBytes: uso.bytes,
        totalBytes: DEFAULT_DISK_GB * 1024 * 1024 * 1024,
        isEstimate: false,
        checkInCount: uso.count,
      };
    });

    /** Filtros comuns do painel e da exportação (master vê todos os hospitais). */
    const montarFiltro = async (userId: string, f: z.infer<typeof filtroSchema>) => {
      const { tenantId } = await escopoTenant(db, userId);
      const w = new Where();
      if (tenantId) w.add("tenant_id = ?", tenantId);
      if (f.busca?.trim()) w.add("doctor_name ILIKE ?", `%${escaparLike(f.busca.trim())}%`);
      const de = dataValida(f.de);
      const ate = dataValida(f.ate);
      if (de || ate) {
        const l = await limitesDoPeriodo(db, tz, de, ate, { dias: 36500 });
        if (de) w.add("checked_in_at >= ?", l.de);
        if (ate) w.add("checked_in_at < ?", l.ate);
      }
      return { w, tenantId };
    };

    app.post("/checkins/listar", async (req) => {
      const d = filtroSchema
        .extend({ pagina: z.number().int().min(1).default(1), porPagina: z.number().int().min(1).max(200).default(20) })
        .parse(req.body ?? {});
      const { w, tenantId } = await montarFiltro(req.auth.userId, d);

      const [linhas, total, hoje] = await Promise.all([
        db.query(
          `SELECT id, doctor_name, checked_in_at FROM check_ins ${w.sql}
            ORDER BY checked_in_at DESC LIMIT $${w.proximo} OFFSET $${w.proximo + 1}`,
          [...w.params, d.porPagina, (d.pagina - 1) * d.porPagina],
        ),
        db.query<{ n: number }>(`SELECT count(*)::int AS n FROM check_ins ${w.sql}`, w.params),
        db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM check_ins
            WHERE ($1::uuid IS NULL OR tenant_id = $1)
              AND checked_in_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2`,
          [tenantId, tz],
        ),
      ]);
      return { linhas: linhas.rows, total: total.rows[0]?.n ?? 0, hoje: hoje.rows[0]?.n ?? 0 };
    });

    app.post("/checkins/exportar", async (req) => {
      const d = filtroSchema.parse(req.body ?? {});
      const { w } = await montarFiltro(req.auth.userId, d);
      const r = await db.query(
        `SELECT id, doctor_name, checked_in_at FROM check_ins ${w.sql} ORDER BY checked_in_at DESC LIMIT 5000`,
        w.params,
      );
      return { linhas: r.rows };
    });
  };
