import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import type { Db, Queryable, Row } from "../src/db/index.js";
import { hashSenha } from "../src/lib/crypto.js";
import type { Externos } from "../src/services/externos.js";
import type { PhotoStorage } from "../src/services/storage.js";

const aqui = dirname(fileURLToPath(import.meta.url));

export const SENHA = "Senha#Forte123";

/** Banco Postgres real (WASM) com as migrations do klinsync-db aplicadas. */
export async function criarBancoDeTeste(): Promise<Db> {
  const pg = new PGlite({
    parsers: { 1082: (v: string) => v, 20: (v: string) => Number(v) },
  });
  const dir = join(aqui, "db");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(dir, f), "utf8"));
  }

  const wrap = (c: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }> }): Queryable => ({
    async query<T = Row>(text: string, params: unknown[] = []) {
      const r = await c.query(text, params);
      // PGlite informa affectedRows=0 em SELECT; o driver pg devolve a quantidade de linhas.
      return { rows: r.rows as T[], rowCount: r.affectedRows && r.affectedRows > 0 ? r.affectedRows : r.rows.length };
    },
  });

  return {
    ...wrap(pg as never),
    tx: (fn) => pg.transaction((t) => fn(wrap(t as never))),
    close: () => pg.close(),
  };
}

export function configDeTeste(extra: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://teste:teste@localhost:5432/teste",
    JWT_ACCESS_SECRET: "a".repeat(40),
    JWT_REFRESH_SECRET: "b".repeat(40),
    CORS_ORIGIN: "https://app.exemplo.com.br",
    GEOIP_ENABLED: "false",
    HIBP_ENABLED: "false",
    LOG_LEVEL: "silent",
    ...extra,
  });
}

export function externosDeTeste(over: Partial<Externos> = {}): Externos {
  return {
    verificarCaptcha: async () => ({ ok: true }),
    senhaFoiVazada: async () => false,
    geolocalizarIp: async () => null,
    ...over,
  };
}

/** Storage em memória (o S3 real não é usado nos testes). */
export function storageEmMemoria(): PhotoStorage & { objetos: Map<string, Buffer> } {
  const objetos = new Map<string, Buffer>();
  return {
    objetos,
    async put(path, body) {
      objetos.set(path, body);
    },
    async remove(path) {
      objetos.delete(path);
    },
    async signedUrl(path, ttl) {
      return `https://s3.teste/${path}?ttl=${ttl}`;
    },
    async usage(prefix) {
      let bytes = 0;
      let count = 0;
      for (const [k, v] of objetos) {
        if (k.startsWith(`${prefix}/`)) {
          bytes += v.length;
          count += 1;
        }
      }
      return { bytes, count };
    },
  };
}

export type Ambiente = {
  app: FastifyInstance;
  db: Db;
  config: Config;
  storage: ReturnType<typeof storageEmMemoria>;
  fechar: () => Promise<void>;
};

export async function criarAmbiente(over: { externos?: Partial<Externos>; config?: Record<string, string> } = {}): Promise<Ambiente> {
  return montarAmbiente(await criarBancoDeTeste(), over);
}

/** Monta a aplicação sobre um banco já existente (ex.: um banco recém-importado). */
export async function montarAmbiente(
  db: Db,
  over: { externos?: Partial<Externos>; config?: Record<string, string> } = {},
): Promise<Ambiente> {
  const config = configDeTeste(over.config);
  const storage = storageEmMemoria();
  const app = await buildApp({ config, db, externos: externosDeTeste(over.externos), storage });
  await app.ready();
  return {
    app,
    db,
    config,
    storage,
    fechar: async () => {
      await app.close();
      await db.close();
    },
  };
}

/* ---------------------------------------- Dados e requisições ---------------------------------------- */

export async function criarHospital(db: Db, nome = "Hospital Teste", limiteSalas: number | null = null): Promise<string> {
  const r = await db.query<{ id: string }>("INSERT INTO tenants (nome, limite_salas) VALUES ($1, $2) RETURNING id", [nome, limiteSalas]);
  return r.rows[0]!.id;
}

export async function habilitarFeature(db: Db, tenantId: string, chave: string): Promise<string> {
  const f = await db.query<{ id: string }>("SELECT id FROM features WHERE chave = $1", [chave]);
  await db.query("INSERT INTO tenant_features (tenant_id, feature_id, habilitada) VALUES ($1, $2, true)", [tenantId, f.rows[0]!.id]);
  return f.rows[0]!.id;
}

export async function criarUsuarioDireto(
  db: Db,
  p: { email: string; role: "master_admin" | "hospital_admin" | "operador"; tenantId?: string | null; featureId?: string | null; nome?: string },
): Promise<string> {
  const u = await db.query<{ id: string }>("INSERT INTO usuarios (email, senha_hash) VALUES ($1, $2) RETURNING id", [
    p.email,
    await hashSenha(SENHA),
  ]);
  const id = u.rows[0]!.id;
  await db.query(
    "INSERT INTO usuarios_perfil (id, nome, email, role, tenant_id, feature_id) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, p.nome ?? p.email.split("@")[0], p.email, p.role, p.tenantId ?? null, p.featureId ?? null],
  );
  return id;
}

export type Resposta<T = any> = { status: number; body: T }; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function chamar<T = any>( // eslint-disable-line @typescript-eslint/no-explicit-any
  app: FastifyInstance,
  metodo: "GET" | "POST" | "DELETE",
  url: string,
  opts: { token?: string; body?: unknown; ip?: string; headers?: Record<string, string> } = {},
): Promise<Resposta<T>> {
  const res = await app.inject({
    method: metodo,
    url,
    headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
    ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
    ...(opts.ip ? { remoteAddress: opts.ip } : {}),
  });
  let body: unknown = null;
  try {
    body = res.json();
  } catch {
    body = res.body || null;
  }
  return { status: res.statusCode, body: body as T };
}

/** Faz login e devolve o access token. */
export async function login(app: FastifyInstance, email: string, senha = SENHA, ip?: string) {
  const r = await chamar(app, "POST", "/auth/login", { body: { email, senha }, ...(ip ? { ip } : {}) });
  return r;
}

export async function tokenDe(app: FastifyInstance, email: string): Promise<string> {
  const r = await login(app, email);
  if (r.status !== 200 || !r.body.accessToken) throw new Error(`login falhou para ${email}: ${JSON.stringify(r.body)}`);
  return r.body.accessToken as string;
}
