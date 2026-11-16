-- Módulo CME: nova modalidade de caixa, a "caixa médica" (trazida e deixada no hospital pelo próprio médico).
-- Só acrescenta um valor ao tipo e duas colunas; as caixas existentes não mudam.
-- Para desfazer: migrations/down/0011_cme_caixa_medica.down.sql (o migrate.sh não lê subpastas).

ALTER TABLE cme_caixas DROP CONSTRAINT cme_caixas_tipo_caixa_check;
ALTER TABLE cme_caixas ADD CONSTRAINT cme_caixas_tipo_caixa_check CHECK (tipo_caixa IN ('casa', 'consignada', 'medica'));

-- Nome do médico dono da caixa e quantos itens ela tem no total. Só existem na caixa médica.
ALTER TABLE cme_caixas
  ADD COLUMN medico_nome text,
  ADD COLUMN total_itens integer CHECK (total_itens BETWEEN 1 AND 500);

ALTER TABLE cme_caixas ADD CONSTRAINT cme_caixas_medica_coerente CHECK (
  (tipo_caixa = 'medica' AND medico_nome IS NOT NULL AND total_itens IS NOT NULL)
  OR (tipo_caixa <> 'medica' AND medico_nome IS NULL AND total_itens IS NULL)
);
