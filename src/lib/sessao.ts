import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { unauthorized } from "../errors.js";
import { sha256Hex, tokenAleatorio } from "./crypto.js";
import { assinarAccessToken } from "./tokens.js";

export type SessaoResposta = {
  accessToken: string;
  refreshToken: string;
  /** Expiração do access token, em segundos desde a época. */
  expiresAt: number;
  user: { id: string; email: string };
};

type Origem = { ip: string; userAgent: string | null };

const hashRefresh = (config: Config, token: string) => sha256Hex(`${config.JWT_REFRESH_SECRET}:${token}`);

async function gravarRefresh(
  db: Pick<Db, "query">,
  config: Config,
  usuarioId: string,
  familia: string,
  origem: Origem,
): Promise<string> {
  const token = tokenAleatorio(32);
  await db.query(
    `INSERT INTO refresh_tokens (usuario_id, familia, token_hash, expira_em, ip, user_agent)
     VALUES ($1, $2, $3, now() + make_interval(days => $4::int), $5, $6)`,
    [usuarioId, familia, hashRefresh(config, token), config.REFRESH_TOKEN_TTL_DAYS, origem.ip, origem.userAgent],
  );
  return token;
}

export async function emitirSessao(
  db: Pick<Db, "query">,
  config: Config,
  usuario: { id: string; email: string },
  origem: Origem,
  familia: string = randomUUID(),
): Promise<SessaoResposta> {
  const { token, expiresAt } = await assinarAccessToken(
    config.JWT_ACCESS_SECRET,
    { sub: usuario.id, email: usuario.email },
    config.ACCESS_TOKEN_TTL_MIN,
  );
  const refreshToken = await gravarRefresh(db, config, usuario.id, familia, origem);
  return { accessToken: token, refreshToken, expiresAt, user: { id: usuario.id, email: usuario.email } };
}

/** Troca o refresh token por uma nova sessão (rotação). Reuso de token revogado derruba a família inteira. */
export async function renovarSessao(db: Db, config: Config, refreshToken: string, origem: Origem): Promise<SessaoResposta> {
  const hash = hashRefresh(config, refreshToken);
  const r = await db.query<{
    id: string;
    usuario_id: string;
    familia: string;
    expirado: boolean;
    revogado: boolean;
    email: string;
    ativo: boolean | null;
  }>(
    `SELECT t.id, t.usuario_id, t.familia, (t.expira_em < now()) AS expirado,
            (t.revogado_em IS NOT NULL) AS revogado, u.email, p.ativo
       FROM refresh_tokens t
       JOIN usuarios u ON u.id = t.usuario_id
       LEFT JOIN usuarios_perfil p ON p.id = t.usuario_id
      WHERE t.token_hash = $1`,
    [hash],
  );
  const t = r.rows[0];
  if (!t) throw unauthorized();

  if (t.revogado) {
    await db.query("UPDATE refresh_tokens SET revogado_em = now() WHERE familia = $1 AND revogado_em IS NULL", [t.familia]);
    throw unauthorized();
  }
  if (t.expirado || !t.ativo) {
    await db.query("UPDATE refresh_tokens SET revogado_em = now() WHERE id = $1", [t.id]);
    throw unauthorized();
  }

  return db.tx(async (q) => {
    const consumido = await q.query(
      "UPDATE refresh_tokens SET revogado_em = now() WHERE id = $1 AND revogado_em IS NULL",
      [t.id],
    );
    if (consumido.rowCount === 0) throw unauthorized(); // corrida: outra requisição já usou este token
    return emitirSessao(q, config, { id: t.usuario_id, email: t.email }, origem, t.familia);
  });
}

export async function revogarRefresh(db: Db, config: Config, refreshToken: string): Promise<void> {
  await db.query("UPDATE refresh_tokens SET revogado_em = now() WHERE token_hash = $1 AND revogado_em IS NULL", [
    hashRefresh(config, refreshToken),
  ]);
}

export async function revogarTodasDoUsuario(db: Pick<Db, "query">, usuarioId: string): Promise<void> {
  await db.query("UPDATE refresh_tokens SET revogado_em = now() WHERE usuario_id = $1 AND revogado_em IS NULL", [usuarioId]);
}
