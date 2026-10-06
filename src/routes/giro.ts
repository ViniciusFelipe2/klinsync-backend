import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import { escopoTenant } from "../lib/perfil.js";
import type { Queryable } from "../db/index.js";

const uuid = z.string().uuid();

type SalaLinha = { id: string; tenant_id: string; nome: string; ativa: boolean; status_atual: string; cirurgia_atual: string | null };
type EventoLinha = {
  id: string;
  sala_id: string;
  tipo_evento: "desmontagem" | "limpeza" | "remontagem";
  inicio: string;
  fim: string | null;
  tenant_id: string;
};

const COLUNAS_EVENTO =
  "e.id, e.sala_id, e.tipo_evento, e.inicio, e.fim, e.duracao_segundos, e.usuario_inicio_id, e.usuario_fim_id, e.cirurgia_anterior, e.cirurgia_proxima";
const COLUNAS_PARADA = "p.id, p.sala_id, p.inicio, p.fim, p.duracao_segundos, p.usuario_inicio_id, p.usuario_fim_id";

/** Duração em segundos entre o início do evento e agora (calculada no banco, com o mesmo relógio do `fim`). */
const SQL_DURACAO = "GREATEST(0, floor(extract(epoch FROM (now() - inicio))))::int";

export const giroRoutes =
  ({ db }: Deps): FastifyPluginAsync =>
  async (app) => {
    /** Sala (travada para atualização) dentro do escopo de hospital do chamador. */
    const salaDoEscopo = async (q: Queryable, salaId: string, tenantId: string | null): Promise<SalaLinha> => {
      const r = await q.query<SalaLinha>(
        "SELECT id, tenant_id, nome, ativa, status_atual, cirurgia_atual FROM salas WHERE id = $1 AND ($2::uuid IS NULL OR tenant_id = $2) FOR UPDATE",
        [salaId, tenantId],
      );
      const sala = r.rows[0];
      if (!sala) throw notFound("Sala não encontrada.");
      return sala;
    };

    /* ---------------------------------------- Leitura ---------------------------------------- */

    app.get("/giro/salas", async (req) => {
      const { tenantId } = await escopoTenant(db, req.auth.userId);
      const r = await db.query(
        `SELECT id, nome, ativa, status_atual, updated_at, cirurgia_atual FROM salas
          WHERE ativa AND ($1::uuid IS NULL OR tenant_id = $1) ORDER BY nome`,
        [tenantId],
      );
      return r.rows;
    });

    app.get("/giro/eventos", async (req) => {
      const q = z
        .object({ abertos: z.enum(["true", "false"]).optional(), horas: z.coerce.number().int().min(1).max(168).optional() })
        .parse(req.query);
      const { tenantId } = await escopoTenant(db, req.auth.userId);
      const aberto = q.abertos === "true";
      const horas = q.horas ?? 48;
      const r = await db.query(
        `SELECT ${COLUNAS_EVENTO} FROM eventos_giro e JOIN salas s ON s.id = e.sala_id
          WHERE ($1::uuid IS NULL OR s.tenant_id = $1)
            AND ${aberto ? "e.fim IS NULL" : "e.inicio >= now() - make_interval(hours => $2::int)"}
          ORDER BY e.inicio DESC`,
        aberto ? [tenantId] : [tenantId, horas],
      );
      return r.rows;
    });

    app.get("/giro/paradas", async (req) => {
      z.object({ abertas: z.enum(["true", "false"]).optional() }).parse(req.query);
      const { tenantId } = await escopoTenant(db, req.auth.userId);
      const r = await db.query(
        `SELECT ${COLUNAS_PARADA} FROM eventos_sala_parada p JOIN salas s ON s.id = p.sala_id
          WHERE ($1::uuid IS NULL OR s.tenant_id = $1) AND p.fim IS NULL ORDER BY p.inicio DESC`,
        [tenantId],
      );
      return r.rows;
    });

    app.get("/giro/historico", async (req) => {
      const q = z.object({ de: z.string().datetime({ offset: true }), ate: z.string().datetime({ offset: true }) }).parse(req.query);
      if (new Date(q.ate).getTime() - new Date(q.de).getTime() > 366 * 86400_000) {
        throw unprocessable("O período máximo é de 366 dias.");
      }
      const { tenantId } = await escopoTenant(db, req.auth.userId);
      const [giro, paradas] = await Promise.all([
        db.query(
          `SELECT ${COLUNAS_EVENTO} FROM eventos_giro e JOIN salas s ON s.id = e.sala_id
            WHERE ($1::uuid IS NULL OR s.tenant_id = $1) AND e.inicio >= $2 AND e.inicio <= $3
            ORDER BY e.inicio DESC`,
          [tenantId, q.de, q.ate],
        ),
        db.query(
          `SELECT ${COLUNAS_PARADA} FROM eventos_sala_parada p JOIN salas s ON s.id = p.sala_id
            WHERE ($1::uuid IS NULL OR s.tenant_id = $1) AND p.inicio >= $2 AND p.inicio <= $3
            ORDER BY p.inicio DESC`,
          [tenantId, q.de, q.ate],
        ),
      ]);
      return { giro: giro.rows, paradas: paradas.rows };
    });

    /* ---------------------------------- Etapas do giro ---------------------------------- */

    app.post("/giro/etapas/iniciar", async (req) => {
      const d = z.object({ salaId: uuid, tipo: z.enum(["desmontagem", "limpeza", "remontagem"]) }).parse(req.body);
      const { perfil, tenantId } = await escopoTenant(db, req.auth.userId);

      await db.tx(async (q) => {
        const sala = await salaDoEscopo(q, d.salaId, tenantId);
        if (!sala.ativa) throw unprocessable("Esta sala está inativa.");

        const abertos = (
          await q.query<{ id: string; tipo_evento: string; inicio: string }>(
            "SELECT id, tipo_evento, inicio FROM eventos_giro WHERE sala_id = $1 AND fim IS NULL",
            [sala.id],
          )
        ).rows;
        const enfermagem = abertos.find((e) => e.tipo_evento === "desmontagem");
        const limpezaAberta = abertos.find((e) => e.tipo_evento === "limpeza");

        if (d.tipo === "desmontagem") {
          if (enfermagem) throw conflict("A enfermagem já foi iniciada nesta sala.");
          if (sala.status_atual !== "livre") throw unprocessable("A enfermagem só pode ser iniciada com a sala livre.");
        } else if (d.tipo === "limpeza") {
          if (!enfermagem) throw unprocessable("Inicie a enfermagem antes da limpeza.");
          if (limpezaAberta) throw conflict("A limpeza já foi iniciada nesta sala.");
          const feita = await q.query(
            "SELECT 1 FROM eventos_giro WHERE sala_id = $1 AND tipo_evento = 'limpeza' AND fim IS NOT NULL AND inicio >= $2",
            [sala.id, enfermagem.inicio],
          );
          if (feita.rowCount > 0) throw unprocessable("A limpeza deste ciclo já foi finalizada.");
        } else {
          if (abertos.length > 0 || sala.status_atual !== "livre") throw unprocessable("A remontagem só pode ser iniciada com a sala livre.");
        }

        await q.query(
          `INSERT INTO eventos_giro (sala_id, tipo_evento, usuario_inicio_id, cirurgia_anterior)
           VALUES ($1, $2, $3, $4)`,
          [sala.id, d.tipo, perfil.id, d.tipo === "desmontagem" ? sala.cirurgia_atual : null],
        );
        await q.query("UPDATE salas SET status_atual = $2 WHERE id = $1", [sala.id, d.tipo]);
      });
      return { ok: true as const };
    });

    app.post("/giro/etapas/finalizar", async (req) => {
      const d = z.object({ eventoId: uuid, cirurgiaProxima: z.string().trim().max(200).optional() }).parse(req.body);
      const { perfil, tenantId } = await escopoTenant(db, req.auth.userId);

      await db.tx(async (q) => {
        const ev = (
          await q.query<EventoLinha>(
            `SELECT e.id, e.sala_id, e.tipo_evento, e.inicio, e.fim, s.tenant_id
               FROM eventos_giro e JOIN salas s ON s.id = e.sala_id
              WHERE e.id = $1 AND ($2::uuid IS NULL OR s.tenant_id = $2) FOR UPDATE OF e`,
            [d.eventoId, tenantId],
          )
        ).rows[0];
        if (!ev) throw notFound("Etapa não encontrada.");
        if (ev.fim) throw conflict("Esta etapa já foi finalizada.");
        await salaDoEscopo(q, ev.sala_id, tenantId);

        let proxima: string | null = null;
        if (ev.tipo_evento === "desmontagem") {
          proxima = d.cirurgiaProxima?.trim() || null;
          if (!proxima) throw unprocessable("Informe a próxima cirurgia antes de finalizar a enfermagem.");
          const limpezaAberta = await q.query("SELECT 1 FROM eventos_giro WHERE sala_id = $1 AND tipo_evento = 'limpeza' AND fim IS NULL", [ev.sala_id]);
          const limpezaFeita = await q.query(
            "SELECT 1 FROM eventos_giro WHERE sala_id = $1 AND tipo_evento = 'limpeza' AND fim IS NOT NULL AND inicio >= $2",
            [ev.sala_id, ev.inicio],
          );
          if (limpezaAberta.rowCount > 0 || limpezaFeita.rowCount === 0) {
            throw unprocessable("Finalize a limpeza antes de encerrar a enfermagem.");
          }
        }

        await q.query(
          `UPDATE eventos_giro SET fim = now(), duracao_segundos = ${SQL_DURACAO}, usuario_fim_id = $2,
                  cirurgia_proxima = COALESCE($3, cirurgia_proxima) WHERE id = $1`,
          [ev.id, perfil.id, proxima],
        );

        if (ev.tipo_evento === "desmontagem") {
          await q.query("UPDATE salas SET status_atual = 'livre', cirurgia_atual = $2 WHERE id = $1", [ev.sala_id, proxima]);
        } else if (ev.tipo_evento === "limpeza") {
          const enfermagem = await q.query("SELECT 1 FROM eventos_giro WHERE sala_id = $1 AND tipo_evento = 'desmontagem' AND fim IS NULL", [ev.sala_id]);
          await q.query("UPDATE salas SET status_atual = $2 WHERE id = $1", [ev.sala_id, enfermagem.rowCount > 0 ? "desmontagem" : "livre"]);
        } else {
          await q.query("UPDATE salas SET status_atual = 'livre' WHERE id = $1", [ev.sala_id]);
        }
      });
      return { ok: true as const };
    });

    /* ---------------------------------- Sala parada ---------------------------------- */

    app.post("/giro/paradas/iniciar", async (req) => {
      const { salaId } = z.object({ salaId: uuid }).parse(req.body);
      const { perfil, tenantId } = await escopoTenant(db, req.auth.userId);
      await db.tx(async (q) => {
        const sala = await salaDoEscopo(q, salaId, tenantId);
        const aberta = await q.query("SELECT 1 FROM eventos_sala_parada WHERE sala_id = $1 AND fim IS NULL", [sala.id]);
        if (aberta.rowCount > 0) throw conflict("A sala já está marcada como parada.");
        await q.query("INSERT INTO eventos_sala_parada (sala_id, usuario_inicio_id) VALUES ($1, $2)", [sala.id, perfil.id]);
      });
      return { ok: true as const };
    });

    app.post("/giro/paradas/finalizar", async (req) => {
      const { paradaId } = z.object({ paradaId: uuid }).parse(req.body);
      const { perfil, tenantId } = await escopoTenant(db, req.auth.userId);
      await db.tx(async (q) => {
        const p = (
          await q.query<{ id: string; sala_id: string; fim: string | null }>(
            `SELECT p.id, p.sala_id, p.fim FROM eventos_sala_parada p JOIN salas s ON s.id = p.sala_id
              WHERE p.id = $1 AND ($2::uuid IS NULL OR s.tenant_id = $2) FOR UPDATE OF p`,
            [paradaId, tenantId],
          )
        ).rows[0];
        if (!p) throw notFound("Parada não encontrada.");
        if (p.fim) throw conflict("Esta parada já foi finalizada.");
        await q.query(
          `UPDATE eventos_sala_parada SET fim = now(), duracao_segundos = ${SQL_DURACAO}, usuario_fim_id = $2 WHERE id = $1`,
          [p.id, perfil.id],
        );
      });
      return { ok: true as const };
    });

    /* ------------------------------ Vínculo sala <-> tablet ------------------------------ */

    app.get("/giro/reservas", async (req) => {
      const { tenantId } = await escopoTenant(db, req.auth.userId);
      const r = await db.query(
        `SELECT d.sala_id, d.device_id, d.ultimo_sinal FROM sala_dispositivos d JOIN salas s ON s.id = d.sala_id
          WHERE ($1::uuid IS NULL OR s.tenant_id = $1)`,
        [tenantId],
      );
      return r.rows;
    });

    const reservaSchema = z.object({ salaId: uuid, deviceId: z.string().trim().min(1).max(200) });

    /** O vínculo é permanente: só muda quando o próprio tablet o libera (ou um administrador). */
    app.post("/giro/reservas/reservar", async (req) => {
      const d = reservaSchema.parse(req.body);
      const { perfil, tenantId } = await escopoTenant(db, req.auth.userId);
      const reservada = await db.tx(async (q) => {
        await salaDoEscopo(q, d.salaId, tenantId);
        // Um tablet só pode estar vinculado a uma sala por vez.
        await q.query("DELETE FROM sala_dispositivos WHERE device_id = $1 AND sala_id <> $2", [d.deviceId, d.salaId]);
        await q.query(
          `INSERT INTO sala_dispositivos (sala_id, device_id, user_id, ultimo_sinal) VALUES ($1, $2, $3, now())
           ON CONFLICT (sala_id) DO UPDATE SET user_id = EXCLUDED.user_id, ultimo_sinal = now()
           WHERE sala_dispositivos.device_id = EXCLUDED.device_id`,
          [d.salaId, d.deviceId, perfil.id],
        );
        const r = await q.query("SELECT 1 FROM sala_dispositivos WHERE sala_id = $1 AND device_id = $2", [d.salaId, d.deviceId]);
        return r.rowCount > 0;
      });
      return { reservada };
    });

    app.post("/giro/reservas/liberar", async (req) => {
      const d = reservaSchema.parse(req.body);
      const { perfil, tenantId } = await escopoTenant(db, req.auth.userId);
      const admin = perfil.role !== "operador";
      await db.tx(async (q) => {
        await salaDoEscopo(q, d.salaId, tenantId);
        await q.query("DELETE FROM sala_dispositivos WHERE sala_id = $1 AND (device_id = $2 OR $3::boolean)", [d.salaId, d.deviceId, admin]);
      });
      return { ok: true as const };
    });

    app.post("/giro/reservas/heartbeat", async (req) => {
      const d = reservaSchema.parse(req.body);
      const { tenantId } = await escopoTenant(db, req.auth.userId);
      await db.query(
        `UPDATE sala_dispositivos SET ultimo_sinal = now()
          WHERE sala_id = $1 AND device_id = $2
            AND sala_id IN (SELECT id FROM salas WHERE $3::uuid IS NULL OR tenant_id = $3)`,
        [d.salaId, d.deviceId, tenantId],
      );
      return { ok: true as const };
    });
  };
