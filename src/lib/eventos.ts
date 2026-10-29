import type { Db } from "../db/index.js";

export type TipoEvento = "giro" | "reserva" | "checkin" | "salas";

/** Aviso de "algo mudou" (sem dados sensíveis): o cliente apenas busca de novo o que está na tela. */
export type EventoTempoReal = { tipo: TipoEvento; tenantId: string | null };

const CANAL = "klinsync_eventos";

/**
 * Barramento de eventos em tempo real. Com PostgreSQL usa LISTEN/NOTIFY, então um evento gerado
 * em qualquer processo do PM2 chega aos clientes conectados em qualquer outro. Sem suporte
 * (ou se a escuta cair) entrega só dentro do próprio processo.
 */
export class BarramentoEventos {
  private ouvintes = new Set<(e: EventoTempoReal) => void>();
  private parar: (() => Promise<void>) | undefined;
  private escutando = false;

  constructor(private readonly db: Db) {}

  async iniciar(): Promise<void> {
    if (!this.db.escutar || this.escutando) return;
    this.parar = await this.db.escutar(CANAL, (payload) => {
      try {
        this.entregar(JSON.parse(payload) as EventoTempoReal);
      } catch {
        /* payload inválido: ignora */
      }
    });
    this.escutando = true;
  }

  async encerrar(): Promise<void> {
    this.escutando = false;
    await this.parar?.();
    this.parar = undefined;
    this.ouvintes.clear();
  }

  assinar(fn: (e: EventoTempoReal) => void): () => void {
    this.ouvintes.add(fn);
    return () => this.ouvintes.delete(fn);
  }

  /** Dispara sem esperar: nunca atrasa nem derruba a requisição que originou o evento. */
  publicar(e: EventoTempoReal): void {
    if (!this.escutando) {
      this.entregar(e);
      return;
    }
    this.db.query("SELECT pg_notify($1, $2)", [CANAL, JSON.stringify(e)]).catch(() => this.entregar(e));
  }

  private entregar(e: EventoTempoReal): void {
    for (const fn of this.ouvintes) {
      try {
        fn(e);
      } catch {
        /* um cliente com problema não afeta os demais */
      }
    }
  }
}
