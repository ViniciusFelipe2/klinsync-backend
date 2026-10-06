-- KlinSync — schema base (PostgreSQL puro, sem Supabase).
-- Autenticação (credenciais, sessões, MFA) e controle de acesso por papel/hospital ficam na API;
-- não há RLS. O banco só é acessível pelo backend (role klinsync_app).
-- Requer PostgreSQL >= 13 (gen_random_uuid nativo).

CREATE TYPE app_role AS ENUM ('master_admin', 'hospital_admin', 'operador');
CREATE TYPE sala_status AS ENUM ('livre', 'desmontagem', 'limpeza', 'remontagem');
CREATE TYPE tipo_evento_giro AS ENUM ('desmontagem', 'limpeza', 'remontagem');

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Identidade
-- ---------------------------------------------------------------------------
CREATE TABLE usuarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  senha_hash text NOT NULL,
  email_confirmado_em timestamptz DEFAULT now(),
  ultimo_login_em timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX usuarios_email_key ON usuarios (lower(email));
CREATE TRIGGER trg_usuarios_updated BEFORE UPDATE ON usuarios
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  familia uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expira_em timestamptz NOT NULL,
  revogado_em timestamptz,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_usuario_idx ON refresh_tokens (usuario_id);
CREATE INDEX refresh_tokens_familia_idx ON refresh_tokens (familia);

CREATE TABLE mfa_fatores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  friendly_name text,
  segredo_cifrado text NOT NULL,
  status text NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified', 'verified')),
  ultimo_passo bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mfa_fatores_usuario_idx ON mfa_fatores (usuario_id);

