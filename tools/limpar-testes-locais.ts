import { abrirBancoLocal } from "./pglite-local.js";

// Remove os acessos de teste feitos pelo próprio PC depois da importação (IP 127.0.0.1), antes de gerar o dump.
const banco = await abrirBancoLocal();
try {
  const r = await banco.db.query("DELETE FROM log_acessos WHERE ip = '127.0.0.1' AND created_at >= '2026-10-06T19:20:00Z'");
  await banco.db.query("DELETE FROM refresh_tokens");
  await banco.db.query("DELETE FROM rate_limits");
  console.log(`acessos de teste removidos: ${r.rowCount}; sessões e rate limits locais limpos`);
} finally {
  await banco.db.close();
}
