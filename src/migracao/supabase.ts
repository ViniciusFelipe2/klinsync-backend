import type { Config } from "../config.js";
import type { Db, Queryable, Row } from "../db/index.js";
import { chaveMfa, cifrar } from "../lib/crypto.js";
import type { PhotoStorage } from "../services/storage.js";

/**
 * Importação dos dados do Supabase (projeto mãe) para o schema do klinsync-db.
 * Lê o Supabase só para leitura e grava tudo numa transação no destino (nada fica pela metade).
 */

export type ResumoTabela = { lidas: number; importadas: number; ignoradas: number };
export type Relatorio = { tabelas: Record<string, ResumoTabela>; avisos: string[]; dryRun: boolean };
export type OpcoesImportacao = { dryRun?: boolean; limparDestino?: boolean; log?: (m: string) => void };

class ReverterSimulacao extends Error {}

type Ctx = {
  tenants: Set<string>;
  features: Set<string>;
  usuarios: Set<string>;
  emails: Map<string, string>;
  salas: Set<string>;
  avisos: string[];
  aviso: (m: string) => void;
};

type Spec = {
  tabela: string;
  colunas: string[];
  /** SELECT no Supabase, com ORDER BY estável e sem LIMIT. */
  sql: string;
  /** Usado se `sql` falhar por coluna inexistente (versões antigas do Supabase Auth). */
  sqlAlternativo?: string;
  /** Colunas que precisam de cast para um tipo do destino (enum/jsonb). */
  cast?: Record<string, string>;
  /** Transforma a linha; devolve `null` para ignorá-la. */
  mapa?: (row: Row, ctx: Ctx) => Row | null;
  /** Roda antes de copiar a tabela. */
  antes?: (destino: Queryable) => Promise<void>;
  /** Roda depois, com as linhas importadas. */
  depois?: (ctx: Ctx, importadas: Row[]) => void;
};

const TAMANHO_LEITURA = 2000;
const TAMANHO_LOTE = 400;

const ROLES_VALIDOS = new Set(["master_admin", "hospital_admin", "operador"]);
const STATUS_SALA = new Set(["livre", "desmontagem", "limpeza", "remontagem"]);

const umDeles = <T,>(v: T | null | undefined, set: Set<T>): T | null => (v != null && set.has(v) ? v : null);

/** O papel legado `administrador` (admin do hospital no modelo antigo) vira `hospital_admin`. */
function normalizarRole(role: unknown): string | null {
  const r = String(role ?? "");
  if (r === "administrador") return "hospital_admin";
  return ROLES_VALIDOS.has(r) ? r : null;
}

const BASE32 = /^[A-Z2-7]{16,}=*$/;

