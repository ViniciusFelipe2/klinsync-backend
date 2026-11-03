import type { Queryable } from "../db/index.js";
import { HttpError, tooMany } from "../errors.js";

/**
 * Limitador de taxa por janela fixa, atômico no banco (vale entre todas as instâncias do PM2).
 * Bloqueia a partir da tentativa `max + 1` dentro da janela.
 */
export async function limitarTentativas(
  q: Queryable,
  chave: string,
  max: number,
  janelaMs: number,
  mensagem = "Muitas tentativas seguidas. Aguarde um minuto e tente novamente.",
): Promise<void> {
  const segundos = janelaMs / 1000;
  const r = await q.query<{ tentativas: number }>(
    `INSERT INTO rate_limits (chave, janela_inicio, tentativas) VALUES ($1, now(), 1)
     ON CONFLICT (chave) DO UPDATE SET
       tentativas = CASE WHEN rate_limits.janela_inicio < now() - make_interval(secs => $2::float8)
                         THEN 1 ELSE rate_limits.tentativas + 1 END,
       janela_inicio = CASE WHEN rate_limits.janela_inicio < now() - make_interval(secs => $2::float8)
                            THEN now() ELSE rate_limits.janela_inicio END
     RETURNING tentativas::int AS tentativas`,
    [chave, segundos],
  );
  if ((r.rows[0]?.tentativas ?? 1) > max) throw tooMany(mensagem);

  // Limpeza oportunista das janelas antigas.
  if (Math.random() < 0.01) {
    await q.query("DELETE FROM rate_limits WHERE janela_inicio < now() - interval '1 day'");
  }
}

/** Recusa a requisição quando o IP está em timeout ou bloqueio permanente. */
export async function exigirIpLiberado(q: Queryable, ip: string): Promise<void> {
  if (!ip || ip === "desconhecido") return;
  const r = await q.query<{ permanente: boolean; bloqueado_ate: string | null }>(
    "SELECT permanente, bloqueado_ate FROM ip_bloqueios WHERE ip = $1",
    [ip],
  );
  const b = r.rows[0];
  if (!b) return;
  if (b.permanente || (b.bloqueado_ate && new Date(b.bloqueado_ate).getTime() > Date.now())) {
    throw new HttpError(403, "Acesso temporariamente indisponível a partir desta rede.");
  }
}

/** Política de travamento por tentativas (config_seguranca), com os padrões de fábrica. */
async function politicaDeLogin(q: Queryable): Promise<{ max: number; janela: number; bloqueio: number }> {
  const cfg = (
    await q.query<{ max_tentativas: number; janela_minutos: number; bloqueio_minutos: number }>(
      "SELECT max_tentativas, janela_minutos, bloqueio_minutos FROM config_seguranca LIMIT 1",
    )
  ).rows[0];
  return { max: cfg?.max_tentativas ?? 5, janela: cfg?.janela_minutos ?? 15, bloqueio: cfg?.bloqueio_minutos ?? 15 };
}

export type Travamento = { tipo: "ip" | "email"; alvo: string; falhas: number; liberaEm: string };

/**
 * Redes (IP) e contas (e-mail) travadas AGORA por excesso de senhas erradas, pela mesma regra do login.
 * Serve para o master enxergar e liberar; falhas já perdoadas (liberado_em) não contam.
 */
export async function listarTravamentos(q: Queryable): Promise<Travamento[]> {
  const { max, janela, bloqueio } = await politicaDeLogin(q);
  const falhas = (
    await q.query<{ ip: string | null; email_tentado: string | null; created_at: string }>(
      `SELECT ip, email_tentado, created_at FROM log_acessos
        WHERE sucesso = false AND liberado_em IS NULL AND created_at >= now() - make_interval(mins => $1::int)`,
      [janela],
    )
  ).rows;

  const grupos = new Map<string, { tipo: "ip" | "email"; alvo: string; falhas: number; ultima: number }>();
  const somar = (tipo: "ip" | "email", alvo: string | null, quando: number) => {
    if (!alvo || alvo === "desconhecido") return;
    const chave = `${tipo}:${alvo}`;
    const g = grupos.get(chave) ?? { tipo, alvo, falhas: 0, ultima: 0 };
    g.falhas += 1;
    g.ultima = Math.max(g.ultima, quando);
    grupos.set(chave, g);
  };
  for (const f of falhas) {
    const quando = new Date(f.created_at).getTime();
    somar("ip", f.ip, quando);
    somar("email", f.email_tentado?.toLowerCase() ?? null, quando);
  }

  const agora = Date.now();
  return [...grupos.values()]
    .filter((g) => g.falhas >= max && g.ultima + bloqueio * 60_000 > agora)
    .map((g) => ({ tipo: g.tipo, alvo: g.alvo, falhas: g.falhas, liberaEm: new Date(g.ultima + bloqueio * 60_000).toISOString() }))
    .sort((a, b) => b.falhas - a.falhas);
}

