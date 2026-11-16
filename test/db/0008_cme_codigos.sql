-- Módulo CME, Fase 1: códigos Data Matrix, teste de leitura e registro de falhas.
-- Só acrescenta objetos novos: nenhuma tabela do giro de sala ou do check-in é alterada.
-- Para desfazer: migrations/down/0008_cme_codigos.down.sql (o migrate.sh não lê subpastas).

INSERT INTO features (chave, nome_exibicao, descricao) VALUES
  ('cme', 'CME - Rastreabilidade de materiais',
   'Códigos Data Matrix de itens e caixas, conferência por leitura e rastreabilidade do CME.')
ON CONFLICT (chave) DO NOTHING;

-- Função do login dentro do módulo. Os papéis gerais (app_role) continuam iguais: aqui fica só o detalhe do CME.
CREATE TABLE cme_contas (
  usuario_id uuid PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tipo text NOT NULL CHECK (tipo IN ('chefe', 'colaborador', 'estacao_sala', 'painel_setor')),
  criado_por uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cme_contas_tenant_idx ON cme_contas (tenant_id);

-- Limites do leitor em uso no hospital. Sem linha aqui valem os padrões definidos na API.
CREATE TABLE cme_config (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  tamanho_padrao_mm double precision NOT NULL CHECK (tamanho_padrao_mm BETWEEN 3 AND 15),
  modulo_minimo_mm double precision NOT NULL CHECK (modulo_minimo_mm > 0),
  modulo_aviso_mm double precision NOT NULL,
  matriz_maxima_5mm integer NOT NULL CHECK (matriz_maxima_5mm >= 10),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (modulo_aviso_mm >= modulo_minimo_mm)
);

-- Registro central dos códigos: gerados pelo sistema ou já gravados na peça.
CREATE TABLE cme_codigos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  tipo text NOT NULL CHECK (tipo IN ('item', 'caixa')),
  rotulo text NOT NULL,
  codigo text NOT NULL,
  origem text NOT NULL CHECK (origem IN ('gerado', 'existente')),
  matriz_lado integer NOT NULL,
  ativo boolean NOT NULL DEFAULT true,
  criado_por uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, codigo)
);
CREATE INDEX cme_codigos_tenant_idx ON cme_codigos (tenant_id, created_at DESC);
CREATE TRIGGER trg_cme_codigos_updated BEFORE UPDATE ON cme_codigos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Toda leitura: pelo leitor, digitada à mão (contingência) ou o registro de que a peça não leu.
CREATE TABLE cme_leituras (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  codigo_id uuid REFERENCES cme_codigos(id) ON DELETE RESTRICT,
  usuario_id uuid NOT NULL,
  origem text NOT NULL CHECK (origem IN ('leitor', 'manual', 'nao_leu')),
  resultado text NOT NULL CHECK (resultado IN ('reconhecido', 'desconhecido', 'nao_leu')),
  texto_bruto text,
  texto_normalizado text,
  duracao_ms integer,
  motivo text,
  tela text NOT NULL,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cme_leituras_tenant_idx ON cme_leituras (tenant_id, created_at DESC);
CREATE INDEX cme_leituras_codigo_idx ON cme_leituras (codigo_id) WHERE codigo_id IS NOT NULL;

-- Anotação de cada teste feito na tela de teste de leitura.
CREATE TABLE cme_testes_leitura (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  leitura_id uuid NOT NULL REFERENCES cme_leituras(id) ON DELETE RESTRICT,
  usuario_id uuid NOT NULL,
  tipo_peca text NOT NULL CHECK (tipo_peca IN ('papel', 'inox_liso', 'inox_curvo', 'peca_pequena', 'peca_gasta')),
  resultado text NOT NULL CHECK (resultado IN ('sucesso', 'falha')),
  tentativas integer NOT NULL CHECK (tentativas >= 1),
  tamanho_mm double precision,
  observacao text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cme_testes_tenant_idx ON cme_testes_leitura (tenant_id, tipo_peca);

-- Trilha de auditoria do módulo. Sem chave estrangeira de propósito: sobrevive à exclusão de qualquer cadastro.
CREATE TABLE cme_auditoria (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  usuario_id uuid NOT NULL,
  ip text,
  acao text NOT NULL,
  detalhes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cme_auditoria_tenant_idx ON cme_auditoria (tenant_id, created_at DESC);

-- Registros históricos só aceitam INSERT: a regra vale no próprio banco, mesmo que a API tenha um defeito.
CREATE FUNCTION cme_bloquear_alteracao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Registros de % não podem ser alterados nem apagados.', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER trg_cme_leituras_imutavel BEFORE UPDATE OR DELETE ON cme_leituras
  FOR EACH ROW EXECUTE FUNCTION cme_bloquear_alteracao();
CREATE TRIGGER trg_cme_testes_imutavel BEFORE UPDATE OR DELETE ON cme_testes_leitura
  FOR EACH ROW EXECUTE FUNCTION cme_bloquear_alteracao();
CREATE TRIGGER trg_cme_auditoria_imutavel BEFORE UPDATE OR DELETE ON cme_auditoria
  FOR EACH ROW EXECUTE FUNCTION cme_bloquear_alteracao();
CREATE TRIGGER trg_cme_auditoria_sem_truncate BEFORE TRUNCATE ON cme_auditoria
  FOR EACH STATEMENT EXECUTE FUNCTION cme_bloquear_alteracao();

-- Em bancos sem a role klinsync_app (testes locais, PGlite) este bloco não faz nada.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'klinsync_app') THEN
    RETURN;
  END IF;
  REVOKE UPDATE, DELETE, TRUNCATE ON cme_leituras, cme_testes_leitura, cme_auditoria FROM klinsync_app;
END
$$;
