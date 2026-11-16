-- Desfaz a 0008_cme_codigos.sql. Apaga SOMENTE os dados do módulo CME; giro de sala e check-in não são tocados.
-- Rodar manualmente, como dono do banco e depois de um backup. O migrate.sh não lê esta pasta.
BEGIN;
DROP TABLE IF EXISTS cme_testes_leitura, cme_leituras, cme_auditoria, cme_codigos, cme_config, cme_contas;
DROP FUNCTION IF EXISTS cme_bloquear_alteracao();
DELETE FROM features WHERE chave = 'cme';
DELETE FROM schema_migrations WHERE filename = '0008_cme_codigos.sql';
COMMIT;
