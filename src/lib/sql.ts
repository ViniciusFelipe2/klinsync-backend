import type { Queryable } from "../db/index.js";

/** Monta cláusulas WHERE com parâmetros posicionais ($1, $2...). Use `?` como marcador. */
export class Where {
  private readonly condicoes: string[] = [];
  readonly params: unknown[] = [];

  add(condicao: string, ...valores: unknown[]): this {
    let i = 0;
    this.condicoes.push(condicao.replace(/\?/g, () => `$${this.params.length + ++i}`));
    this.params.push(...valores);
    return this;
  }

  get sql(): string {
    return this.condicoes.length ? `WHERE ${this.condicoes.join(" AND ")}` : "";
  }

  /** Próximo índice de parâmetro livre (para LIMIT/OFFSET etc.). */
  get proximo(): number {
    return this.params.length + 1;
  }
}

/** Escapa curingas do LIKE para busca literal por substring. */
export const escaparLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export const ehUuid = (v: string | undefined | null): v is string =>
  !!v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * Converte datas "YYYY-MM-DD" do filtro em instantes, no fuso do hospital:
 * `de` = 00:00 do dia inicial; `ate` = 00:00 do dia seguinte ao final (limite exclusivo).
 */
export async function limitesDoPeriodo(
  q: Queryable,
  tz: string,
  de: string | undefined,
  ate: string | undefined,
  padrao: { dias: number },
): Promise<{ de: Date; ate: Date }> {
  const r = await q.query<{ de: Date; ate: Date }>(
    `SELECT COALESCE(($1::date)::timestamp AT TIME ZONE $3, now() - make_interval(days => $4::int)) AS de,
            COALESCE((($2::date) + 1)::timestamp AT TIME ZONE $3, now()) AS ate`,
    [de ?? null, ate ?? null, tz, padrao.dias],
  );
  const l = r.rows[0]!;
  return { de: new Date(l.de), ate: new Date(l.ate) };
}

/** Data local "YYYY-MM-DD" de um instante, no fuso informado. */
export const dataLocal = (d: Date | string, tz: string) =>
  new Date(d).toLocaleDateString("sv-SE", { timeZone: tz });

/** Valida "YYYY-MM-DD" (o filtro do front); valores inválidos são ignorados. */
export const dataValida = (v: string | undefined): string | undefined =>
  v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined;
