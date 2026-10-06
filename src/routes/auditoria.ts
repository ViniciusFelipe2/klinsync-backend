import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { forbidden } from "../errors.js";
import { exigirPerfilAtivo } from "../lib/perfil.js";

type EventoAuditoria = {
  id: string;
  tipo: "acesso" | "acao" | "feature";
  quando: string;
  titulo: string;
  detalhe: string;
  autor: string | null;
  hospital: string | null;
  sucesso: boolean | null;
  ip: string | null;
  regiao: string | null;
};

const ROTULO_ACAO: Record<string, string> = {
  criou_hospital: "Cadastrou hospital",
  atualizou_hospital: "Atualizou hospital",
  alterou_feature_flag: "Alterou feature do hospital",
  criou_usuario: "Criou usuário",
  criou_usuario_operacional: "Criou login operacional",
  resetou_senha: "Redefiniu senha",
  ativou_usuario: "Ativou usuário",
  desativou_usuario: "Desativou usuário",
  alterou_config_seguranca: "Alterou política de segurança",
  criou_convite: "Gerou convite",
  regerou_convite: "Gerou novo link de convite",
  revogou_convite: "Revogou convite",
  aceitou_convite: "Aceitou convite",
  bloqueou_ip: "Bloqueou IP",
  desbloqueou_ip: "Liberou IP",
  purgou_logs: "Expurgou logs antigos (LGPD)",
};

export const auditoriaRoutes =
  ({ db }: Deps): FastifyPluginAsync =>
  async (app) => {
    app.post("/auditoria", async (req) => {
      const { dias } = z.object({ dias: z.number().int().min(1).max(365).default(30) }).parse(req.body ?? {});
      const perfil = await exigirPerfilAtivo(db, req.auth.userId);
      const master = perfil.role === "master_admin";
      if (!master && perfil.role !== "hospital_admin") throw forbidden("Sem permissão para ver a auditoria.");

      const [perfis, tenants, features, acessos, acoes, historico] = await Promise.all([
        db.query<{ id: string; nome: string; email: string | null; tenant_id: string | null }>(
          "SELECT id, nome, email, tenant_id FROM usuarios_perfil",
        ),
        db.query<{ id: string; nome: string }>("SELECT id, nome FROM tenants"),
        db.query<{ id: string; nome_exibicao: string }>("SELECT id, nome_exibicao FROM features"),
        db.query<{
          id: string;
          usuario_id: string | null;
          email_tentado: string | null;
          tenant_id: string | null;
          ip: string | null;
          pais_regiao: string | null;
          sucesso: boolean;
          created_at: string;
        }>(
          `SELECT * FROM log_acessos WHERE created_at >= now() - make_interval(days => $1::int)
           ORDER BY created_at DESC LIMIT 500`,
          [dias],
        ),
        db.query<{ id: string; usuario_id: string | null; acao: string; detalhes: Record<string, unknown>; created_at: string }>(
          `SELECT * FROM log_acoes_sensiveis WHERE created_at >= now() - make_interval(days => $1::int)
           ORDER BY created_at DESC LIMIT 500`,
          [dias],
        ),
        db.query<{ id: string; tenant_id: string; feature_id: string; habilitada: boolean; alterado_por: string | null; created_at: string }>(
          `SELECT * FROM tenant_features_historico WHERE created_at >= now() - make_interval(days => $1::int)
           ORDER BY created_at DESC LIMIT 300`,
          [dias],
        ),
      ]);

      const mapaPerfil = new Map(perfis.rows.map((p) => [p.id, p]));
      const mapaTenant = new Map(tenants.rows.map((t) => [t.id, t.nome]));
      const mapaFeature = new Map(features.rows.map((f) => [f.id, f.nome_exibicao]));

      const nomeDe = (id: string | null | undefined) => {
        if (!id) return null;
        const p = mapaPerfil.get(id);
        return p ? `${p.nome} (${p.email ?? "sem e-mail"})` : id.slice(0, 8);
      };
      const tenantDe = (id: string | null | undefined) => (id ? (mapaTenant.get(id) ?? null) : null);

      const eventos: EventoAuditoria[] = [];

      for (const a of acessos.rows) {
        eventos.push({
          id: `acesso-${a.id}`,
          tipo: "acesso",
          quando: a.created_at,
          titulo: a.sucesso ? "Login realizado" : "Falha de login",
          detalhe: a.email_tentado ?? nomeDe(a.usuario_id) ?? "desconhecido",
          autor: nomeDe(a.usuario_id) ?? a.email_tentado,
          hospital: tenantDe(a.tenant_id),
          sucesso: a.sucesso,
          ip: a.ip,
          regiao: a.pais_regiao,
        });
      }

      for (const a of acoes.rows) {
        const det = a.detalhes ?? {};
        const tenantId = (det["tenant_id"] as string | undefined) ?? null;
        const featureId = (det["feature_id"] as string | undefined) ?? (det["featureId"] as string | undefined) ?? null;
        const partes: string[] = [];
        if (det["email"]) partes.push(String(det["email"]));
        if (det["nome"]) partes.push(String(det["nome"]));
        if (det["role"]) partes.push(String(det["role"]));
        if (featureId && mapaFeature.get(featureId)) partes.push(mapaFeature.get(featureId)!);
        if (det["habilitada"] !== undefined) partes.push(det["habilitada"] ? "habilitada" : "desabilitada");
        if (det["usuario"]) partes.push(nomeDe(String(det["usuario"])) ?? "");
        eventos.push({
          id: `acao-${a.id}`,
          tipo: "acao",
          quando: a.created_at,
          titulo: ROTULO_ACAO[a.acao] ?? a.acao,
          detalhe: partes.filter(Boolean).join(" · ") || "—",
          autor: nomeDe(a.usuario_id),
          hospital: tenantDe(tenantId ?? (det["tenantId"] as string | undefined) ?? null),
          sucesso: null,
          ip: null,
          regiao: null,
        });
      }

      for (const h of historico.rows) {
        eventos.push({
          id: `feature-${h.id}`,
          tipo: "feature",
          quando: h.created_at,
          titulo: h.habilitada ? "Feature ativada" : "Feature desativada",
          detalhe: mapaFeature.get(h.feature_id) ?? h.feature_id.slice(0, 8),
          autor: nomeDe(h.alterado_por),
          hospital: tenantDe(h.tenant_id),
          sucesso: null,
          ip: null,
          regiao: null,
        });
      }

      const meuHospital = tenantDe(perfil.tenant_id);
      const visiveis = master ? eventos : eventos.filter((e) => e.hospital && e.hospital === meuHospital);
      visiveis.sort((a, b) => new Date(b.quando).getTime() - new Date(a.quando).getTime());

      return {
        eventos: visiveis.slice(0, 800),
        hospitais: master ? tenants.rows.map((t) => t.nome) : [meuHospital].filter((x): x is string => !!x),
      };
    });
  };
