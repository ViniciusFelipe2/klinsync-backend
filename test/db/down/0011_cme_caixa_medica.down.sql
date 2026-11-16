-- Desfaz a 0011_cme_caixa_medica.sql. As caixas médicas viram caixas "consignada" (o nome do médico e o total de itens são apagados).
-- Rodar manualmente, como dono do banco e depois de um backup.
BEGIN;
ALTER TABLE cme_caixas DROP CONSTRAINT IF EXISTS cme_caixas_medica_coerente;
UPDATE cme_caixas SET tipo_caixa = 'consignada' WHERE tipo_caixa = 'medica';
ALTER TABLE cme_caixas DROP COLUMN IF EXISTS medico_nome, DROP COLUMN IF EXISTS total_itens;
ALTER TABLE cme_caixas DROP CONSTRAINT IF EXISTS cme_caixas_tipo_caixa_check;
ALTER TABLE cme_caixas ADD CONSTRAINT cme_caixas_tipo_caixa_check CHECK (tipo_caixa IN ('casa', 'consignada'));
DELETE FROM schema_migrations WHERE filename = '0011_cme_caixa_medica.sql';
COMMIT;