const SPECS: Spec[] = [
  {
    tabela: "tenants",
    colunas: ["id", "nome", "cnpj", "endereco", "contato_nome", "contato_email", "contato_telefone", "status", "contratado_em", "limite_salas", "created_at"],
    sql: `SELECT id, nome, cnpj, endereco, contato_nome, contato_email, contato_telefone, status, contratado_em, limite_salas, created_at
            FROM public.tenants ORDER BY created_at, id`,
    depois: (ctx, rows) => rows.forEach((r) => ctx.tenants.add(r["id"])),
  },
  {
    tabela: "features",
    colunas: ["id", "chave", "nome_exibicao", "descricao", "created_at"],
    sql: "SELECT id, chave, nome_exibicao, descricao, created_at FROM public.features ORDER BY created_at, id",
    // As features do seed do destino têm outros ids: são substituídas pelas do Supabase (ids preservados).
    antes: async (d) => {
      await d.query("DELETE FROM features");
    },
    depois: (ctx, rows) => rows.forEach((r) => ctx.features.add(r["id"])),
  },
  {
    tabela: "usuarios",
    colunas: ["id", "email", "senha_hash", "email_confirmado_em", "ultimo_login_em", "created_at", "updated_at"],
    sql: `SELECT id, email, encrypted_password, email_confirmed_at, last_sign_in_at, created_at, updated_at
            FROM auth.users WHERE email IS NOT NULL AND deleted_at IS NULL ORDER BY created_at, id`,
    sqlAlternativo: `SELECT id, email, encrypted_password, email_confirmed_at, last_sign_in_at, created_at, updated_at
            FROM auth.users WHERE email IS NOT NULL ORDER BY created_at, id`,
    mapa: (r, ctx) => {
      const email = String(r["email"]).trim().toLowerCase();
      if (!email || ctx.emails.has(`__email:${email}`)) {
        ctx.aviso(`usuário ${r["id"]}: e-mail repetido/vazio (${email}), ignorado`);
        return null;
      }
      ctx.emails.set(`__email:${email}`, r["id"]);
      ctx.emails.set(r["id"], email);
      const hash = String(r["encrypted_password"] ?? "");
      if (!hash) ctx.aviso(`usuário ${email}: sem senha no Supabase (login social/magic link); precisará de convite ou reset`);
      return {
        id: r["id"],
        email,
        // "!" nunca confere com nenhuma senha: a conta só entra após um reset.
        senha_hash: hash || "!",
        email_confirmado_em: r["email_confirmed_at"],
        ultimo_login_em: r["last_sign_in_at"],
        created_at: r["created_at"],
        updated_at: r["updated_at"] ?? r["created_at"],
      };
    },
    depois: (ctx, rows) => rows.forEach((r) => ctx.usuarios.add(r["id"])),
  },
  {
    tabela: "usuarios_perfil",
    colunas: ["id", "nome", "email", "role", "tenant_id", "feature_id", "ativo", "created_at", "updated_at"],
    sql: `SELECT id, nome, email, role::text AS role, tenant_id, feature_id, ativo, created_at, updated_at
            FROM public.usuarios_perfil ORDER BY created_at, id`,
    cast: { role: "app_role" },
    mapa: (r, ctx) => {
      if (!ctx.usuarios.has(r["id"])) {
        ctx.aviso(`perfil ${r["id"]}: sem usuário em auth.users, ignorado`);
        return null;
      }
      const role = normalizarRole(r["role"]);
      if (!role) {
        ctx.aviso(`perfil ${r["id"]}: papel desconhecido (${r["role"]}), ignorado`);
        return null;
      }
      const tenant = umDeles(r["tenant_id"], ctx.tenants);
      const feature = umDeles(r["feature_id"], ctx.features);
      if (role !== "master_admin" && !tenant) {
        ctx.aviso(`perfil ${ctx.emails.get(r["id"])}: hospital inexistente, ignorado`);
        return null;
      }
      if (role === "operador" && !feature) {
        ctx.aviso(`perfil ${ctx.emails.get(r["id"])}: operador sem módulo (feature), ignorado`);
        return null;
      }
      if (r["role"] === "administrador") ctx.aviso(`perfil ${ctx.emails.get(r["id"])}: papel "administrador" convertido para hospital_admin`);
      return {
        id: r["id"],
        nome: r["nome"] ?? "",
        email: r["email"] ?? ctx.emails.get(r["id"]) ?? null,
        role,
        tenant_id: role === "master_admin" ? null : tenant,
        feature_id: role === "operador" ? feature : null,
        ativo: r["ativo"] ?? true,
        created_at: r["created_at"],
        updated_at: r["updated_at"] ?? r["created_at"],
      };
    },
  },
  {
    tabela: "tenant_features",
    colunas: ["id", "tenant_id", "feature_id", "habilitada", "habilitada_em", "habilitada_por"],
    sql: "SELECT id, tenant_id, feature_id, habilitada, habilitada_em, habilitada_por FROM public.tenant_features ORDER BY id",
    mapa: (r, ctx) =>
      ctx.tenants.has(r["tenant_id"]) && ctx.features.has(r["feature_id"])
        ? { ...r, habilitada_por: umDeles(r["habilitada_por"], ctx.usuarios) }
        : null,
  },
  {
    tabela: "tenant_features_historico",
    colunas: ["id", "tenant_id", "feature_id", "habilitada", "alterado_por", "created_at"],
    sql: "SELECT id, tenant_id, feature_id, habilitada, alterado_por, created_at FROM public.tenant_features_historico ORDER BY created_at, id",
    mapa: (r, ctx) =>
      ctx.tenants.has(r["tenant_id"]) && ctx.features.has(r["feature_id"])
        ? { ...r, alterado_por: umDeles(r["alterado_por"], ctx.usuarios) }
        : null,
  },
  {
    tabela: "convites",
    colunas: ["id", "email", "nome", "role", "tenant_id", "feature_id", "token_hash", "criado_por", "expira_em", "aceito_em", "aceito_por", "revogado_em", "revogado_por", "created_at", "updated_at"],
    sql: `SELECT id, email, nome, role::text AS role, tenant_id, feature_id, token_hash, criado_por, expira_em, aceito_em,
                 aceito_por, revogado_em, revogado_por, created_at, updated_at
            FROM public.convites ORDER BY created_at, id`,
    cast: { role: "app_role" },
    mapa: (r, ctx) => {
      const role = normalizarRole(r["role"]);
      if (!role || (r["tenant_id"] && !ctx.tenants.has(r["tenant_id"]))) return null;
      return { ...r, role, feature_id: umDeles(r["feature_id"], ctx.features) };
    },
  },
  {
    tabela: "ip_bloqueios",
    colunas: ["id", "ip", "motivo", "permanente", "bloqueado_ate", "criado_por", "created_at", "updated_at"],
    sql: "SELECT id, ip, motivo, permanente, bloqueado_ate, criado_por, created_at, updated_at FROM public.ip_bloqueios ORDER BY created_at, id",
  },
  {
    tabela: "log_acessos",
    colunas: ["id", "usuario_id", "email_tentado", "tenant_id", "ip", "pais_regiao", "sucesso", "created_at"],
    sql: "SELECT id, usuario_id, email_tentado, tenant_id, ip, pais_regiao, sucesso, created_at FROM public.log_acessos ORDER BY created_at, id",
    mapa: (r, ctx) => ({ ...r, usuario_id: umDeles(r["usuario_id"], ctx.usuarios), tenant_id: umDeles(r["tenant_id"], ctx.tenants) }),
  },
  {
    tabela: "log_acoes_sensiveis",
    colunas: ["id", "usuario_id", "acao", "detalhes", "created_at"],
    sql: "SELECT id, usuario_id, acao, detalhes, created_at FROM public.log_acoes_sensiveis ORDER BY created_at, id",
    cast: { detalhes: "jsonb" },
    mapa: (r, ctx) => ({
      ...r,
      usuario_id: umDeles(r["usuario_id"], ctx.usuarios),
      detalhes: JSON.stringify(r["detalhes"] ?? {}),
    }),
  },
  {
    tabela: "check_ins",
    colunas: ["id", "tenant_id", "doctor_name", "photo_path", "checked_in_at", "created_at", "updated_at"],
    sql: "SELECT id, tenant_id, doctor_name, photo_path, checked_in_at, created_at, updated_at FROM public.check_ins ORDER BY created_at, id",
    mapa: (r, ctx) => (ctx.tenants.has(r["tenant_id"]) ? { ...r, updated_at: r["updated_at"] ?? r["created_at"] } : null),
  },
  {
    tabela: "salas",
    colunas: ["id", "tenant_id", "nome", "ativa", "status_atual", "cirurgia_atual", "created_at", "updated_at"],
    sql: "SELECT id, tenant_id, nome, ativa, status_atual::text AS status_atual, cirurgia_atual, created_at, updated_at FROM public.salas ORDER BY created_at, id",
    cast: { status_atual: "sala_status" },
    mapa: (r, ctx) => {
      if (!ctx.tenants.has(r["tenant_id"])) {
        ctx.aviso(`sala "${r["nome"]}": sem hospital, ignorada`);
        return null;
      }
      return { ...r, status_atual: STATUS_SALA.has(r["status_atual"]) ? r["status_atual"] : "livre" };
    },
    depois: (ctx, rows) => rows.forEach((r) => ctx.salas.add(r["id"])),
  },
  {
    tabela: "eventos_giro",
    colunas: ["id", "sala_id", "tipo_evento", "inicio", "fim", "duracao_segundos", "usuario_inicio_id", "usuario_fim_id", "cirurgia_anterior", "cirurgia_proxima", "created_at"],
    sql: `SELECT id, sala_id, tipo_evento::text AS tipo_evento, inicio, fim, duracao_segundos, usuario_inicio_id, usuario_fim_id,
                 cirurgia_anterior, cirurgia_proxima, created_at
            FROM public.eventos_giro ORDER BY inicio, id`,
    cast: { tipo_evento: "tipo_evento_giro" },
    mapa: (r, ctx) =>
      ctx.salas.has(r["sala_id"]) && ctx.usuarios.has(r["usuario_inicio_id"])
        ? { ...r, usuario_fim_id: umDeles(r["usuario_fim_id"], ctx.usuarios) }
        : null,
  },
  {
    tabela: "eventos_sala_parada",
    colunas: ["id", "sala_id", "inicio", "fim", "duracao_segundos", "usuario_inicio_id", "usuario_fim_id", "created_at"],
    sql: "SELECT id, sala_id, inicio, fim, duracao_segundos, usuario_inicio_id, usuario_fim_id, created_at FROM public.eventos_sala_parada ORDER BY inicio, id",
    mapa: (r, ctx) =>
      ctx.salas.has(r["sala_id"]) && ctx.usuarios.has(r["usuario_inicio_id"])
        ? { ...r, usuario_fim_id: umDeles(r["usuario_fim_id"], ctx.usuarios) }
        : null,
  },
  {
    tabela: "sala_dispositivos",
    colunas: ["sala_id", "device_id", "user_id", "ultimo_sinal", "created_at"],
    sql: "SELECT sala_id, device_id, user_id, ultimo_sinal, created_at FROM public.sala_dispositivos ORDER BY sala_id",
    mapa: (r, ctx) => (ctx.salas.has(r["sala_id"]) ? { ...r, user_id: umDeles(r["user_id"], ctx.usuarios) } : null),
  },
];

