import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { conflict, forbidden, notFound, unauthorized, unprocessable } from "../errors.js";
import { registrarAcao } from "../lib/auditoria-log.js";
import { gerarTokenConvite, sha256Hex } from "../lib/crypto.js";
import { exigirIpLiberado, limitarTentativas } from "../lib/limites.js";
import { exigirPerfilAtivo, type Role } from "../lib/perfil.js";
import { AVISO_SENHA_VAZADA, senhaForte } from "../lib/senha.js";
import { criarUsuarioComPerfil } from "../lib/usuarios.js";

const uuid = z.string().uuid();
const tokenSchema = z.string().trim().regex(/^[A-Za-z0-9]{16,64}$/, "Link inválido.");
const SETE_DIAS_MS = 7 * 86400_000;

type Convite = {
  id: string;
  nome: string;
  email: string;
  role: Role;
  tenant_id: string | null;
  feature_id: string | null;
  expira_em: string;
  aceito_em: string | null;
  revogado_em: string | null;
};

/** O hash do token nunca é enviado ao navegador. */
const COLUNAS_PUBLICAS =
  "id, email, nome, role, tenant_id, feature_id, criado_por, expira_em, aceito_em, aceito_por, revogado_em, revogado_por, created_at, updated_at";

/* ---------------------------- Rotas protegidas (gestão de convites) ---------------------------- */

