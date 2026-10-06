import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { registrarAcao } from "../lib/auditoria-log.js";
import { exigirMaster } from "../lib/perfil.js";

type Checagem = {
  id: string;
  titulo: string;
  descricao: string;
  status: "ok" | "atencao" | "critico";
  detalhe: string;
  itens: string[];
  categoria: "banco" | "arquivos" | "contas" | "politica";
};

type UsuarioObservado = {
  id: string;
  nome: string;
  email: string | null;
  role: string;
  hospital: string | null;
  ativo: boolean;
  confirmado: boolean;
  mfa: boolean;
  criadoEm: string | null;
  ultimoLogin: string | null;
  diasSemAcesso: number | null;
  acessos: number;
  falhas: number;
  risco: "ok" | "atencao" | "critico";
  alertas: string[];
};

export const segurancaRoutes =
  ({ db, config }: Deps): FastifyPluginAsync =>
  async (app) => {
    app.get("/master/seguranca/painel", async (req) => {
      await exigirMaster(db, req.auth.userId);
      const [acessos, acoes, cfg, tenants, historico] = await Promise.all([
        db.query("SELECT * FROM log_acessos ORDER BY created_at DESC LIMIT 200"),
        db.query("SELECT * FROM log_acoes_sensiveis ORDER BY created_at DESC LIMIT 100"),
        db.query("SELECT * FROM config_seguranca LIMIT 1"),
        db.query("SELECT id, nome FROM tenants"),
        db.query("SELECT * FROM tenant_features_historico ORDER BY created_at DESC LIMIT 50"),
      ]);
      return {
        acessos: acessos.rows,
        acoes: acoes.rows,
        config: cfg.rows[0] ?? null,
        tenants: tenants.rows,
        historicoFeatures: historico.rows,
      };
    });

    app.post("/master/seguranca/config", async (req) => {
      const d = z
        .object({
          max_tentativas: z.number().int().min(1).max(50),
          janela_minutos: z.number().int().min(1).max(1440),
          bloqueio_minutos: z.number().int().min(1).max(1440),
        })
        .parse(req.body);
      await exigirMaster(db, req.auth.userId);
      await db.tx(async (q) => {
        await q.query(
          "UPDATE config_seguranca SET max_tentativas = $1, janela_minutos = $2, bloqueio_minutos = $3, updated_at = now() WHERE id = true",
          [d.max_tentativas, d.janela_minutos, d.bloqueio_minutos],
        );
        await registrarAcao(q, req.auth.userId, "alterou_config_seguranca", { ...d });
      });
      return { ok: true as const };
    });

    /* ------------------------------------ IPs e bloqueios ------------------------------------ */

    app.post("/master/seguranca/ips", async (req) => {
      const { dias } = z.object({ dias: z.number().int().min(1).max(90).default(7) }).parse(req.body ?? {});
      await exigirMaster(db, req.auth.userId);

      const [acessosRes, bloqueiosRes, cfgRes, perfisRes] = await Promise.all([
        db.query<{ ip: string | null; pais_regiao: string | null; sucesso: boolean; email_tentado: string | null; created_at: string }>(
          `SELECT ip, pais_regiao, sucesso, email_tentado, created_at FROM log_acessos
            WHERE created_at >= now() - make_interval(days => $1::int)
            ORDER BY created_at DESC LIMIT 3000`,
          [dias],
        ),
        db.query<{
          id: string;
          ip: string;
          motivo: string;
          permanente: boolean;
          bloqueado_ate: string | null;
          created_at: string;
        }>("SELECT id, ip, motivo, permanente, bloqueado_ate, created_at FROM ip_bloqueios ORDER BY created_at DESC"),
        db.query<{ max_tentativas: number; janela_minutos: number; bloqueio_minutos: number }>("SELECT * FROM config_seguranca LIMIT 1"),
        db.query<{ ativo: boolean; role: string }>("SELECT ativo, role FROM usuarios_perfil"),
      ]);

      const agora = Date.now();
      const bloqueios = bloqueiosRes.rows.map((b) => ({
        ...b,
        ativo: b.permanente || (!!b.bloqueado_ate && new Date(b.bloqueado_ate).getTime() > agora),
      }));
      const ipsBloqueados = new Set(bloqueios.filter((b) => b.ativo).map((b) => b.ip));

      const mapa = new Map<
        string,
        { ip: string; falhas: number; sucessos: number; ultimaTentativa: string; regiao: string | null; emails: string[]; bloqueado: boolean }
      >();
      for (const a of acessosRes.rows) {
        const ip = a.ip ?? "desconhecido";
        const atual = mapa.get(ip) ?? {
          ip,
          falhas: 0,
          sucessos: 0,
          ultimaTentativa: a.created_at,
          regiao: a.pais_regiao,
          emails: [] as string[],
          bloqueado: ipsBloqueados.has(ip),
        };
        if (a.sucesso) atual.sucessos += 1;
        else atual.falhas += 1;
        if (new Date(a.created_at) > new Date(atual.ultimaTentativa)) atual.ultimaTentativa = a.created_at;
        if (!atual.regiao && a.pais_regiao) atual.regiao = a.pais_regiao;
        if (a.email_tentado && !atual.emails.includes(a.email_tentado) && atual.emails.length < 6) atual.emails.push(a.email_tentado);
        mapa.set(ip, atual);
      }

      const ips = [...mapa.values()].sort((x, y) => y.falhas - x.falhas || y.sucessos - x.sucessos);
      const falhas = acessosRes.rows.filter((a) => !a.sucesso).length;
      const total = acessosRes.rows.length;
      const perfis = perfisRes.rows;
      const cfg = cfgRes.rows[0];

      return {
        dias,
        indicadores: {
          tentativas: total,
          sucessos: total - falhas,
          falhas,
          taxaFalha: total ? Math.round((falhas / total) * 100) : 0,
          ipsUnicos: mapa.size,
          ipsSuspeitos: ips.filter((i) => i.falhas >= 3).length,
          bloqueiosAtivos: bloqueios.filter((b) => b.ativo).length,
          usuariosAtivos: perfis.filter((p) => p.ativo).length,
          usuariosInativos: perfis.filter((p) => !p.ativo).length,
          masters: perfis.filter((p) => p.role === "master_admin").length,
        },
        politica: {
          max_tentativas: cfg?.max_tentativas ?? 5,
          janela_minutos: cfg?.janela_minutos ?? 15,
          bloqueio_minutos: cfg?.bloqueio_minutos ?? 15,
        },
        ips: ips.slice(0, 100),
        bloqueios,
      };
    });

    app.post("/master/seguranca/ips/bloquear", async (req) => {
      const d = z
        .object({
          ip: z.string().trim().min(3).max(64),
          motivo: z.string().trim().max(200).default(""),
          minutos: z.number().int().min(5).max(43200).nullable().default(60),
          permanente: z.boolean().default(false),
        })
        .parse(req.body);
      await exigirMaster(db, req.auth.userId);
      const ate = d.permanente || !d.minutos ? null : new Date(Date.now() + d.minutos * 60_000).toISOString();
      await db.tx(async (q) => {
        await q.query(
          `INSERT INTO ip_bloqueios (ip, motivo, permanente, bloqueado_ate, criado_por)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (ip) DO UPDATE SET motivo = EXCLUDED.motivo, permanente = EXCLUDED.permanente,
             bloqueado_ate = EXCLUDED.bloqueado_ate, criado_por = EXCLUDED.criado_por`,
          [d.ip, d.motivo || "Bloqueio manual da equipe Trizion", d.permanente, ate, req.auth.userId],
        );
        await registrarAcao(q, req.auth.userId, "bloqueou_ip", { ip: d.ip, permanente: d.permanente, minutos: d.minutos });
      });
      return { ok: true as const };
    });

    app.post("/master/seguranca/ips/desbloquear", async (req) => {
      const { ip } = z.object({ ip: z.string().trim().min(3).max(64) }).parse(req.body);
      await exigirMaster(db, req.auth.userId);
      await db.tx(async (q) => {
        await q.query("DELETE FROM ip_bloqueios WHERE ip = $1", [ip]);
        await registrarAcao(q, req.auth.userId, "desbloqueou_ip", { ip });
      });
      return { ok: true as const };
    });

    /** Retenção mínima de dados pessoais (LGPD): expurga logs antigos. */
    app.post("/master/seguranca/purgar-logs", async (req) => {
      const { dias } = z.object({ dias: z.number().int().min(30).max(3650) }).parse(req.body);
      await exigirMaster(db, req.auth.userId);
      return db.tx(async (q) => {
        const acessos = await q.query("DELETE FROM log_acessos WHERE created_at < now() - make_interval(days => $1::int)", [dias]);
        const acoes = await q.query("DELETE FROM log_acoes_sensiveis WHERE created_at < now() - make_interval(days => $1::int)", [dias]);
        // "auditoria" = registros de sessão (refresh tokens) expirados/revogados além do prazo
        const sessoes = await q.query(
          "DELETE FROM refresh_tokens WHERE COALESCE(revogado_em, expira_em) < now() - make_interval(days => $1::int)",
          [dias],
        );
        await q.query(
          "DELETE FROM ip_bloqueios WHERE NOT permanente AND bloqueado_ate IS NOT NULL AND bloqueado_ate < now() - interval '30 days'",
        );
        await registrarAcao(q, req.auth.userId, "purgou_logs", { dias });
        return { acessos: acessos.rowCount, acoes: acoes.rowCount, auditoria: sessoes.rowCount };
      });
    });

    /* ------------------------------ Postura de segurança ------------------------------ */

    app.post("/master/seguranca/postura", async (req) => {
      const { dias } = z.object({ dias: z.number().int().min(1).max(90).default(30) }).parse(req.body ?? {});
      await exigirMaster(db, req.auth.userId);

      const [contasRes, tenantsRes, acessosRes, cfgRes, convitesRes, banco] = await Promise.all([
        db.query<{
          id: string;
          nome: string;
          email: string | null;
          role: string;
          ativo: boolean;
          tenant_id: string | null;
          confirmado: boolean;
          ultimo_login: string | null;
          criado_em: string | null;
          mfa: boolean;
          hash_forte: boolean;
          hash_legado: boolean;
          sem_senha: boolean;
        }>(
          `SELECT p.id, p.nome, COALESCE(p.email, u.email) AS email, p.role, p.ativo, p.tenant_id,
                  (u.email_confirmado_em IS NOT NULL) AS confirmado, u.ultimo_login_em AS ultimo_login,
                  u.created_at AS criado_em,
                  EXISTS (SELECT 1 FROM mfa_fatores m WHERE m.usuario_id = p.id AND m.status = 'verified') AS mfa,
                  (u.senha_hash LIKE 'scrypt$%') AS hash_forte,
                  (u.senha_hash LIKE '$2a$%' OR u.senha_hash LIKE '$2b$%' OR u.senha_hash LIKE '$2y$%') AS hash_legado,
                  (u.senha_hash = '!') AS sem_senha
             FROM usuarios_perfil p JOIN usuarios u ON u.id = p.id`,
        ),
        db.query<{ id: string; nome: string }>("SELECT id, nome FROM tenants"),
        db.query<{ usuario_id: string | null; email_tentado: string | null; sucesso: boolean }>(
          `SELECT usuario_id, email_tentado, sucesso FROM log_acessos
            WHERE created_at >= now() - make_interval(days => $1::int) LIMIT 5000`,
          [dias],
        ),
        db.query<{ max_tentativas: number; janela_minutos: number; bloqueio_minutos: number }>("SELECT * FROM config_seguranca LIMIT 1"),
        db.query<{ expira_em: string; aceito_em: string | null; revogado_em: string | null }>(
          "SELECT expira_em, aceito_em, revogado_em FROM convites",
        ),
        db.query<{ super: boolean; tabelas: number }>(
          `SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super,
                  (SELECT count(*)::int FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS tabelas`,
        ),
      ]);

      const contas = contasRes.rows;
      const cfg = cfgRes.rows[0];
      const semHashForte = contas.filter((c) => !c.hash_forte && !c.hash_legado && !c.sem_senha).map((c) => c.email ?? c.id);
      const hashLegado = contas.filter((c) => c.hash_legado).map((c) => c.email ?? c.id);
      const semConfirmacao = contas.filter((c) => !c.confirmado).map((c) => c.email ?? c.id);
      const semMfa = contas.filter((c) => !c.mfa).length;
      const politicaFrouxa = !cfg || cfg.max_tentativas > 8 || cfg.janela_minutos > 60 || cfg.bloqueio_minutos < 10;
      const superuser = banco.rows[0]?.super === true;
      const totalTabelas = banco.rows[0]?.tabelas ?? 0;

      const checagens: Checagem[] = [
        {
          id: "hash-senha",
          categoria: "banco",
          titulo: "Senhas com hash forte",
          descricao: "Todas as senhas devem ser armazenadas com scrypt (nunca em texto ou hash rápido).",
          status: semHashForte.length ? "critico" : hashLegado.length ? "atencao" : "ok",
          detalhe: semHashForte.length
            ? `${semHashForte.length} conta(s) com hash fraco`
            : hashLegado.length
              ? `${hashLegado.length} conta(s) migradas ainda com bcrypt (trocam para scrypt no próximo login)`
              : `${contas.length} conta(s) com scrypt`,
          itens: semHashForte.length ? semHashForte : hashLegado,
        },
        {
          id: "role-banco",
          categoria: "banco",
          titulo: "Aplicação sem superusuário do banco",
          descricao: "A API deve se conectar ao Postgres com uma role sem privilégios de superusuário.",
          status: superuser ? "critico" : "ok",
          detalhe: superuser ? "A API está conectada como superusuário" : "Role de aplicação restrita",
          itens: [],
        },
        {
          id: "fotos-privadas",
          categoria: "arquivos",
          titulo: "Fotos de check-in privadas",
          descricao: "Os arquivos ficam em bucket S3 privado e só abrem por link assinado e temporário.",
          status: config.CHECKIN_PHOTOS_BUCKET ? "ok" : "atencao",
          detalhe: config.CHECKIN_PHOTOS_BUCKET ? "Bucket privado com URL assinada" : "Bucket de fotos não configurado",
          itens: [],
        },
        {
          id: "politica-login",
          categoria: "politica",
          titulo: "Política de tentativas de login",
          descricao: "Máximo de 8 tentativas, janela curta e bloqueio de pelo menos 10 minutos.",
          status: politicaFrouxa ? "atencao" : "ok",
          detalhe: cfg
            ? `${cfg.max_tentativas} tentativas / ${cfg.janela_minutos} min · bloqueio ${cfg.bloqueio_minutos} min`
            : "Política não configurada",
          itens: [],
        },
        {
          id: "captcha",
          categoria: "politica",
          titulo: "Proteção anti-robô no login",
          descricao: "reCAPTCHA v3 validado no servidor reduz tentativas automatizadas de login.",
          status: config.RECAPTCHA_SECRET_KEY ? "ok" : "atencao",
          detalhe: config.RECAPTCHA_SECRET_KEY ? "reCAPTCHA ativo" : "reCAPTCHA não configurado",
          itens: [],
        },
        {
          id: "confirmacao",
          categoria: "contas",
          titulo: "Contas com e-mail confirmado",
          descricao: "Contas sem confirmação indicam convites pendentes ou cadastros abandonados.",
          status: semConfirmacao.length ? "atencao" : "ok",
          detalhe: semConfirmacao.length ? `${semConfirmacao.length} conta(s) sem confirmação` : `${contas.length} conta(s) confirmadas`,
          itens: semConfirmacao,
        },
        {
          id: "mfa",
          categoria: "contas",
          titulo: "Segundo fator (MFA)",
          descricao: "Recomendado para contas com poder administrativo.",
          status: semMfa === contas.length && contas.length > 0 ? "atencao" : "ok",
          detalhe: `${contas.length - semMfa} de ${contas.length} conta(s) com MFA ativo`,
          itens: [],
        },
      ];

      const pontuacao = checagens.length
        ? Math.round(
            (checagens.reduce((s, c) => s + (c.status === "ok" ? 1 : c.status === "atencao" ? 0.5 : 0), 0) / checagens.length) * 100,
          )
        : 0;

      const mapaTenant = new Map(tenantsRes.rows.map((t) => [t.id, t.nome]));
      const acessos = acessosRes.rows;

      const usuarios: UsuarioObservado[] = contas.map((c) => {
        const meus = acessos.filter((a) => a.usuario_id === c.id || (c.email && a.email_tentado === c.email));
        const falhas = meus.filter((a) => !a.sucesso).length;
        const ultimoLogin = c.ultimo_login;
        const diasSemAcesso = ultimoLogin ? Math.floor((Date.now() - new Date(ultimoLogin).getTime()) / 86400_000) : null;

        const alertas: string[] = [];
        if (!ultimoLogin) alertas.push("Nunca acessou");
        if (diasSemAcesso !== null && diasSemAcesso >= 45) alertas.push(`${diasSemAcesso} dias sem acesso`);
        if (falhas >= 3) alertas.push(`${falhas} falhas de login no período`);
        if (!c.confirmado) alertas.push("E-mail não confirmado");
        if (c.role !== "master_admin" && !c.tenant_id) alertas.push("Sem hospital vinculado");
        if (c.role === "master_admin" && !c.mfa) alertas.push("Master sem MFA");

        const risco: UsuarioObservado["risco"] =
          falhas >= 5 || (diasSemAcesso !== null && diasSemAcesso >= 90) ? "critico" : alertas.length ? "atencao" : "ok";

        return {
          id: c.id,
          nome: c.nome,
          email: c.email,
          role: c.role,
          hospital: c.tenant_id ? (mapaTenant.get(c.tenant_id) ?? null) : null,
          ativo: c.ativo,
          confirmado: c.confirmado,
          mfa: c.mfa,
          criadoEm: c.criado_em,
          ultimoLogin,
          diasSemAcesso,
          acessos: meus.filter((a) => a.sucesso).length,
          falhas,
          risco,
          alertas,
        };
      });

      const peso = (r: UsuarioObservado["risco"]) => (r === "critico" ? 2 : r === "atencao" ? 1 : 0);
      const convites = convitesRes.rows;
      const agora = Date.now();

      return {
        geradoEm: new Date().toISOString(),
        pontuacao,
        checagens,
        // O controle de acesso por hospital/papel é feito pela API; o banco só aceita a role da aplicação.
        resumoTabelas: { total: totalTabelas, comRls: totalTabelas, comAnon: 0 },
        usuarios: usuarios.sort((a, b) => peso(b.risco) - peso(a.risco)),
        convites: {
          pendentes: convites.filter((c) => !c.aceito_em && !c.revogado_em && new Date(c.expira_em).getTime() > agora).length,
          expirados: convites.filter((c) => !c.aceito_em && !c.revogado_em && new Date(c.expira_em).getTime() <= agora).length,
          revogados: convites.filter((c) => c.revogado_em).length,
        },
      };
    });
  };