/** Lê o SELECT em páginas (LIMIT/OFFSET sobre ORDER BY estável). */
async function* paginas(origem: Queryable, sql: string): AsyncGenerator<Row[]> {
  for (let off = 0; ; off += TAMANHO_LEITURA) {
    const r = await origem.query(`${sql} LIMIT ${TAMANHO_LEITURA} OFFSET ${off}`);
    if (r.rows.length === 0) return;
    yield r.rows;
    if (r.rows.length < TAMANHO_LEITURA) return;
  }
}

async function inserirLotes(destino: Queryable, spec: Pick<Spec, "tabela" | "colunas" | "cast">, linhas: Row[]): Promise<void> {
  for (let i = 0; i < linhas.length; i += TAMANHO_LOTE) {
    const lote = linhas.slice(i, i + TAMANHO_LOTE);
    const params: unknown[] = [];
    const valores = lote.map((l) => {
      const ph = spec.colunas.map((c) => {
        params.push(l[c] ?? null);
        return `$${params.length}${spec.cast?.[c] ? `::${spec.cast[c]}` : ""}`;
      });
      return `(${ph.join(", ")})`;
    });
    await destino.query(`INSERT INTO ${spec.tabela} (${spec.colunas.join(", ")}) VALUES ${valores.join(", ")}`, params);
  }
}

