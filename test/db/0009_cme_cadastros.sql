-- Módulo CME, Fase 2: caixas, itens de cada caixa, colaboradores com crachá e login por crachá no computador da sala.
-- Só acrescenta objetos e colunas: nada do giro de sala ou do check-in é alterado.
-- Para desfazer: migrations/down/0009_cme_cadastros.down.sql (o migrate.sh não lê subpastas).

-- Computador de sala: o login fica preso a uma sala, definida pela equipe master.
ALTER TABLE cme_contas ADD COLUMN sala_id uuid REFERENCES salas(id) ON DELETE CASCADE;
ALTER TABLE cme_contas ADD CONSTRAINT cme_contas_sala_coerente CHECK ((tipo = 'estacao_sala') = (sala_id IS NOT NULL));

-- Tamanho do código do crachá e a chave de teste que permite digitar o número do crachá.
ALTER TABLE cme_config
  ADD COLUMN tamanho_cracha_mm double precision NOT NULL DEFAULT 12 CHECK (tamanho_cracha_mm BETWEEN 3 AND 15),
  ADD COLUMN permitir_cracha_digitado boolean NOT NULL DEFAULT false;

-- Caixa = um código do tipo "caixa" com os dados próprios de caixa. O nome fica no código (cme_codigos.rotulo).
CREATE TABLE cme_caixas (
  codigo_id uuid PRIMARY KEY REFERENCES cme_codigos(id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  tipo_caixa text NOT NULL DEFAULT 'casa' CHECK (tipo_caixa IN ('casa', 'consignada')),
  descricao text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cme_caixas_tenant_idx ON cme_caixas (tenant_id);

-- Códigos de caixa criados na Fase 1 viram caixas da casa, sem perder nada.
INSERT INTO cme_caixas (codigo_id, tenant_id) SELECT id, tenant_id FROM cme_codigos WHERE tipo = 'caixa';

-- Em qual caixa cada item (peça com código próprio) fica. Um item está em uma caixa por vez.
CREATE TABLE cme_caixa_itens (
  item_id uuid PRIMARY KEY REFERENCES cme_codigos(id) ON DELETE RESTRICT,
  caixa_id uuid NOT NULL REFERENCES cme_caixas(codigo_id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cme_caixa_itens_caixa_idx ON cme_caixa_itens (caixa_id);
CREATE TRIGGER trg_cme_caixa_itens_updated BEFORE UPDATE ON cme_caixa_itens
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Colaboradores: só o necessário (LGPD). O Data Matrix do crachá guarda o número do crachá.
CREATE TABLE cme_colaboradores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  nome text NOT NULL,
  numero_cracha text NOT NULL,
  perfil text NOT NULL CHECK (perfil IN ('cme', 'sala')),
  ativo boolean NOT NULL DEFAULT true,
  criado_por uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, numero_cracha)
);
CREATE TRIGGER trg_cme_colaboradores_updated BEFORE UPDATE ON cme_colaboradores
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Quem está logado em cada computador de sala. Só o resumo (hash) do token fica aqui.
CREATE TABLE cme_sessoes_cracha (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  estacao_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  sala_id uuid REFERENCES salas(id) ON DELETE SET NULL,
  colaborador_id uuid NOT NULL REFERENCES cme_colaboradores(id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE,
  criada_em timestamptz NOT NULL DEFAULT now(),
  ultimo_uso timestamptz NOT NULL DEFAULT now(),
  encerrada_em timestamptz,
  motivo_fim text
);
CREATE INDEX cme_sessoes_abertas_idx ON cme_sessoes_cracha (estacao_id) WHERE encerrada_em IS NULL;

-- Leituras feitas na sala registram também o colaborador que estava logado.
ALTER TABLE cme_leituras ADD COLUMN colaborador_id uuid REFERENCES cme_colaboradores(id) ON DELETE RESTRICT;
