import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { HttpError, locked, unauthorized } from "../errors.js";
import { chaveMfa, cifrar, decifrar, ehHashLegado, hashSenha, hashSenhaFalso, verificarSenha } from "../lib/crypto.js";
import { limitarTentativas, verificarBloqueioLogin } from "../lib/limites.js";
import { exigirPerfilAtivo, perfilDe } from "../lib/perfil.js";
import { AVISO_CAPTCHA } from "../lib/senha.js";
import { emitirSessao, renovarSessao, revogarRefresh } from "../lib/sessao.js";
import { assinarMfaToken, verificarMfaToken } from "../lib/tokens.js";
import { novoSegredoBase32, qrCodeDataUrl, validarCodigo } from "../lib/totp.js";

const ipDe = (ip: string | undefined) => ip || "desconhecido";

/* ------------------------------ Rotas públicas (login, MFA, refresh) ------------------------------ */

export const authRoutes =
  ({ config, db, externos }: Deps): FastifyPluginAsync =>
  async (app) => {
    const registrarAcesso = async (p: {
      usuarioId: string | null;
      email: string;
      tenantId: string | null;
      ip: string;
      sucesso: boolean;
    }) => {
      const r = await db.query<{ id: string }>(
        `INSERT INTO log_acessos (usuario_id, email_tentado, tenant_id, ip, sucesso)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [p.usuarioId, p.email.toLowerCase(), p.tenantId, p.ip, p.sucesso],
      );
      const id = r.rows[0]?.id;
      // A geolocalização é consultada fora do caminho crítico do login.
      void externos
        .geolocalizarIp(p.ip)
        .then((pais) => (pais && id ? db.query("UPDATE log_acessos SET pais_regiao = $1 WHERE id = $2", [pais, id]) : undefined))
        .catch(() => undefined);
    };

    app.post("/auth/login", async (req) => {
      const body = z
        .object({
          email: z.string().trim().toLowerCase().email().max(255),
          senha: z.string().min(1).max(200),
          captchaToken: z.string().max(4000).nullish(),
        })
        .parse(req.body);
      const ip = ipDe(req.ip);

      await limitarTentativas(db, `login:${ip}`, 30, 60_000, "Muitas tentativas seguidas. Aguarde um minuto e tente novamente.");

      const captcha = await externos.verificarCaptcha(body.captchaToken, "login");
      if (!captcha.ok) throw new HttpError(403, AVISO_CAPTCHA);

      const bloqueio = await verificarBloqueioLogin(db, body.email, ip);
      if (bloqueio.bloqueado) {
        throw locked(`Acesso temporariamente bloqueado. Tente novamente em ${bloqueio.minutosRestantes} min.`, {
          bloqueado: true,
          minutosRestantes: bloqueio.minutosRestantes,
        });
      }

      const u = (
        await db.query<{ id: string; email: string; senha_hash: string; ativo: boolean | null; tenant_id: string | null }>(
          `SELECT u.id, u.email, u.senha_hash, p.ativo, p.tenant_id
             FROM usuarios u LEFT JOIN usuarios_perfil p ON p.id = u.id
            WHERE lower(u.email) = $1`,
          [body.email],
        )
      ).rows[0];

      // Sempre compara contra um hash para não revelar (pelo tempo) se o e-mail existe.
      const senhaOk = await verificarSenha(body.senha, u?.senha_hash ?? (await hashSenhaFalso()));
      if (!u || !senhaOk || !u.ativo) {
        await registrarAcesso({ usuarioId: u?.id ?? null, email: body.email, tenantId: u?.tenant_id ?? null, ip, sucesso: false });
        throw unauthorized("E-mail ou senha inválidos.");
      }
      await registrarAcesso({ usuarioId: u.id, email: body.email, tenantId: u.tenant_id, ip, sucesso: true });
      // Usuários migrados do Supabase (bcrypt): troca para scrypt agora que a senha em texto está disponível.
      if (ehHashLegado(u.senha_hash)) {
        await db.query("UPDATE usuarios SET senha_hash = $1 WHERE id = $2", [await hashSenha(body.senha), u.id]);
      }

      const fator = (
        await db.query<{ id: string }>(
          "SELECT id FROM mfa_fatores WHERE usuario_id = $1 AND status = 'verified' ORDER BY created_at LIMIT 1",
          [u.id],
        )
      ).rows[0];
      if (fator) {
        const mfaToken = await assinarMfaToken(config.JWT_REFRESH_SECRET, { sub: u.id, factorId: fator.id });
        return { mfaRequired: true, mfaToken, factorId: fator.id };
      }

      await db.query("UPDATE usuarios SET ultimo_login_em = now() WHERE id = $1", [u.id]);
      return emitirSessao(db, config, { id: u.id, email: u.email }, { ip, userAgent: req.headers["user-agent"] ?? null });
    });

    app.post("/auth/mfa/verify", async (req) => {
      const body = z
        .object({ mfaToken: z.string().max(4000), factorId: z.string().uuid(), code: z.string().max(12) })
        .parse(req.body);
      const ip = ipDe(req.ip);
      await limitarTentativas(db, `mfa:${ip}`, 10, 60_000, "Muitas tentativas seguidas. Aguarde um minuto.");

      const invalido = () => unauthorized("Código inválido ou expirado.");
      const claims = await verificarMfaToken(config.JWT_REFRESH_SECRET, body.mfaToken).catch(() => {
        throw invalido();
      });
      if (claims.factorId !== body.factorId) throw invalido();
      await limitarTentativas(db, `mfa-user:${claims.sub}`, 10, 5 * 60_000, "Muitas tentativas seguidas. Aguarde alguns minutos.");

      const fator = (
        await db.query<{ segredo_cifrado: string; ultimo_passo: number }>(
          "SELECT segredo_cifrado, ultimo_passo FROM mfa_fatores WHERE id = $1 AND usuario_id = $2 AND status = 'verified'",
          [body.factorId, claims.sub],
        )
      ).rows[0];
      if (!fator) throw invalido();

      const v = validarCodigo(decifrar(fator.segredo_cifrado, chaveMfa(config)), body.code.replace(/\D/g, ""), Number(fator.ultimo_passo));
      if (!v.ok) throw invalido();
      const consumido = await db.query("UPDATE mfa_fatores SET ultimo_passo = $1 WHERE id = $2 AND ultimo_passo < $1", [v.passo, body.factorId]);
      if (consumido.rowCount === 0) throw invalido();

      const perfil = await perfilDe(db, claims.sub);
      if (!perfil || !perfil.ativo) throw unauthorized("Sessão inválida.");
      await db.query("UPDATE usuarios SET ultimo_login_em = now() WHERE id = $1", [claims.sub]);
      const email = (await db.query<{ email: string }>("SELECT email FROM usuarios WHERE id = $1", [claims.sub])).rows[0]?.email ?? "";
      return emitirSessao(db, config, { id: claims.sub, email }, { ip, userAgent: req.headers["user-agent"] ?? null });
    });

    app.post("/auth/refresh", async (req) => {
      const body = z.object({ refreshToken: z.string().min(10).max(500) }).parse(req.body);
      const ip = ipDe(req.ip);
      await limitarTentativas(db, `refresh:${ip}`, 120, 60_000, "Muitas requisições. Aguarde um instante.");
      return renovarSessao(db, config, body.refreshToken, { ip, userAgent: req.headers["user-agent"] ?? null });
    });

    app.post("/auth/logout", async (req, reply) => {
      const body = z.object({ refreshToken: z.string().max(500).optional() }).parse(req.body ?? {});
      if (body.refreshToken) await revogarRefresh(db, config, body.refreshToken);
      return reply.code(204).send();
    });
  };

/* ------------------------------------- Rotas protegidas ------------------------------------- */

export const authProtegidas =
  ({ config, db }: Deps): FastifyPluginAsync =>
  async (app) => {
    app.get("/auth/me", async (req) => {
      await exigirPerfilAtivo(db, req.auth.userId);
      return { id: req.auth.userId, email: req.auth.email };
    });

    app.get("/auth/mfa/factors", async (req) => {
      const r = await db.query(
        "SELECT id, status, friendly_name FROM mfa_fatores WHERE usuario_id = $1 ORDER BY created_at",
        [req.auth.userId],
      );
      return r.rows;
    });

    app.post("/auth/mfa/enroll", async (req) => {
      const body = z.object({ friendlyName: z.string().trim().max(80).optional() }).parse(req.body ?? {});
      await exigirPerfilAtivo(db, req.auth.userId);
      const segredo = novoSegredoBase32();
      const id = await db.tx(async (q) => {
        // Cadastros abandonados (não confirmados) são descartados.
        await q.query("DELETE FROM mfa_fatores WHERE usuario_id = $1 AND status = 'unverified'", [req.auth.userId]);
        const r = await q.query<{ id: string }>(
          "INSERT INTO mfa_fatores (usuario_id, friendly_name, segredo_cifrado) VALUES ($1, $2, $3) RETURNING id",
          [req.auth.userId, body.friendlyName ?? null, cifrar(segredo, chaveMfa(config))],
        );
        return r.rows[0]!.id;
      });
      return { id, qr: await qrCodeDataUrl(segredo, req.auth.email), secret: segredo };
    });

    app.post("/auth/mfa/enroll/confirm", async (req) => {
      const body = z.object({ factorId: z.string().uuid(), code: z.string().max(12) }).parse(req.body);
      await limitarTentativas(db, `mfa-user:${req.auth.userId}`, 10, 5 * 60_000, "Muitas tentativas seguidas. Aguarde alguns minutos.");
      const fator = (
        await db.query<{ segredo_cifrado: string; ultimo_passo: number }>(
          "SELECT segredo_cifrado, ultimo_passo FROM mfa_fatores WHERE id = $1 AND usuario_id = $2 AND status = 'unverified'",
          [body.factorId, req.auth.userId],
        )
      ).rows[0];
      const invalido = () => new HttpError(401, "Código inválido ou expirado.");
      if (!fator) throw invalido();
      const v = validarCodigo(decifrar(fator.segredo_cifrado, chaveMfa(config)), body.code.replace(/\D/g, ""), 0);
      if (!v.ok) throw invalido();
      await db.query("UPDATE mfa_fatores SET status = 'verified', ultimo_passo = $1 WHERE id = $2", [v.passo, body.factorId]);
      return { ok: true as const };
    });

    app.delete<{ Params: { id: string } }>("/auth/mfa/factors/:id", async (req) => {
      const id = z.string().uuid().parse(req.params.id);
      await db.query("DELETE FROM mfa_fatores WHERE id = $1 AND usuario_id = $2", [id, req.auth.userId]);
      return { ok: true as const };
    });
  };
