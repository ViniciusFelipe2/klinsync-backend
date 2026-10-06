import { z } from "zod";

const vazioParaUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const bool = (padrao: boolean) =>
  z.preprocess(
    (v) => (typeof v === "string" ? ["true", "1", "yes"].includes(v.trim().toLowerCase()) : v),
    z.boolean().default(padrao),
  );

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL não configurada")
    .refine((v) => /^postgres(ql)?:\/\//.test(v), "DATABASE_URL inválida (esperado postgresql://...)"),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET precisa ter ao menos 32 caracteres"),
  JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET precisa ter ao menos 32 caracteres"),
  MFA_ENCRYPTION_KEY: z.preprocess(vazioParaUndefined, z.string().min(32).optional()),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().min(1).max(1440).default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  RECAPTCHA_SECRET_KEY: z.preprocess(vazioParaUndefined, z.string().optional()),
  CHECKIN_PHOTOS_BUCKET: z.preprocess(vazioParaUndefined, z.string().optional()),
  AWS_REGION: z.string().default("us-east-2"),
  TRUST_PROXY: z.string().default("loopback"),
  APP_TIMEZONE: z
    .string()
    .default("America/Sao_Paulo")
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat("pt-BR", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "APP_TIMEZONE inválido"),
  GEOIP_ENABLED: bool(true),
  HIBP_ENABLED: bool(true),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Mapa próprio: o mapa global (mensagens da API) esconderia qual variável está faltando.
  const r = schema.safeParse(env, {
    errorMap: (issue, ctx) =>
      issue.code === "invalid_type" && issue.received === "undefined"
        ? { message: "variável não definida" }
        : { message: ctx.defaultError },
  });
  if (!r.success) {
    const linhas = r.error.issues.map((i) => `  - ${i.path.join(".") || "(raiz)"}: ${i.message}`);
    throw new Error(`Configuração inválida:\n${linhas.join("\n")}`);
  }
  return r.data;
}

export function origensCors(config: Config): string[] {
  return config.CORS_ORIGIN.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}