/**
 * Libera uma rede e/ou conta: remove o bloqueio do IP e perdoa as falhas de login recentes
 * (sem apagá-las do histórico). Devolve quantas falhas foram perdoadas.
 */
export async function liberarLogin(q: Queryable, alvo: { ip?: string | undefined; email?: string | undefined }): Promise<number> {
  const ip = alvo.ip?.trim() || null;
  const email = alvo.email?.trim().toLowerCase() || null;
  if (ip) await q.query("DELETE FROM ip_bloqueios WHERE ip = $1", [ip]);
  const r = await q.query(
    `UPDATE log_acessos SET liberado_em = now()
      WHERE sucesso = false AND liberado_em IS NULL
        AND (($1::text IS NOT NULL AND ip = $1::text) OR ($2::text IS NOT NULL AND lower(email_tentado) = $2::text))`,
    [ip, email],
  );
  return r.rowCount;
}

export type ResultadoBloqueio = { bloqueado: boolean; minutosRestantes: number };

/** Política de bloqueio de login: por IP bloqueado, por falhas recentes do e-mail ou do IP. */
export async function verificarBloqueioLogin(q: Queryable, email: string, ip: string): Promise<ResultadoBloqueio> {
  const { max, janela, bloqueio } = await politicaDeLogin(q);

  const bloq = (
    await q.query<{ permanente: boolean; bloqueado_ate: string | null }>(
      "SELECT permanente, bloqueado_ate FROM ip_bloqueios WHERE ip = $1",
      [ip],
    )
  ).rows[0];
  if (bloq) {
    if (bloq.permanente) return { bloqueado: true, minutosRestantes: 0 };
    const ate = bloq.bloqueado_ate ? new Date(bloq.bloqueado_ate).getTime() : 0;
    if (ate > Date.now()) return { bloqueado: true, minutosRestantes: Math.ceil((ate - Date.now()) / 60_000) };
  }

  const falhas = (
    await q.query<{ created_at: string; email_tentado: string | null; ip: string | null }>(
      `SELECT created_at, email_tentado, ip FROM log_acessos
        WHERE sucesso = false AND liberado_em IS NULL AND created_at >= now() - make_interval(mins => $1::int)
          AND (email_tentado = $2 OR ip = $3)
        ORDER BY created_at DESC LIMIT 200`,
      [janela, email.toLowerCase(), ip],
    )
  ).rows;

  if (falhas.length >= max) {
    const ultima = new Date(falhas[0]!.created_at).getTime();
    const liberaEm = ultima + bloqueio * 60_000;
    if (Date.now() < liberaEm) {
      // Força bruta persistente: timeout do IP também para outros e-mails.
      const falhasDoIp = falhas.filter((f) => f.ip === ip).length;
      if (ip !== "desconhecido" && falhasDoIp >= max * 2) {
        await q.query(
          `INSERT INTO ip_bloqueios (ip, motivo, permanente, bloqueado_ate)
           VALUES ($1, $2, false, now() + make_interval(mins => $3::int))
           ON CONFLICT (ip) DO UPDATE SET motivo = EXCLUDED.motivo, permanente = false,
             bloqueado_ate = EXCLUDED.bloqueado_ate`,
          [ip, `Bloqueio automático após ${falhasDoIp} falhas de login`, bloqueio],
        );
      }
      return { bloqueado: true, minutosRestantes: Math.ceil((liberaEm - Date.now()) / 60_000) };
    }
  }
  return { bloqueado: false, minutosRestantes: 0 };
}
