import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import { registrarAcao } from "../lib/auditoria-log.js";
import { hashSenha } from "../lib/crypto.js";
import { exigirMaster } from "../lib/perfil.js";
import { salvarSala } from "../lib/salas.js";
import { AVISO_SENHA_VAZADA, senhaForte } from "../lib/senha.js";
import { revogarTodasDoUsuario } from "../lib/sessao.js";
import { criarUsuarioComPerfil } from "../lib/usuarios.js";

const uuid = z.string().uuid();

export const masterRoutes =
  ({ db, externos }: Deps): FastifyPluginAsync =>
  async (app) => {
    const exigirSenhaNaoVazada = async (senha: string) => {
      if (await externos.senhaFoiVazada(senha)) throw unprocessable(AVISO_SENHA_VAZADA);
    };

    app.get("/master/dashboard", async (req) => {
      await exigirMaster(db, req.auth.userId);
      const [tenants, features, tf, usuarios, acessos] = await Promise.all([
        db.query("SELECT * FROM tenants ORDER BY nome"),
        db.query("SELECT * FROM features ORDER BY nome_exibicao"),
        db.query("SELECT * FROM tenant_features"),
        db.query("SELECT id, nome, email, role, tenant_id, feature_id, ativo FROM usuarios_perfil"),
        db.query("SELECT sucesso, created_at FROM log_acessos WHERE created_at >= now() - interval '7 days'"),
      ]);
      return {
        tenants: tenants.rows,
        features: features.rows,
        tenantFeatures: tf.rows,
        usuarios: usuarios.rows,
        acessos7d: acessos.rows,
      };
    });

    app.post("/master/hospitais/salvar", async (req) => {
      const d = z
        .object({
          id: uuid.nullish(),
          nome: z.string().trim().min(2),
          cnpj: z.string().nullish(),
          endereco: z.string().nullish(),
          contato_nome: z.string().nullish(),
          contato_email: z.string().nullish(),
          contato_telefone: z.string().nullish(),
          status: z.enum(["ativo", "inativo", "inadimplente"]),
          limite_salas: z.number().int().min(1).max(500).nullish(),
        })
        .parse(req.body);
      await exigirMaster(db, req.auth.userId);
      const { id, ...campos } = d;
      const valores = [
        campos.nome,
        campos.cnpj ?? null,
        campos.endereco ?? null,
        campos.contato_nome ?? null,
        campos.contato_email ?? null,
        campos.contato_telefone ?? null,
        campos.status,
        campos.limite_salas ?? null,
      ];

      if (id) {
        const r = await db.query(
          `UPDATE tenants SET nome=$1, cnpj=$2, endereco=$3, contato_nome=$4, contato_email=$5,
                  contato_telefone=$6, status=$7, limite_salas=$8 WHERE id=$9`,
          [...valores, id],
        );
        if (r.rowCount === 0) throw notFound("Hospital não encontrado.");
        await registrarAcao(db, req.auth.userId, "atualizou_hospital", { tenant_id: id, ...campos });
        return { id };
      }
      const r = await db.query<{ id: string }>(
        `INSERT INTO tenants (nome, cnpj, endereco, contato_nome, contato_email, contato_telefone, status, limite_salas)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        valores,
      );
      const novo = r.rows[0]!.id;
      await registrarAcao(db, req.auth.userId, "criou_hospital", { tenant_id: novo, ...campos });
      return { id: novo };
    });

    app.post("/master/features/alternar", async (req) => {
      const d = z.object({ tenantId: uuid, featureId: uuid, habilitada: z.boolean() }).parse(req.body);
      const master = await exigirMaster(db, req.auth.userId);
      await db.tx(async (q) => {
        await q.query(
          `INSERT INTO tenant_features (tenant_id, feature_id, habilitada, habilitada_em, habilitada_por)
           VALUES ($1, $2, $3, now(), $4)
           ON CONFLICT (tenant_id, feature_id) DO UPDATE
             SET habilitada = EXCLUDED.habilitada, habilitada_em = now(), habilitada_por = EXCLUDED.habilitada_por`,
          [d.tenantId, d.featureId, d.habilitada, master.id],
        );
        await q.query(
          "INSERT INTO tenant_features_historico (tenant_id, feature_id, habilitada, alterado_por) VALUES ($1,$2,$3,$4)",
          [d.tenantId, d.featureId, d.habilitada, master.id],
        );
        await registrarAcao(q, master.id, "alterou_feature_flag", { ...d });
      });
      return { ok: true as const };
    });

    /* ----------------------------- Salas de qualquer hospital ----------------------------- */

    app.post("/master/salas/listar", async (req) => {
      const { tenantId } = z.object({ tenantId: uuid }).parse(req.body);
      await exigirMaster(db, req.auth.userId);
      const [salas, tenant] = await Promise.all([
        db.query(
          `SELECT id, nome, ativa, status_atual, cirurgia_atual, updated_at
             FROM salas WHERE tenant_id = $1 ORDER BY nome`,
          [tenantId],
        ),
        db.query<{ limite_salas: number | null }>("SELECT limite_salas FROM tenants WHERE id = $1", [tenantId]),
      ]);
      return { salas: salas.rows, limite: tenant.rows[0]?.limite_salas ?? null };
    });

    app.post("/master/salas/salvar", async (req) => {
      const d = z
        .object({ tenantId: uuid, id: uuid.optional(), nome: z.string().trim().min(1).max(60), ativa: z.boolean().default(true) })
        .parse(req.body);
      await exigirMaster(db, req.auth.userId);
      await db.tx(async (q) => {
        await salvarSala(q, {
          ...d,
          mensagemLimite: (l) => `Limite de ${l} sala(s) atingido. Aumente o limite do hospital antes de cadastrar.`,
        });
        await registrarAcao(q, req.auth.userId, "master_salvou_sala", { tenant_id: d.tenantId, nome: d.nome });
      });
      return { ok: true as const };
    });

    app.post("/master/salas/excluir", async (req) => {
      const d = z.object({ tenantId: uuid, id: uuid }).parse(req.body);
      await exigirMaster(db, req.auth.userId);
      await db.tx(async (q) => {
        const sala = await q.query("SELECT 1 FROM salas WHERE id = $1 AND tenant_id = $2 FOR UPDATE", [d.id, d.tenantId]);
        if (sala.rowCount === 0) throw notFound("Sala não encontrada.");
        const { count } = (
          await q.query<{ count: number }>("SELECT count(*)::int AS count FROM eventos_giro WHERE sala_id = $1", [d.id])
        ).rows[0]!;
        if (count > 0) {
          throw unprocessable("Esta sala já possui histórico de giro e não pode ser excluída. Desative-a no lugar disso.");
        }
        await q.query("DELETE FROM sala_dispositivos WHERE sala_id = $1", [d.id]);
        await q.query("DELETE FROM eventos_sala_parada WHERE sala_id = $1", [d.id]);
        await q.query("DELETE FROM salas WHERE id = $1 AND tenant_id = $2", [d.id, d.tenantId]);
        await registrarAcao(q, req.auth.userId, "master_excluiu_sala", { tenant_id: d.tenantId, sala_id: d.id });
      });
      return { ok: true as const };
    });

    /* ----------------------------------------- Usuários ----------------------------------------- */

    app.get("/master/usuarios", async (req) => {
      await exigirMaster(db, req.auth.userId);
      return (await db.query("SELECT * FROM usuarios_perfil ORDER BY created_at DESC")).rows;
    });

    app.post("/master/usuarios/criar", async (req) => {
      const d = z
        .object({
          email: z.string().email(),
          senha: senhaForte,
          nome: z.string().min(2),
          role: z.enum(["master_admin", "hospital_admin", "operador"]),
          tenantId: uuid.nullish(),
          featureId: uuid.nullish(),
        })
        .parse(req.body);
      const master = await exigirMaster(db, req.auth.userId);

      if (d.role !== "master_admin" && !d.tenantId) throw unprocessable("Selecione o hospital deste usuário.");
      await exigirSenhaNaoVazada(d.senha);
      if (d.role === "operador" && !d.featureId) {
        throw unprocessable("Todo login operacional precisa estar vinculado a uma feature.");
      }
      if (d.role === "operador") {
        const tf = (
          await db.query<{ habilitada: boolean }>(
            "SELECT habilitada FROM tenant_features WHERE tenant_id = $1 AND feature_id = $2",
            [d.tenantId, d.featureId],
          )
        ).rows[0];
        if (!tf?.habilitada) throw unprocessable("Esta feature não está habilitada para o hospital.");
      }

      const id = await db.tx(async (q) => {
        const { id } = await criarUsuarioComPerfil(q, {
          email: d.email,
          senha: d.senha,
          nome: d.nome,
          role: d.role,
          tenantId: d.tenantId ?? null,
          featureId: d.featureId ?? null,
        });
        await registrarAcao(q, master.id, "criou_usuario", {
          usuario: id,
          email: d.email,
          role: d.role,
          tenant_id: d.tenantId ?? null,
          feature_id: d.featureId ?? null,
        });
        return id;
      });
      return { id };
    });

    app.post("/master/usuarios/resetar-senha", async (req) => {
      const d = z.object({ usuarioId: uuid, senha: senhaForte }).parse(req.body);
      await exigirMaster(db, req.auth.userId);
      await exigirSenhaNaoVazada(d.senha);
      const hash = await hashSenha(d.senha);
      await db.tx(async (q) => {
        const r = await q.query("UPDATE usuarios SET senha_hash = $1 WHERE id = $2", [hash, d.usuarioId]);
        if (r.rowCount === 0) throw notFound("Usuário não encontrado.");
        await revogarTodasDoUsuario(q, d.usuarioId); // derruba as sessões abertas com a senha antiga
        await registrarAcao(q, req.auth.userId, "resetou_senha", { usuario: d.usuarioId });
      });
      return { ok: true as const };
    });

    app.post("/master/usuarios/alternar-ativo", async (req) => {
      const d = z.object({ usuarioId: uuid, ativo: z.boolean() }).parse(req.body);
      await exigirMaster(db, req.auth.userId);
      if (!d.ativo && d.usuarioId === req.auth.userId) throw unprocessable("Você não pode desativar a própria conta.");
      await db.tx(async (q) => {
        const r = await q.query("UPDATE usuarios_perfil SET ativo = $1 WHERE id = $2", [d.ativo, d.usuarioId]);
        if (r.rowCount === 0) throw notFound("Usuário não encontrado.");
        if (!d.ativo) await revogarTodasDoUsuario(q, d.usuarioId);
        await registrarAcao(q, req.auth.userId, d.ativo ? "ativou_usuario" : "desativou_usuario", { usuario: d.usuarioId });
      });
      return { ok: true as const };
    });

    app.post("/master/usuarios/atualizar", async (req) => {
      const d = z
        .object({ usuarioId: uuid, nome: z.string().min(2).max(120), email: z.string().email() })
        .parse(req.body);
      await exigirMaster(db, req.auth.userId);
      const email = d.email.trim().toLowerCase();
      const nome = d.nome.trim();

      await db.tx(async (q) => {
        const atual = (
          await q.query<{ email: string | null; nome: string }>("SELECT email, nome FROM usuarios_perfil WHERE id = $1 FOR UPDATE", [
            d.usuarioId,
          ])
        ).rows[0];
        if (!atual) throw notFound("Usuário não encontrado.");

        if (atual.email?.toLowerCase() !== email) {
          const dup = await q.query("SELECT 1 FROM usuarios WHERE lower(email) = $1 AND id <> $2", [email, d.usuarioId]);
          if (dup.rowCount > 0) throw conflict("Já existe uma conta com este e-mail.");
          await q.query("UPDATE usuarios SET email = $1 WHERE id = $2", [email, d.usuarioId]);
        }
        await q.query("UPDATE usuarios_perfil SET nome = $1, email = $2 WHERE id = $3", [nome, email, d.usuarioId]);
        await registrarAcao(q, req.auth.userId, "atualizou_usuario", {
          usuario: d.usuarioId,
          email_antes: atual.email ?? null,
          email_depois: email,
          nome_antes: atual.nome,
          nome_depois: nome,
        });
      });
      return { ok: true as const };
    });
  };
