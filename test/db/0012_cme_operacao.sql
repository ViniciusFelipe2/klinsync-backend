-- Módulo CME: operação dentro do CME (expurgo, preparo e esterilização) e o status de cada caixa.
-- Só acrescenta objetos e colunas. Para desfazer: migrations/down/0012_cme_operacao.down.sql (o migrate.sh não lê subpastas).

-- Novo tipo de login: o computador que fica dentro do CME. O colaborador entra pelo crachá e escolhe o setor.
ALTER TABLE cme_contas DROP CONSTRAINT cme_contas_tipo_check;
ALTER TABLE cme_contas ADD CONSTRAINT cme_contas_tipo_check
  CHECK (tipo IN ('chefe', 'colaborador', 'estacao_sala', 'painel_setor', 'estacao_cme'));

-- A conferência item a item agora acontece também no expurgo e no preparo. As antigas são todas da sala.
ALTER TABLE cme_conferencias ADD COLUMN setor text NOT NULL DEFAULT 'sala' CHECK (setor IN ('sala', 'expurgo', 'preparo'));

-- Máquinas de esterilização (autoclaves) e os ciclos de cada uma, com o tempo em minutos.
CREATE TABLE cme_maquinas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  nome text NOT NULL,
  ativo boolean NOT NULL DEFAULT true,
  criado_por uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cme_maquinas_tenant_idx ON cme_maquinas (tenant_id);
CREATE TRIGGER trg_cme_maquinas_updated BEFORE UPDATE ON cme_maquinas
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE cme_maquina_ciclos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  maquina_id uuid NOT NULL REFERENCES cme_maquinas(id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  nome text NOT NULL,
  duracao_min integer NOT NULL CHECK (duracao_min BETWEEN 1 AND 1440),
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cme_maquina_ciclos_maquina_idx ON cme_maquina_ciclos (maquina_id);

-- Carga = as caixas colocadas em uma máquina para um ciclo. Fica "montando" até o colaborador iniciar o ciclo.
-- O ciclo termina sozinho em termina_em: não existe status "concluída", a hora decide.
CREATE TABLE cme_cargas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  maquina_id uuid NOT NULL REFERENCES cme_maquinas(id) ON DELETE RESTRICT,
  ciclo_id uuid NOT NULL REFERENCES cme_maquina_ciclos(id) ON DELETE RESTRICT,
  -- Nome e tempo copiados do ciclo: mudar a configuração depois não altera o que já rodou.
  ciclo_nome text NOT NULL,
  duracao_min integer NOT NULL,
  estacao_id uuid NOT NULL,
  colaborador_id uuid NOT NULL REFERENCES cme_colaboradores(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'montando' CHECK (status IN ('montando', 'iniciada')),
  criada_em timestamptz NOT NULL DEFAULT now(),
  iniciada_em timestamptz,
  iniciada_por uuid REFERENCES cme_colaboradores(id) ON DELETE RESTRICT,
  termina_em timestamptz,
  CHECK ((status = 'iniciada') = (iniciada_em IS NOT NULL AND termina_em IS NOT NULL))
);
-- Uma máquina só tem uma carga sendo montada por vez.
CREATE UNIQUE INDEX cme_cargas_montando_idx ON cme_cargas (maquina_id) WHERE status = 'montando';
CREATE INDEX cme_cargas_maquina_idx ON cme_cargas (maquina_id, termina_em DESC);
CREATE INDEX cme_cargas_tenant_idx ON cme_cargas (tenant_id, iniciada_em DESC);

-- Caixas de cada carga. Enquanto a carga está sendo montada, uma caixa bipada por engano pode ser retirada.
CREATE TABLE cme_carga_caixas (
  carga_id uuid NOT NULL REFERENCES cme_cargas(id) ON DELETE RESTRICT,
  caixa_id uuid NOT NULL REFERENCES cme_caixas(codigo_id) ON DELETE RESTRICT,
  colaborador_id uuid NOT NULL REFERENCES cme_colaboradores(id) ON DELETE RESTRICT,
  adicionada_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (carga_id, caixa_id)
);
CREATE INDEX cme_carga_caixas_caixa_idx ON cme_carga_caixas (caixa_id);

-- Onde a caixa está agora: o último setor em que ela foi bipada. Vazio = ainda não foi bipada em lugar nenhum.
ALTER TABLE cme_caixas
  ADD COLUMN local text CHECK (local IN ('sala', 'expurgo', 'preparo', 'esterilizacao')),
  ADD COLUMN local_desde timestamptz,
  ADD COLUMN local_sala_id uuid REFERENCES salas(id) ON DELETE SET NULL,
  ADD COLUMN local_carga_id uuid REFERENCES cme_cargas(id) ON DELETE SET NULL;
CREATE INDEX cme_caixas_local_idx ON cme_caixas (tenant_id, local);

-- Histórico de por onde cada caixa passou (rastreabilidade). Só aceita inclusão.
CREATE TABLE cme_movimentos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  caixa_id uuid NOT NULL REFERENCES cme_caixas(codigo_id) ON DELETE RESTRICT,
  setor text NOT NULL CHECK (setor IN ('sala', 'expurgo', 'preparo', 'esterilizacao')),
  sala_id uuid REFERENCES salas(id) ON DELETE SET NULL,
  carga_id uuid REFERENCES cme_cargas(id) ON DELETE SET NULL,
  colaborador_id uuid NOT NULL REFERENCES cme_colaboradores(id) ON DELETE RESTRICT,
  estacao_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cme_movimentos_caixa_idx ON cme_movimentos (caixa_id, created_at DESC);
CREATE INDEX cme_movimentos_tenant_idx ON cme_movimentos (tenant_id, created_at DESC);

-- Só bloqueia apagar: as colunas sala_id e carga_id precisam poder ser esvaziadas pelo próprio banco (ON DELETE SET NULL).
CREATE TRIGGER trg_cme_movimentos_sem_delete BEFORE DELETE ON cme_movimentos
  FOR EACH ROW EXECUTE FUNCTION cme_bloquear_alteracao();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'klinsync_app') THEN
    RETURN;
  END IF;
  REVOKE UPDATE, DELETE, TRUNCATE ON cme_movimentos FROM klinsync_app;
END
$$;
