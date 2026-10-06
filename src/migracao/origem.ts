import pg from "pg";
import type { Queryable } from "../db/index.js";

/** Conexão SOMENTE LEITURA com o Postgres do Supabase. */
export function conectarOrigem(url: string): { origem: Queryable; fechar: () => Promise<void> } {
  const u = new URL(url);
  u.searchParams.delete("sslmode");
  const local = ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
  const usarSsl = process.env["SUPABASE_DB_SSL"] !== "false" && !local;
  const pool = new pg.Pool({
    connectionString: u.toString(),
    max: 2,
    ...(usarSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  // Garantia extra: toda conexão usada aqui é marcada como somente leitura (não consegue escrever no Supabase).
  const marcadas = new WeakSet<object>();
  return {
    origem: {
      async query(text, params = []) {
        const client = await pool.connect();
        try {
          if (!marcadas.has(client)) {
            await client.query("SET default_transaction_read_only = on");
            marcadas.add(client);
          }
          const r = await client.query(text, params as unknown[]);
          return { rows: r.rows as never[], rowCount: r.rowCount ?? r.rows.length };
        } finally {
          client.release();
        }
      },
    },
    fechar: () => pool.end(),
  };
}

const TIPOS: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** Baixa um arquivo do Storage do Supabase (bucket privado) usando a chave service_role. `null` = não existe. */
export function criarBaixador(opts: { baseUrl: string; chave: string; bucket: string }) {
  const base = opts.baseUrl.replace(/\/+$/, "");
  return async (caminho: string): Promise<{ dados: Buffer; contentType: string } | null> => {
    const rota = caminho.split("/").map(encodeURIComponent).join("/");
    const res = await fetch(`${base}/storage/v1/object/${opts.bucket}/${rota}`, {
      headers: { apikey: opts.chave, Authorization: `Bearer ${opts.chave}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ext = caminho.split(".").pop()?.toLowerCase() ?? "";
    return { dados: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? TIPOS[ext] ?? "image/jpeg" };
  };
}