const TABELAS_DE_DADOS = [
  "refresh_tokens", "mfa_fatores", "sala_dispositivos", "eventos_sala_parada", "eventos_giro", "salas", "check_ins",
  "log_acoes_sensiveis", "log_acessos", "rate_limits", "ip_bloqueios", "convites", "usuarios_perfil",
  "tenant_features_historico", "tenant_features", "usuarios", "features", "tenants",
];

export async function importarDoSupabase(origem: Queryable, destino: Db, config: Config, opts: OpcoesImportacao = {}): Promise<Relatorio> {
  const log = opts.log ?? (() => undefined);
  const relatorio: Relatorio = { tabelas: {}, avisos: [], dryRun: !!opts.dryRun };
  const ctx: Ctx = {
    tenants: new Set(),
    features: new Set(),
    usuarios: new Set(),
    emails: new Map(),
    salas: new Set(),
    avisos: relatorio.avisos,
    aviso: (m) => {
      if (relatorio.avisos.length < 500) relatorio.avisos.push(m);
    },
  };

  try {
    await destino.tx(async (q) => {
      const existentes = await q.query<{ n: number }>("SELECT ((SELECT count(*) FROM tenants) + (SELECT count(*) FROM usuarios))::int AS n");
      if ((existentes.rows[0]?.n ?? 0) > 0) {
        if (!opts.limparDestino) {
          throw new Error("O banco de destino já tem dados (hospitais/usuários). Importe num banco vazio ou use --limpar-destino (apaga tudo no destino).");
        }
        log("Limpando o banco de destino...");
        await q.query(`TRUNCATE ${TABELAS_DE_DADOS.join(", ")} RESTART IDENTITY CASCADE`);
      }

      for (const spec of SPECS) {
        await spec.antes?.(q);
        const resumo: ResumoTabela = { lidas: 0, importadas: 0, ignoradas: 0 };
        const importadasTabela: Row[] = [];

        let sql = spec.sql;
        if (spec.sqlAlternativo) {
          try {
            await origem.query(`${sql} LIMIT 0`);
          } catch (err) {
            if ((err as { code?: string }).code !== "42703") throw err;
            sql = spec.sqlAlternativo;
          }
        }

        for await (const pagina of paginas(origem, sql)) {
          resumo.lidas += pagina.length;
          const prontas: Row[] = [];
          for (const linha of pagina) {
            const out = spec.mapa ? spec.mapa(linha, ctx) : linha;
            if (out) prontas.push(out);
            else resumo.ignoradas += 1;
          }
          await inserirLotes(q, spec, prontas);
          resumo.importadas += prontas.length;
          importadasTabela.push(...prontas);
        }
        spec.depois?.(ctx, importadasTabela);
        relatorio.tabelas[spec.tabela] = resumo;
        log(`  ${spec.tabela}: ${resumo.importadas}/${resumo.lidas} importadas${resumo.ignoradas ? `, ${resumo.ignoradas} ignoradas` : ""}`);
      }

      // Política de segurança (linha única).
      const cfg = (await origem.query("SELECT max_tentativas, janela_minutos, bloqueio_minutos FROM public.config_seguranca LIMIT 1")).rows[0];
      if (cfg) {
        await q.query("UPDATE config_seguranca SET max_tentativas = $1, janela_minutos = $2, bloqueio_minutos = $3 WHERE id = true", [
          cfg["max_tentativas"], cfg["janela_minutos"], cfg["bloqueio_minutos"],
        ]);
      }

      // Fatores TOTP verificados: o segredo passa a ser guardado cifrado.
      const mfa: ResumoTabela = { lidas: 0, importadas: 0, ignoradas: 0 };
      try {
        const fatores = await origem.query(
          `SELECT id, user_id, friendly_name, secret, created_at FROM auth.mfa_factors
            WHERE factor_type::text = 'totp' AND status::text = 'verified' ORDER BY created_at, id`,
        );
        const chave = chaveMfa(config);
        const prontas: Row[] = [];
        for (const f of fatores.rows) {
          mfa.lidas += 1;
          const segredo = String(f["secret"] ?? "").replace(/\s+/g, "").toUpperCase();
          if (!ctx.usuarios.has(f["user_id"]) || !BASE32.test(segredo)) {
            mfa.ignoradas += 1;
            ctx.aviso(`MFA do usuário ${ctx.emails.get(f["user_id"]) ?? f["user_id"]}: segredo não aproveitável, será preciso recadastrar`);
            continue;
          }
          prontas.push({
            id: f["id"],
            usuario_id: f["user_id"],
            friendly_name: f["friendly_name"],
            segredo_cifrado: cifrar(segredo, chave),
            status: "verified",
            created_at: f["created_at"],
          });
        }
        await inserirLotes(q, { tabela: "mfa_fatores", colunas: ["id", "usuario_id", "friendly_name", "segredo_cifrado", "status", "created_at"] }, prontas);
        mfa.importadas = prontas.length;
      } catch (err) {
        // auth.mfa_factors pode não existir em instalações antigas
        ctx.aviso(`MFA não importado: ${(err as Error).message}`);
      }
      relatorio.tabelas["mfa_fatores"] = mfa;
      log(`  mfa_fatores: ${mfa.importadas}/${mfa.lidas} importados`);

      if (opts.dryRun) throw new ReverterSimulacao();
    });
  } catch (err) {
    if (!(err instanceof ReverterSimulacao)) throw err;
  }
  return relatorio;
}

