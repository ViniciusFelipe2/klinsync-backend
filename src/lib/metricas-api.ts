import type { Queryable } from "../db/index.js";

type Balde = { minuto: number; metodo: string; rota: string; req: number; e4: number; e5: number; lentas: number; soma: number; max: number };

export const LIMITE_LENTA_MS = 1000;
const RETENCAO_DIAS = 14;

/**
 * Acumula, por minuto e rota, o volume, os erros e a latência da API. Cada processo guarda em memória
 * e grava em lote (o upsert soma, então vale entre todas as instâncias do PM2). Nunca guarda dados do usuário.
 */
export class ColetorMetricas {
  private baldes = new Map<string, Balde>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly db: Queryable) {}

  registrar(metodo: string, rota: string, status: number, ms: number): void {
    const minuto = Math.floor(Date.now() / 60_000) * 60_000;
    const chave = `${minuto}|${metodo}|${rota}`;
    let b = this.baldes.get(chave);
    if (!b) {
      b = { minuto, metodo, rota, req: 0, e4: 0, e5: 0, lentas: 0, soma: 0, max: 0 };
      this.baldes.set(chave, b);
    }
    const dur = Math.max(0, Math.round(ms));
    b.req += 1;
    if (status >= 500) b.e5 += 1;
    else if (status >= 400) b.e4 += 1;
    if (dur > LIMITE_LENTA_MS) b.lentas += 1;
    b.soma += dur;
    b.max = Math.max(b.max, dur);
  }

  /** Grava o que está pendente. Em caso de falha, devolve os dados à fila para a próxima tentativa. */
  async descarregar(): Promise<void> {
    if (this.baldes.size === 0) return;
    const lote = [...this.baldes.values()];
    this.baldes = new Map();
    try {
      await this.db.query(
        `INSERT INTO metricas_api (minuto, metodo, rota, requisicoes, erros_4xx, erros_5xx, lentas, soma_ms, max_ms)
         SELECT * FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::int[], $5::int[], $6::int[], $7::int[], $8::bigint[], $9::int[])
         ON CONFLICT (minuto, metodo, rota) DO UPDATE SET
           requisicoes = metricas_api.requisicoes + EXCLUDED.requisicoes,
           erros_4xx = metricas_api.erros_4xx + EXCLUDED.erros_4xx,
           erros_5xx = metricas_api.erros_5xx + EXCLUDED.erros_5xx,
           lentas = metricas_api.lentas + EXCLUDED.lentas,
           soma_ms = metricas_api.soma_ms + EXCLUDED.soma_ms,
           max_ms = GREATEST(metricas_api.max_ms, EXCLUDED.max_ms)`,
        [
          lote.map((b) => new Date(b.minuto).toISOString()),
          lote.map((b) => b.metodo),
          lote.map((b) => b.rota),
          lote.map((b) => b.req),
          lote.map((b) => b.e4),
          lote.map((b) => b.e5),
          lote.map((b) => b.lentas),
          lote.map((b) => b.soma),
          lote.map((b) => b.max),
        ],
      );
      if (Math.random() < 0.01) {
        await this.db.query("DELETE FROM metricas_api WHERE minuto < now() - make_interval(days => $1::int)", [RETENCAO_DIAS]);
      }
    } catch {
      for (const b of lote) {
        const k = `${b.minuto}|${b.metodo}|${b.rota}`;
        const atual = this.baldes.get(k);
        if (!atual) this.baldes.set(k, b);
        else {
          atual.req += b.req; atual.e4 += b.e4; atual.e5 += b.e5; atual.lentas += b.lentas; atual.soma += b.soma; atual.max = Math.max(atual.max, b.max);
        }
      }
      if (this.baldes.size > 5000) this.baldes = new Map(); // banco fora do ar por muito tempo: descarta para não crescer sem limite
    }
  }

  iniciar(intervaloMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.descarregar(), intervaloMs);
    this.timer.unref();
  }

  async parar(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.descarregar();
  }
}
