// Descobre o host do Session pooler (IPv4) do projeto Supabase testando as regiões. Não imprime a senha.
//   node tools/achar-pooler.mjs           -> só mostra qual funciona
//   node tools/achar-pooler.mjs --gravar  -> atualiza SUPABASE_DB_URL no .env.import
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";

const arquivo = ".env.import";
const texto = readFileSync(arquivo, "utf8");
const linha = texto.split(/\r?\n/).find((l) => l.startsWith("SUPABASE_DB_URL="));
if (!linha) throw new Error("SUPABASE_DB_URL não encontrada no .env.import");
const original = new URL(linha.slice("SUPABASE_DB_URL=".length).trim().replace(/^["']|["']$/g, ""));
const ref = original.hostname.replace(/^db\./, "").split(".")[0];
const senha = decodeURIComponent(original.password);

const regioes = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2", "sa-east-1", "ca-central-1",
  "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-central-2", "eu-north-1",
  "ap-south-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "ap-northeast-2",
];

async function testar(host) {
  const c = new pg.Client({
    host, port: 5432, user: `postgres.${ref}`, password: senha, database: "postgres",
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 6000,
  });
  try {
    await c.connect();
    const r = await c.query("select current_database() as db, (select count(*)::int from public.tenants) as tenants");
    await c.end();
    return { ok: true, info: r.rows[0] };
  } catch (e) {
    await c.end().catch(() => undefined);
    return { ok: false, erro: String(e.message ?? e).slice(0, 80) };
  }
}

let achou = null;
for (const prefixo of ["aws-0", "aws-1"]) {
  for (const r of regioes) {
    const host = `${prefixo}-${r}.pooler.supabase.com`;
    const t = await testar(host);
    if (t.ok) {
      console.log(`FUNCIONA: ${host}  (banco=${t.info.db}, hospitais lidos=${t.info.tenants})`);
      achou = host;
      break;
    }
    if (!/Tenant or user not found|ENOTFOUND|ETIMEDOUT|timeout|ECONN/i.test(t.erro)) console.log(`  ${host}: ${t.erro}`);
  }
  if (achou) break;
}
if (!achou) {
  console.log("Nenhuma região respondeu com este usuário/senha. Copie a string do Session pooler direto do painel do Supabase.");
  process.exit(1);
}

if (process.argv.includes("--gravar")) {
  const nova = `postgresql://postgres.${ref}:${encodeURIComponent(senha)}@${achou}:5432/postgres`;
  writeFileSync(arquivo, texto.replace(linha, `SUPABASE_DB_URL=${nova}`));
  console.log(`SUPABASE_DB_URL atualizada no ${arquivo} para o Session pooler (${achou}).`);
}