/* ----------------------------------------- Fotos (Storage -> S3) ----------------------------------------- */

export type OpcoesFotos = {
  /** Baixa o arquivo do Storage do Supabase; `null` quando não existe. */
  baixar: (caminho: string) => Promise<{ dados: Buffer; contentType: string } | null>;
  storage: PhotoStorage;
  concorrencia?: number;
  log?: (m: string) => void;
};

export type RelatorioFotos = { total: number; copiadas: number; ausentes: string[]; falhas: string[] };

/** Copia, com os mesmos caminhos, as fotos referenciadas por `check_ins` do Storage do Supabase para o S3. */
export async function copiarFotos(destino: Queryable, opts: OpcoesFotos): Promise<RelatorioFotos> {
  const caminhos = (await destino.query<{ photo_path: string }>("SELECT DISTINCT photo_path FROM check_ins ORDER BY photo_path")).rows.map((r) => r.photo_path);
  const rel: RelatorioFotos = { total: caminhos.length, copiadas: 0, ausentes: [], falhas: [] };
  let feitas = 0;
  let proximo = 0;

  const trabalhador = async () => {
    for (;;) {
      const i = proximo++;
      if (i >= caminhos.length) return;
      const caminho = caminhos[i]!;
      try {
        let arquivo: Awaited<ReturnType<OpcoesFotos["baixar"]>> = null;
        for (let t = 1; ; t++) {
          try {
            arquivo = await opts.baixar(caminho);
            break;
          } catch (err) {
            if (t >= 3) throw err;
            await new Promise((r) => setTimeout(r, 300 * t));
          }
        }
        if (!arquivo) {
          rel.ausentes.push(caminho);
        } else {
          await opts.storage.put(caminho, arquivo.dados, arquivo.contentType);
          rel.copiadas += 1;
        }
      } catch {
        rel.falhas.push(caminho);
      }
      feitas += 1;
      if (feitas % 25 === 0 || feitas === caminhos.length) opts.log?.(`  fotos: ${feitas}/${caminhos.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concorrencia ?? 5) }, trabalhador));
  return rel;
}
