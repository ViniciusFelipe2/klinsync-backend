import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { perfilDe, type Perfil } from "../lib/perfil.js";

type FeatureLinha = { id: string; chave: string; nome_exibicao: string };

const ROTAS_POR_FEATURE: Record<string, string> = {
  checkin_cirurgioes: "/check-in",
  giro_de_sala: "/giro-sala",
};

export const sessaoRoutes =
  ({ db }: Deps): FastifyPluginAsync =>
  async (app) => {
    /** Features habilitadas do hospital (para o perfil do chamador). */
    const featuresHabilitadas = async (perfil: Perfil): Promise<FeatureLinha[]> => {
      if (!perfil.tenant_id) return [];
      const r = await db.query<FeatureLinha>(
        `SELECT f.id, f.chave, f.nome_exibicao
           FROM tenant_features tf JOIN features f ON f.id = tf.feature_id
          WHERE tf.tenant_id = $1 AND tf.habilitada
          ORDER BY f.nome_exibicao`,
        [perfil.tenant_id],
      );
      return perfil.role === "hospital_admin" ? r.rows : r.rows.filter((f) => f.id === perfil.feature_id);
    };

    app.get("/sessao", async (req) => {
      const perfil = await perfilDe(db, req.auth.userId);
      if (!perfil || !perfil.ativo) return { perfil: null, tenant: null, features: [] };
      const tenant = perfil.tenant_id
        ? ((await db.query("SELECT * FROM tenants WHERE id = $1", [perfil.tenant_id])).rows[0] ?? null)
        : null;
      const features = (await featuresHabilitadas(perfil)).map((f) => ({ id: f.id, chave: f.chave, nome: f.nome_exibicao }));
      return { perfil, tenant, features };
    });

    /** O servidor decide o destino inicial por papel; o cliente só navega para a rota recebida. */
    app.get("/sessao/destino-inicial", async (req) => {
      const perfil = await perfilDe(db, req.auth.userId);
      if (!perfil || !perfil.ativo) return { destino: null };
      if (perfil.role === "master_admin") return { destino: "/master" };
      if (perfil.role === "hospital_admin") return { destino: "/hospital" };
      const feature = (await featuresHabilitadas(perfil))[0];
      const destino = (feature && ROTAS_POR_FEATURE[feature.chave]) || "/operacional";
      return { destino };
    });

    app.post("/modulos/acesso", async (req) => {
      const { chave } = z.object({ chave: z.string().min(2) }).parse(req.body);
      const perfil = await perfilDe(db, req.auth.userId);

      const negado = {
        permitido: false as boolean,
        motivo: "sem_acesso" as "ok" | "sem_acesso" | "feature_nao_contratada" | "hospital_inativo",
        nome: null as string | null,
        role: perfil?.role ?? null,
        tenantId: null as string | null,
        tenantNome: null as string | null,
        featureNome: null as string | null,
        podeAdministrar: false,
      };
      if (!perfil || !perfil.ativo) return negado;

      const feature = (
        await db.query<FeatureLinha>("SELECT id, chave, nome_exibicao FROM features WHERE chave = $1", [chave])
      ).rows[0];
      if (!feature) return negado;

      if (perfil.role === "master_admin") {
        return {
          permitido: true,
          motivo: "ok" as const,
          nome: perfil.nome,
          role: perfil.role,
          tenantId: null,
          tenantNome: "Suporte Trizion",
          featureNome: feature.nome_exibicao,
          podeAdministrar: true,
        };
      }
      if (!perfil.tenant_id) return negado;

      const tf = (
        await db.query<{ habilitada: boolean }>(
          "SELECT habilitada FROM tenant_features WHERE tenant_id = $1 AND feature_id = $2",
          [perfil.tenant_id, feature.id],
        )
      ).rows[0];
      if (!tf?.habilitada) return { ...negado, motivo: "feature_nao_contratada" as const };
      if (perfil.role === "operador" && perfil.feature_id !== feature.id) return negado;

      const tenant = (
        await db.query<{ id: string; nome: string; status: string }>("SELECT id, nome, status FROM tenants WHERE id = $1", [
          perfil.tenant_id,
        ])
      ).rows[0];
      if (!tenant || tenant.status !== "ativo") return { ...negado, motivo: "hospital_inativo" as const };

      return {
        permitido: true,
        motivo: "ok" as const,
        nome: perfil.nome,
        role: perfil.role,
        tenantId: tenant.id,
        tenantNome: tenant.nome,
        featureNome: feature.nome_exibicao,
        podeAdministrar: perfil.role === "hospital_admin",
      };
    });

    /** Nomes da equipe do próprio hospital (id -> nome). */
    app.get("/modulos/equipe-nomes", async (req) => {
      const perfil = await perfilDe(db, req.auth.userId);
      if (!perfil || !perfil.ativo || !perfil.tenant_id) return [];
      const r = await db.query("SELECT id, nome FROM usuarios_perfil WHERE tenant_id = $1", [perfil.tenant_id]);
      return r.rows;
    });
  };
