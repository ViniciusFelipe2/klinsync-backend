-- Desfaz a 0012_cme_operacao.sql. Apaga máquinas, ciclos, cargas, o histórico de movimentos e o status das caixas.
-- As conferências feitas no expurgo e no preparo também são apagadas; as da sala ficam.
-- Rodar manualmente, como dono do banco e depois de um backup.
BEGIN;
DROP TABLE IF EXISTS cme_movimentos;
ALTER TABLE cme_caixas DROP COLUMN IF EXISTS local, DROP COLUMN IF EXISTS local_desde, DROP COLUMN IF EXISTS local_sala_id, DROP COLUMN IF EXISTS local_carga_id;
DROP TABLE IF EXISTS cme_carga_caixas, cme_cargas, cme_maquina_ciclos, cme_maquinas;
ALTER TABLE cme_conferencia_itens DISABLE TRIGGER trg_cme_conferencia_itens_imutavel;
DELETE FROM cme_conferencia_itens WHERE conferencia_id IN (SELECT id FROM cme_conferencias WHERE setor <> 'sala');
ALTER TABLE cme_conferencia_itens ENABLE TRIGGER trg_cme_conferencia_itens_imutavel;
DELETE FROM cme_conferencias WHERE setor <> 'sala';
ALTER TABLE cme_conferencias DROP COLUMN IF EXISTS setor;
DELETE FROM cme_sessoes_cracha WHERE estacao_id IN (SELECT usuario_id FROM cme_contas WHERE tipo = 'estacao_cme');
DELETE FROM cme_contas WHERE tipo = 'estacao_cme';
ALTER TABLE cme_contas DROP CONSTRAINT IF EXISTS cme_contas_tipo_check;
ALTER TABLE cme_contas ADD CONSTRAINT cme_contas_tipo_check CHECK (tipo IN ('chefe', 'colaborador', 'estacao_sala', 'painel_setor'));
DELETE FROM schema_migrations WHERE filename = '0012_cme_operacao.sql';
COMMIT;
