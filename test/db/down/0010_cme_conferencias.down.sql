-- Desfaz a 0010_cme_conferencias.sql. Apaga SOMENTE as conferências de caixa do CME.
-- Rodar manualmente, como dono do banco e depois de um backup. Desfaça esta antes da 0009.
BEGIN;
DROP TABLE IF EXISTS cme_conferencia_itens, cme_conferencias;
DELETE FROM schema_migrations WHERE filename = '0010_cme_conferencias.sql';
COMMIT;
