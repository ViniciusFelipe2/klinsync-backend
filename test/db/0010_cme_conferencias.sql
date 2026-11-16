-- Módulo CME: conferência da caixa, item a item, no computador da sala.
-- Só acrescenta tabelas. Para desfazer: migrations/down/0010_cme_conferencias.down.sql.

CREATE TABLE cme_conferencias (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  caixa_id uuid NOT NULL REFERENCES cme_caixas(codigo_id) ON DELETE RESTRICT,
  estacao_id uuid NOT NULL,
  sala_id uuid REFERENCES salas(id) ON DELETE SET NULL,
  -- Quem abriu a conferência; cada peça guarda quem a bipou.
  colaborador_id uuid NOT NULL REFERENCES cme_colaboradores(id) ON DELETE RESTRICT,
  -- Itens que a caixa devia ter quando a conferência começou (o gabarito daquele momento).
  itens_esperados integer NOT NULL,
  status text NOT NULL DEFAULT 'em_andamento' CHECK (status IN ('em_andamento', 'concluida')),
  iniciada_em timestamptz NOT NULL DEFAULT now(),
  finalizada_em timestamptz,
  finalizada_por uuid REFERENCES cme_colaboradores(id) ON DELETE RESTRICT
);
CREATE INDEX cme_conferencias_abertas_idx ON cme_conferencias (estacao_id, caixa_id) WHERE status = 'em_andamento';
CREATE INDEX cme_conferencias_tenant_idx ON cme_conferencias (tenant_id, iniciada_em DESC);

-- Cada peça conferida. A mesma peça não entra duas vezes na mesma conferência.
CREATE TABLE cme_conferencia_itens (
  conferencia_id uuid NOT NULL REFERENCES cme_conferencias(id) ON DELETE RESTRICT,
  item_id uuid NOT NULL REFERENCES cme_codigos(id) ON DELETE RESTRICT,
  leitura_id uuid NOT NULL REFERENCES cme_leituras(id) ON DELETE RESTRICT,
  colaborador_id uuid NOT NULL REFERENCES cme_colaboradores(id) ON DELETE RESTRICT,
  conferido_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conferencia_id, item_id)
);

-- Peça conferida é registro histórico: não se altera nem se apaga.
CREATE TRIGGER trg_cme_conferencia_itens_imutavel BEFORE UPDATE OR DELETE ON cme_conferencia_itens
  FOR EACH ROW EXECUTE FUNCTION cme_bloquear_alteracao();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'klinsync_app') THEN
    RETURN;
  END IF;
  REVOKE UPDATE, DELETE, TRUNCATE ON cme_conferencia_itens FROM klinsync_app;
END
$$;
