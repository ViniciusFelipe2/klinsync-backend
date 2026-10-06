# KlinSync Backend

API REST do KlinSync (Node.js 22 + TypeScript + Fastify + PostgreSQL), pensada para rodar numa **EC2** sob **PM2** atrás do **Nginx**.
Recria, sem Supabase, as server functions do projeto mãe (`trizion`) seguindo o contrato em
[`klinsync-frontend/docs/API-CONTRACT.md`](https://github.com/ViniciusFelipe2/klinsync-frontend/blob/main/docs/API-CONTRACT.md).

```
Navegador ──HTTPS──▶ Nginx (EC2 backend) ──▶ PM2 (cluster) ──▶ PostgreSQL (EC2 DB)
 S3 + CloudFront                               klinsync-backend         klinsync-db
```

## O que a API faz

| Área | Endpoints | Observações |
| --- | --- | --- |
| Autenticação | `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/me` | JWT de acesso (15 min) + refresh token opaco com **rotação** e detecção de reuso |
| MFA (TOTP) | `/auth/mfa/*` | Segredos cifrados (AES-256-GCM); código de uso único (anti-replay) |
| Proteções de login | no `/auth/login` | Rate limit por IP, reCAPTCHA v3, bloqueio por IP/tentativas, log de acessos, geolocalização |
| Sessão e módulos | `/sessao`, `/sessao/destino-inicial`, `/modulos/*` | Destino por papel, features por hospital |
| Painel master | `/master/*`, `/auditoria` | Hospitais, features, salas, usuários, segurança, postura, expurgo LGPD |
| Convites | `/convites/*` | Token só em hash; validação anti-enumeração |
| Hospital | `/hospital/*` | Resumo, check-ins, giro, paradas, estatísticas, salas, acessos |
| Check-in | `/checkins/*` | Fotos em **S3 privado** (URL assinada curta), valida a assinatura do arquivo |
| Giro de sala | `/giro/*` | Etapas com regras no servidor, paradas, vínculo sala↔tablet |
| Saúde | `GET /health` | Usado pelo `deploy.sh` (rollback automático se falhar) |

Regras transversais: todo acesso é filtrado pelo **hospital do token** (nunca por parâmetro do cliente); perfil inativo equivale a sessão inválida;
erros são `{ "message": "..." }` em português, sem vazar detalhes internos.

## Rodando localmente

Pré-requisitos: Node 22+ e um PostgreSQL com o schema do [`klinsync-db`](https://github.com/ViniciusFelipe2/klinsync-db) aplicado
(`psql -f migrations/0001_schema.sql -f migrations/0002_seed.sql`).

```sh
cp .env.example .env        # preencha DATABASE_URL e os segredos (openssl rand -hex 32)
npm install
npm run dev                 # http://127.0.0.1:3000  (tsx watch)
```

Criar o primeiro usuário master (a senha é gerada e exibida uma vez, ou use `MASTER_PASSWORD`):

```sh
npm run build
npm run create-master -- --email voce@empresa.com --nome "Seu Nome"
# na EC2:  sudo -u klinsync node --env-file=/etc/klinsync/backend.env /opt/klinsync-backend/current/dist/cli/create-master.js --email ... --nome ...
```

## Testes

```sh
npm test            # integração: Fastify + PostgreSQL real (PGlite) com as migrations do klinsync-db
npm run typecheck
npm run sync-schema # copia ../klinsync-db/migrations para test/db/ (rode ao mudar o schema)
```

Os testes não dependem de rede, S3 nem de um Postgres instalado. `test/db/` espelha as migrations do `klinsync-db`.

## Testando tudo localmente (sem EC2)

Banco Postgres embutido (PGlite) em `.local-db/` (fora do Git), com o schema do `klinsync-db`:

```sh
cp .env.import.example .env.import     # preencha SUPABASE_DB_URL (e, para fotos, SUPABASE_URL + SERVICE_ROLE_KEY)
npm run local:import -- --dry-run      # simula e relata, sem gravar
npm run local:import -- --fotos        # importa de verdade (+ copia as fotos para o S3)
npm run local:seed                     # (opcional) dados de DEMONSTRAÇÃO: hospital, salas e 1 usuário por papel (senha Demo#Senha2026)
npm run local:dev                      # API em http://127.0.0.1:3000 sobre o banco local
npm run local:smoke                    # roteiro automático que percorre os fluxos principais dos 4 papéis
npm run local:reset                    # apaga o banco local para recomeçar
npm run local:dump                     # gera klinsync-dados.sql para carregar na EC2 de DB depois
```

Para usar o front: em `klinsync-frontend/.env` ponha `VITE_API_URL=http://127.0.0.1:3000` e rode `npm run dev` (http://localhost:5173).
Para ver as fotos, rode a API com `CHECKIN_PHOTOS_BUCKET=klinsync-checkin-fotos` (usa o S3 com as suas credenciais da AWS).
Carregar o dump no banco definitivo: `psql -v ON_ERROR_STOP=1 -f klinsync-dados.sql postgresql://klinsync_app:SENHA@HOST/klinsync`
(apaga os dados existentes no destino; o schema precisa estar aplicado).

## Migrando os dados do Supabase

A ferramenta `import-supabase` lê o Postgres do Supabase **somente para leitura** (a conexão é aberta com `default_transaction_read_only = on`)
e grava tudo no banco do KlinSync **numa única transação**: se algo falhar, nada fica pela metade. Ela traz:

| O quê | Como |
| --- | --- |
| Tabelas e dados | `tenants`, `features`, `tenant_features(+histórico)`, `usuarios_perfil`, `convites`, `config_seguranca`, `ip_bloqueios`, `log_acessos`, `log_acoes_sensiveis`, `check_ins`, `salas`, `eventos_giro`, `eventos_sala_parada`, `sala_dispositivos`, com os **mesmos ids** |
| Usuários e senhas | `auth.users` → `usuarios`, com o hash **bcrypt** original: cada pessoa continua entrando com a senha de sempre e o hash vira scrypt no primeiro login |
| MFA (TOTP) | `auth.mfa_factors` verificados → `mfa_fatores`, segredo cifrado: o mesmo app autenticador continua valendo |
| Fotos de check-in | Storage do Supabase → bucket S3, com os mesmos caminhos (`--fotos`) |

Ajustes automáticos (todos listados como avisos no final): papel legado `administrador` → `hospital_admin`; registros órfãos (perfil sem conta de login,
evento com autor inexistente, sala sem hospital) são ignorados e contados; referências a usuários apagados viram nulas nos logs.
Sessões (refresh tokens) não migram: todos entram de novo uma vez.

### Passo a passo

1. **Pré-requisitos:** schema aplicado no destino (`sudo klinsync-db-deploy`), backend com `DATABASE_URL`, `JWT_*`, `MFA_ENCRYPTION_KEY` e
   (para fotos) `CHECKIN_PHOTOS_BUCKET` configurados em `/etc/klinsync/backend.env`.
2. **String de conexão do Supabase** (Dashboard → Settings → Database → Connection string). Use a **conexão direta** ou o **Session pooler** (porta 5432);
   o *Transaction pooler* (porta 6543) não serve. O host direto (`db.<projeto>.supabase.co`) é só IPv6: numa EC2 sem IPv6 use o Session pooler
   (`postgres.<projeto>@aws-0-<região>.pooler.supabase.com:5432`).
3. **Rode na EC2 de backend** (alcança o banco pela rede privada e a internet), sem gravar o segredo em arquivo:

```sh
cd /opt/klinsync-backend/current
export SUPABASE_DB_URL='postgresql://postgres.<projeto>:SENHA@aws-0-<região>.pooler.supabase.com:5432/postgres'

# 1) simulação: valida tudo e relata, sem gravar
sudo -E -u klinsync node --env-file=/etc/klinsync/backend.env dist/cli/import-supabase.js --dry-run

# 2) importação real (o banco de destino precisa estar vazio)
sudo -E -u klinsync node --env-file=/etc/klinsync/backend.env dist/cli/import-supabase.js

# 3) fotos para o S3 (precisa da chave service_role; a role da EC2 precisa de PutObject no bucket)
export SUPABASE_URL='https://<projeto>.supabase.co' SUPABASE_SERVICE_ROLE_KEY='...'
sudo -E -u klinsync node --env-file=/etc/klinsync/backend.env dist/cli/import-supabase.js --so-fotos
```

Opções: `--limpar-destino` (apaga **tudo** no destino antes de importar), `--fotos` (banco + fotos de uma vez), `--so-fotos`, `--bucket-origem` (padrão `checkin-fotos`).
Fotos ausentes ou com falha vão para `fotos-pendentes.txt`; rodar `--so-fotos` de novo tenta de novo (é idempotente).

### Conferência e virada

- Compare os totais do relatório com o Supabase (`select count(*) ...`) e entre com um usuário de cada papel (master, admin do hospital, operador).
- **Virada sem perda de dados:** faça o `--dry-run` e a importação de teste antes; no dia, coloque o sistema antigo em modo somente leitura (ou avise a janela),
  rode `--limpar-destino` + `--fotos`, e só então publique o front apontando para a nova API (`VITE_API_URL`). O Supabase não é alterado: serve de plano de volta.
- Depois da virada, a checagem "Senhas com hash forte" do painel de segurança mostra **atenção** até todos entrarem uma vez (bcrypt pendente).
- Para reaproveitar a ferramenta em testes: `npm test` (o teste `importacao-supabase` monta um Supabase de mentira com os casos problemáticos).

## Variáveis de ambiente

Ver [.env.example](.env.example). Em produção vêm de `/etc/klinsync/backend.env` (gerado pelo `scripts/setup-ec2.sh`).

| Variável | Descrição |
| --- | --- |
| `DATABASE_URL`, `DB_POOL_MAX` | Postgres e tamanho do pool **por instância** (o `klinsync-tune` calcula `DB_POOL_MAX` conforme a EC2) |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Segredos (≥ 32 caracteres) |
| `MFA_ENCRYPTION_KEY` | Cifra os segredos TOTP; se vazio deriva de `JWT_REFRESH_SECRET` |
| `CORS_ORIGIN` | Origens permitidas (vírgula). Ex.: `https://app.seudominio.com.br` |
| `CHECKIN_PHOTOS_BUCKET`, `AWS_REGION` | Bucket S3 privado das fotos (a role da EC2 precisa de Get/Put/Delete/List) |
| `RECAPTCHA_SECRET_KEY` | Vazio = captcha desativado |
| `TRUST_PROXY` | `loopback` (Nginx local) para ler o IP real em `X-Forwarded-For` |
| `APP_TIMEZONE` | Fuso do hospital para "hoje" e limites de dia (padrão `America/Sao_Paulo`) |

## Estrutura

```
src/
  server.ts            entrada (PM2): sobe o Fastify, encerramento gracioso
  app.ts               plugins, CORS, erros, hook de autenticação, registro das rotas
  config.ts            variáveis de ambiente validadas
  db/                  pool `pg` + transações
  lib/                 senha (scrypt), JWT, TOTP, sessões, limites, perfis/escopo, SQL helpers
  services/            reCAPTCHA, HIBP, geolocalização e S3 (injetáveis nos testes)
  routes/              auth, sessao, master, seguranca, auditoria, convites, hospital, checkins, giro
  cli/create-master.ts primeiro usuário master
test/                  integração (vitest + PGlite)
scripts/               provisionamento e deploy na EC2 (ver scripts/README.md)
```

## Decisões relevantes para a EC2

- **Cluster do PM2:** não há estado em memória; rate limit, sessões e MFA ficam no banco, então qualquer nº de instâncias funciona.
- **Pool do banco:** `DB_POOL_MAX × instâncias` precisa caber no `max_connections` do Postgres (o tune cuida disso).
- **Segredos nunca em log:** nenhum corpo/cabeçalho de autenticação é registrado.
- **Fotos:** nunca públicas; o bucket é acessado só pela role da EC2 e entregue por URL assinada de 5 a 30 min.
- **Status da sala** (`livre/desmontagem/limpeza/remontagem`) é mantido pela API na mesma transação dos eventos
  (no projeto mãe isso vinha de lógica do banco que não estava nas migrations do repositório).

## Deploy

Push na `main` → [workflow](.github/workflows/deploy-s3.yml): typecheck, testes, build, publica a release no S3 com versão semântica.
A EC2 baixa e ativa com `sudo klinsync-deploy` (build, PM2, health check, rollback). Detalhes em [scripts/README.md](scripts/README.md).
