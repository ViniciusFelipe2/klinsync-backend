-- Imita o banco do Supabase do projeto mãe (colunas e tipos iguais; sem FKs, para podermos criar órfãos de propósito).
CREATE SCHEMA auth;
CREATE TYPE app_role AS ENUM ('operador', 'administrador', 'master_admin', 'hospital_admin');
CREATE TYPE sala_status AS ENUM ('livre', 'desmontagem', 'limpeza', 'remontagem');
CREATE TYPE tipo_evento_giro AS ENUM ('desmontagem', 'limpeza', 'remontagem');
CREATE TYPE auth.factor_type AS ENUM ('totp', 'webauthn', 'phone');
CREATE TYPE auth.factor_status AS ENUM ('unverified', 'verified');

CREATE TABLE auth.users (
  id uuid PRIMARY KEY, email text, encrypted_password text, email_confirmed_at timestamptz,
  last_sign_in_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), deleted_at timestamptz
);
CREATE TABLE auth.mfa_factors (
  id uuid PRIMARY KEY, user_id uuid, friendly_name text, factor_type auth.factor_type, status auth.factor_status,
  secret text, created_at timestamptz DEFAULT now()
);

CREATE TABLE public.tenants (
  id uuid PRIMARY KEY, nome text NOT NULL, cnpj text, endereco text, contato_nome text, contato_email text,
  contato_telefone text, status text NOT NULL DEFAULT 'ativo', contratado_em date NOT NULL DEFAULT current_date,
  limite_salas integer, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.features (id uuid PRIMARY KEY, chave text NOT NULL, nome_exibicao text NOT NULL, descricao text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.tenant_features (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, feature_id uuid NOT NULL, habilitada boolean NOT NULL DEFAULT true, habilitada_em timestamptz NOT NULL DEFAULT now(), habilitada_por uuid);
CREATE TABLE public.tenant_features_historico (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, feature_id uuid NOT NULL, habilitada boolean NOT NULL, alterado_por uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.usuarios_perfil (id uuid PRIMARY KEY, nome text NOT NULL DEFAULT '', email text, role app_role NOT NULL, tenant_id uuid, feature_id uuid, ativo boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.convites (id uuid PRIMARY KEY, email text NOT NULL, nome text NOT NULL, role app_role NOT NULL, tenant_id uuid, feature_id uuid, token_hash text NOT NULL, criado_por uuid, expira_em timestamptz NOT NULL, aceito_em timestamptz, aceito_por uuid, revogado_em timestamptz, revogado_por uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.config_seguranca (id boolean PRIMARY KEY DEFAULT true, max_tentativas int NOT NULL DEFAULT 5, janela_minutos int NOT NULL DEFAULT 15, bloqueio_minutos int NOT NULL DEFAULT 15, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.ip_bloqueios (id uuid PRIMARY KEY, ip text NOT NULL, motivo text NOT NULL DEFAULT '', permanente boolean NOT NULL DEFAULT false, bloqueado_ate timestamptz, criado_por uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.log_acessos (id uuid PRIMARY KEY, usuario_id uuid, email_tentado text, tenant_id uuid, ip text, pais_regiao text, sucesso boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.log_acoes_sensiveis (id uuid PRIMARY KEY, usuario_id uuid, acao text NOT NULL, detalhes jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.check_ins (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, doctor_name text NOT NULL, photo_path text NOT NULL, checked_in_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.salas (id uuid PRIMARY KEY, tenant_id uuid, nome text NOT NULL, ativa boolean NOT NULL DEFAULT true, status_atual sala_status NOT NULL DEFAULT 'livre', cirurgia_atual text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.eventos_giro (id uuid PRIMARY KEY, sala_id uuid NOT NULL, tipo_evento tipo_evento_giro NOT NULL, inicio timestamptz NOT NULL DEFAULT now(), fim timestamptz, duracao_segundos integer, usuario_inicio_id uuid NOT NULL, usuario_fim_id uuid, cirurgia_anterior text, cirurgia_proxima text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.eventos_sala_parada (id uuid PRIMARY KEY, sala_id uuid NOT NULL, inicio timestamptz NOT NULL DEFAULT now(), fim timestamptz, duracao_segundos integer, usuario_inicio_id uuid NOT NULL, usuario_fim_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.sala_dispositivos (sala_id uuid PRIMARY KEY, device_id text NOT NULL, user_id uuid, ultimo_sinal timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now());
