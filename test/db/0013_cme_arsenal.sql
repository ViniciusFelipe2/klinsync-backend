-- Módulo CME: depois do ciclo, o colaborador confirma que as caixas foram para o arsenal (guarda de material estéril).
-- Só acrescenta um valor de status e duas colunas. Para desfazer: migrations/down/0013_cme_arsenal.down.sql.

ALTER TABLE cme_caixas DROP CONSTRAINT cme_caixas_local_check;
ALTER TABLE cme_caixas ADD CONSTRAINT cme_caixas_local_check
  CHECK (local IN ('sala', 'expurgo', 'preparo', 'esterilizacao', 'arsenal'));

ALTER TABLE cme_movimentos DROP CONSTRAINT cme_movimentos_setor_check;
ALTER TABLE cme_movimentos ADD CONSTRAINT cme_movimentos_setor_check
  CHECK (setor IN ('sala', 'expurgo', 'preparo', 'esterilizacao', 'arsenal'));

-- Quando e por quem a carga foi retirada da máquina e levada ao arsenal. Vazio = ainda está na máquina.
ALTER TABLE cme_cargas
  ADD COLUMN retirada_em timestamptz,
  ADD COLUMN retirada_por uuid REFERENCES cme_colaboradores(id) ON DELETE RESTRICT;

-- Ciclos que já tinham terminado antes desta mudança não ficam presos esperando confirmação.
UPDATE cme_cargas SET retirada_em = termina_em WHERE status = 'iniciada' AND termina_em <= now();