export const conviteRoutesProtegidas =
  ({ db }: Deps): FastifyPluginAsync =>
  async (app) => {
    app.post("/convites/criar", async (req) => {
      const d = z
        .object({
          nome: z.string().min(2),
          email: z.string().email(),
          role: z.enum(["master_admin", "hospital_admin", "operador"]),
          tenantId: uuid.nullish(),
          featureId: uuid.nullish(),
        })
        .parse(req.body);
      const perfil = await exigirPerfilAtivo(db, req.auth.userId);

      let role: Role = d.role;
      let tenantId: string | null = d.tenantId ?? null;
      let featureId: string | null = d.featureId ?? null;

      if (perfil.role === "hospital_admin") {
        if (role !== "operador") throw forbidden("O administrador do hospital só pode convidar logins operacionais.");
        tenantId = perfil.tenant_id;
      } else if (perfil.role !== "master_admin") {
        throw forbidden("Sem permissão para gerar convites.");
      }

      if (role === "master_admin") {
        tenantId = null;
        featureId = null;
      } else if (!tenantId) {
        throw unprocessable("Selecione o hospital deste convite.");
      }
      if (role !== "operador") featureId = null;
      if (role === "operador" && !featureId) {
        throw unprocessable("Todo login operacional precisa estar vinculado a uma feature.");
      }
      if (role === "operador") {
        const tf = (
          await db.query<{ habilitada: boolean }>(
            "SELECT habilitada FROM tenant_features WHERE tenant_id = $1 AND feature_id = $2",
            [tenantId, featureId],
          )
        ).rows[0];
        if (!tf?.habilitada) throw unprocessable("Esta feature não está habilitada para o hospital.");
      }

      const email = d.email.trim().toLowerCase();
      const jaExiste = await db.query("SELECT 1 FROM usuarios WHERE lower(email) = $1", [email]);
      if (jaExiste.rowCount > 0) throw conflict("Já existe um login com este e-mail.");

      const token = gerarTokenConvite();
      const id = await db.tx(async (q) => {
        // Um convite pendente por e-mail: revoga o anterior antes de criar o novo.
        await q.query(
          `UPDATE convites SET revogado_em = now(), revogado_por = $2
            WHERE lower(email) = $1 AND aceito_em IS NULL AND revogado_em IS NULL`,
          [email, req.auth.userId],
        );
        const r = await q.query<{ id: string }>(
          `INSERT INTO convites (nome, email, role, tenant_id, feature_id, token_hash, criado_por, expira_em)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [d.nome, email, role, tenantId, featureId, sha256Hex(token), req.auth.userId, new Date(Date.now() + SETE_DIAS_MS).toISOString()],
        );
        const novo = r.rows[0]!.id;
        await registrarAcao(q, req.auth.userId, "criou_convite", {
          convite_id: novo,
          email,
          role,
          tenant_id: tenantId,
          feature_id: featureId,
        });
        return novo;
      });
      // O token em texto só existe nesta resposta.
      return { id, token };
    });

    app.get("/convites", async (req) => {
      const perfil = await exigirPerfilAtivo(db, req.auth.userId);
      if (perfil.role !== "master_admin" && perfil.role !== "hospital_admin") throw forbidden("Sem permissão para ver convites.");
      const r =
        perfil.role === "hospital_admin"
          ? await db.query(`SELECT ${COLUNAS_PUBLICAS} FROM convites WHERE tenant_id = $1 ORDER BY created_at DESC`, [perfil.tenant_id])
          : await db.query(`SELECT ${COLUNAS_PUBLICAS} FROM convites ORDER BY created_at DESC`);
      return r.rows;
    });

    /** Convite acessível ao chamador (master: qualquer; hospital_admin: só do seu hospital). */
    const convitePermitido = async (conviteId: string, userId: string) => {
      const perfil = await exigirPerfilAtivo(db, userId);
      const convite = (await db.query<Convite>("SELECT * FROM convites WHERE id = $1", [conviteId])).rows[0];
      if (!convite) throw notFound("Convite não encontrado.");
      if (perfil.role !== "master_admin" && perfil.role !== "hospital_admin") throw forbidden("Sem permissão.");
      if (perfil.role === "hospital_admin" && convite.tenant_id !== perfil.tenant_id) throw forbidden("Convite de outro hospital.");
      if (convite.aceito_em) throw unprocessable("Este convite já foi aceito.");
      return convite;
    };

    app.post("/convites/revogar", async (req) => {
      const { conviteId } = z.object({ conviteId: uuid }).parse(req.body);
      const convite = await convitePermitido(conviteId, req.auth.userId);
      await db.tx(async (q) => {
        await q.query("UPDATE convites SET revogado_em = now(), revogado_por = $2 WHERE id = $1", [conviteId, req.auth.userId]);
        await registrarAcao(q, req.auth.userId, "revogou_convite", { convite_id: conviteId, email: convite.email });
      });
      return { ok: true as const };
    });

    /** Gera um novo token para um convite pendente (o link anterior deixa de valer). */
    app.post("/convites/regerar", async (req) => {
      const { conviteId } = z.object({ conviteId: uuid }).parse(req.body);
      await convitePermitido(conviteId, req.auth.userId);
      const token = gerarTokenConvite();
      await db.tx(async (q) => {
        await q.query(
          `UPDATE convites SET token_hash = $2, expira_em = $3, revogado_em = NULL, revogado_por = NULL WHERE id = $1`,
          [conviteId, sha256Hex(token), new Date(Date.now() + SETE_DIAS_MS).toISOString()],
        );
        await registrarAcao(q, req.auth.userId, "regerou_convite", { convite_id: conviteId });
      });
      return { token };
    });
  };

/* ----------------------------------- Rotas públicas do aceite ----------------------------------- */

export const conviteRoutesPublicas =
  ({ db, externos }: Deps): FastifyPluginAsync =>
  async (app) => {
    app.post("/convites/validar", async (req) => {
      const { token } = z.object({ token: tokenSchema }).parse(req.body);
      const ip = req.ip || "desconhecido";
      await exigirIpLiberado(db, ip);
      await limitarTentativas(db, `convite-validar:${ip}`, 20, 60_000, "Muitas verificações seguidas. Aguarde um minuto.");

      const convite = (await db.query<Convite>("SELECT * FROM convites WHERE token_hash = $1", [sha256Hex(token)])).rows[0];

      // Anti-enumeração: um único motivo genérico para link inexistente, revogado, usado ou expirado.
      if (!convite || convite.revogado_em || convite.aceito_em || new Date(convite.expira_em).getTime() < Date.now()) {
        return { valido: false as const, motivo: "indisponivel" as const };
      }

      const hospital = convite.tenant_id
        ? ((await db.query<{ nome: string }>("SELECT nome FROM tenants WHERE id = $1", [convite.tenant_id])).rows[0]?.nome ?? null)
        : null;
      const feature = convite.feature_id
        ? ((await db.query<{ nome_exibicao: string }>("SELECT nome_exibicao FROM features WHERE id = $1", [convite.feature_id])).rows[0]
            ?.nome_exibicao ?? null)
        : null;

      return { valido: true as const, nome: convite.nome, email: convite.email, role: convite.role, hospital, feature };
    });

    app.post("/convites/aceitar", async (req) => {
      const d = z
        .object({ token: tokenSchema, nome: z.string().trim().min(2).max(120), senha: senhaForte })
        .parse(req.body);
      const ip = req.ip || "desconhecido";
      await exigirIpLiberado(db, ip);
      await limitarTentativas(db, `convite-aceitar:${ip}`, 10, 60_000, "Muitas tentativas seguidas. Aguarde um minuto.");

      if (await externos.senhaFoiVazada(d.senha)) throw unprocessable(AVISO_SENHA_VAZADA);

      return db.tx(async (q) => {
        const convite = (
          await q.query<Convite>("SELECT * FROM convites WHERE token_hash = $1 FOR UPDATE", [sha256Hex(d.token)])
        ).rows[0];
        if (!convite) throw unauthorized("Convite inválido.");
        if (convite.revogado_em) throw unprocessable("Este convite foi revogado.");
        if (convite.aceito_em) throw unprocessable("Este convite já foi utilizado.");
        if (new Date(convite.expira_em).getTime() < Date.now()) throw unprocessable("Este convite expirou. Peça um novo link.");

        const { id } = await criarUsuarioComPerfil(q, {
          email: convite.email,
          senha: d.senha,
          nome: d.nome,
          role: convite.role,
          tenantId: convite.tenant_id,
          featureId: convite.feature_id,
        });
        await q.query("UPDATE convites SET aceito_em = now(), aceito_por = $2 WHERE id = $1", [convite.id, id]);
        await registrarAcao(q, id, "aceitou_convite", {
          convite_id: convite.id,
          email: convite.email,
          role: convite.role,
          tenant_id: convite.tenant_id,
        });
        return { email: convite.email };
      });
    });
  };