-- ---------------------------------------------------------------------------
-- Hospitais, módulos e perfis
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  cnpj text,
  endereco text,
  contato_nome text,
  contato_email text,
  contato_telefone text,
  status text NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo', 'inativo', 'inadimplente')),
  contratado_em date NOT NULL DEFAULT current_date,
  limite_salas integer CHECK (limite_salas IS NULL OR limite_salas > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE features (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chave text NOT NULL UNIQUE,
  nome_exibicao text NOT NULL,
  descricao text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_features (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  feature_id uuid NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  habilitada boolean NOT NULL DEFAULT true,
  habilitada_em timestamptz NOT NULL DEFAULT now(),
  habilitada_por uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  UNIQUE (tenant_id, feature_id)
);

CREATE TABLE tenant_features_historico (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  feature_id uuid NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  habilitada boolean NOT NULL,
  alterado_por uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usuarios_perfil (
  id uuid PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  nome text NOT NULL DEFAULT '',
  email text,
  role app_role NOT NULL,
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  feature_id uuid REFERENCES features(id) ON DELETE RESTRICT,
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usuarios_perfil_role_coerente CHECK (
    (role = 'master_admin' AND tenant_id IS NULL AND feature_id IS NULL)
    OR (role = 'hospital_admin' AND tenant_id IS NOT NULL AND feature_id IS NULL)
    OR (role = 'operador' AND tenant_id IS NOT NULL AND feature_id IS NOT NULL)
  )
);
CREATE INDEX usuarios_perfil_tenant_idx ON usuarios_perfil (tenant_id);
CREATE TRIGGER trg_usuarios_perfil_updated BEFORE UPDATE ON usuarios_perfil
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE convites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  nome text NOT NULL,
  role app_role NOT NULL,
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  feature_id uuid REFERENCES features(id) ON DELETE SET NULL,
  token_hash text NOT NULL,
  criado_por uuid,
  expira_em timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  aceito_em timestamptz,
  aceito_por uuid,
  revogado_em timestamptz,
  revogado_por uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX convites_token_hash_key ON convites (token_hash);
CREATE UNIQUE INDEX convites_email_pendente_key ON convites (lower(email))
  WHERE aceito_em IS NULL AND revogado_em IS NULL;
CREATE INDEX convites_tenant_idx ON convites (tenant_id);
CREATE TRIGGER trg_convites_updated BEFORE UPDATE ON convites
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Segurança e auditoria
-- ---------------------------------------------------------------------------
CREATE TABLE log_acessos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  email_tentado text,
  tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  ip text,
  pais_regiao text,
  sucesso boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX log_acessos_created_at_idx ON log_acessos (created_at DESC);
CREATE INDEX log_acessos_ip_idx ON log_acessos (ip);
CREATE INDEX log_acessos_tenant_idx ON log_acessos (tenant_id, created_at DESC);

CREATE TABLE log_acoes_sensiveis (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  acao text NOT NULL,
  detalhes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX log_acoes_created_at_idx ON log_acoes_sensiveis (created_at DESC);

CREATE TABLE config_seguranca (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  max_tentativas int NOT NULL DEFAULT 5,
  janela_minutos int NOT NULL DEFAULT 15,
  bloqueio_minutos int NOT NULL DEFAULT 15,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ip_bloqueios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ip text NOT NULL UNIQUE,
  motivo text NOT NULL DEFAULT '',
  permanente boolean NOT NULL DEFAULT false,
  bloqueado_ate timestamptz,
  criado_por uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_ip_bloqueios_updated BEFORE UPDATE ON ip_bloqueios
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Limitador de taxa compartilhado entre as instâncias do backend (janela fixa por chave).
CREATE TABLE rate_limits (
  chave text PRIMARY KEY,
  janela_inicio timestamptz NOT NULL DEFAULT now(),
  tentativas integer NOT NULL DEFAULT 1
);

-- ---------------------------------------------------------------------------
-- Módulo Check-in de cirurgiões
-- ---------------------------------------------------------------------------
CREATE TABLE check_ins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  doctor_name text NOT NULL,
  photo_path text NOT NULL,
  checked_in_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_check_ins_tenant_data ON check_ins (tenant_id, checked_in_at DESC);
CREATE TRIGGER trg_check_ins_updated BEFORE UPDATE ON check_ins
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Módulo Giro de sala
-- ---------------------------------------------------------------------------
CREATE TABLE salas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome text NOT NULL,
  ativa boolean NOT NULL DEFAULT true,
  status_atual sala_status NOT NULL DEFAULT 'livre',
  cirurgia_atual text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_salas_tenant ON salas (tenant_id);
CREATE TRIGGER trg_salas_updated BEFORE UPDATE ON salas
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE eventos_giro (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sala_id uuid NOT NULL REFERENCES salas(id) ON DELETE CASCADE,
  tipo_evento tipo_evento_giro NOT NULL,
  inicio timestamptz NOT NULL DEFAULT now(),
  fim timestamptz,
  duracao_segundos integer,
  usuario_inicio_id uuid NOT NULL REFERENCES usuarios(id),
  usuario_fim_id uuid REFERENCES usuarios(id),
  cirurgia_anterior text,
  cirurgia_proxima text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_eventos_giro_sala_inicio ON eventos_giro (sala_id, inicio DESC);
CREATE INDEX idx_eventos_giro_abertos ON eventos_giro (sala_id) WHERE fim IS NULL;

CREATE TABLE eventos_sala_parada (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sala_id uuid NOT NULL REFERENCES salas(id) ON DELETE CASCADE,
  inicio timestamptz NOT NULL DEFAULT now(),
  fim timestamptz,
  duracao_segundos integer,
  usuario_inicio_id uuid NOT NULL REFERENCES usuarios(id),
  usuario_fim_id uuid REFERENCES usuarios(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_eventos_parada_sala_inicio ON eventos_sala_parada (sala_id, inicio DESC);
CREATE INDEX idx_eventos_parada_abertos ON eventos_sala_parada (sala_id) WHERE fim IS NULL;

-- Vínculo permanente sala <-> tablet (um tablet por sala).
CREATE TABLE sala_dispositivos (
  sala_id uuid PRIMARY KEY REFERENCES salas(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  user_id uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  ultimo_sinal timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sala_dispositivos_device ON sala_dispositivos (device_id);
