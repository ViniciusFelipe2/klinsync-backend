-- Desfaz a 0013_cme_arsenal.sql. As caixas que estavam "no arsenal" voltam a ficar sem movimentação
-- e as passagens pelo arsenal saem do histórico.
-- Rodar manualmente, como dono do banco e depois de um backup. Desfaça esta antes da 0012.
BEGIN;
ALTER TABLE cme_cargas DROP COLUMN IF EXISTS retirada_em, DROP COLUMN IF EXISTS retirada_por;
UPDATE cme_caixas SET local = NULL, local_desde = NULL WHERE local = 'arsenal';
ALTER TABLE cme_caixas DROP CONSTRAINT IF EXISTS cme_caixas_local_check;
ALTER TABLE cme_caixas ADD CONSTRAINT cme_caixas_local_check CHECK (local IN ('sala', 'expurgo', 'preparo', 'esterilizacao'));
ALTER TABLE cme_movimentos DISABLE TRIGGER trg_cme_movimentos_sem_delete;
DELETE FROM cme_movimentos WHERE setor = 'arsenal';
ALTER TABLE cme_movimentos ENABLE TRIGGER trg_cme_movimentos_sem_delete;
ALTER TABLE cme_movimentos DROP CONSTRAINT IF EXISTS cme_movimentos_setor_check;
ALTER TABLE cme_movimentos ADD CONSTRAINT cme_movimentos_setor_check CHECK (setor IN ('sala', 'expurgo', 'preparo', 'esterilizacao'));
DELETE FROM schema_migrations WHERE filename = '0013_cme_arsenal.sql';
COMMIT;
