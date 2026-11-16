-- Desfaz a 0009_cme_cadastros.sql. Apaga SOMENTE caixas, colaboradores e sessões de crachá do CME.
-- Rodar manualmente, como dono do banco e depois de um backup. Desfaça esta antes da 0008.
BEGIN;
ALTER TABLE cme_leituras DROP COLUMN IF EXISTS colaborador_id;
DROP TABLE IF EXISTS cme_sessoes_cracha, cme_colaboradores, cme_caixa_itens, cme_caixas;
ALTER TABLE cme_config DROP COLUMN IF EXISTS tamanho_cracha_mm, DROP COLUMN IF EXISTS permitir_cracha_digitado;
DELETE FROM cme_contas WHERE tipo = 'estacao_sala';
ALTER TABLE cme_contas DROP CONSTRAINT IF EXISTS cme_contas_sala_coerente, DROP COLUMN IF EXISTS sala_id;
DELETE FROM schema_migrations WHERE filename = '0009_cme_cadastros.sql';
COMMIT;
