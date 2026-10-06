# Scripts da EC2 de backend

Provisionam a EC2 (Node 22 + PM2 + Nginx) e fazem o deploy puxando o código do bucket **`s3://klinsync-backend`**.

| Script         | Onde roda            | O que faz                                                                              |
| -------------- | -------------------- | -------------------------------------------------------------------------------------- |
| `setup-ec2.sh` | EC2 (uma vez, root)  | Instala Node/PM2/Nginx, cria usuário `klinsync`, env files, PM2 no boot, HTTPS opcional |
| `deploy.sh`    | EC2 (`klinsync-deploy`) | Baixa a release do S3, `npm ci` + build, troca `current`, recarrega PM2, health check, rollback automático |
| `rollback.sh`  | EC2 (`klinsync-rollback`) | Volta para a release anterior                                                          |
| `tune.sh`      | EC2 (`klinsync-tune`)    | Dimensiona PM2/Node/Nginx/kernel conforme vCPU e RAM da instância (roda também no boot) |
| `publish.sh`   | Sua máquina / CI     | `git archive` do HEAD → S3 (`releases/…` e `latest.txt`); `--deploy` aciona a EC2 via SSM |
| `common.sh`    | —                    | Funções compartilhadas                                                                 |

## Layout no S3

```
s3://klinsync-backend/
  releases/klinsync-backend-<data>-<sha>.tar.gz   código-fonte (raiz do repositório)
  releases/latest.txt                              chave da release atual
  scripts/                                         cópia destes scripts (usada no 1º setup)
```

## Primeira vez

1. **IAM da EC2** — instance profile com `AmazonSSMManagedInstanceCore` e a policy inline abaixo.
2. Na máquina local, publique: `scripts/publish.sh` (envia código e scripts).
3. Na EC2 (Ubuntu 24.04 ou Amazon Linux 2023):

```sh
aws s3 sync s3://klinsync-backend/scripts /tmp/klinsync-scripts --region us-east-2
sudo API_DOMAIN=api.meudominio.com.br CORS_ORIGIN=https://app.meudominio.com.br \
     CERT_EMAIL=voce@meudominio.com.br bash /tmp/klinsync-scripts/setup-ec2.sh
sudoedit /etc/klinsync/backend.env     # DATABASE_URL, RECAPTCHA_SECRET_KEY, CHECKIN_PHOTOS_BUCKET
sudo klinsync-deploy
```

## Dia a dia

```sh
scripts/publish.sh --deploy      # (local) publica e atualiza a EC2 via SSM (EC2_INSTANCE_ID=i-...)
sudo klinsync-deploy             # (EC2) puxa a última release do S3
sudo klinsync-rollback           # (EC2) volta uma versão
sudo -u klinsync env PM2_HOME=/home/klinsync/.pm2 pm2 logs klinsync-backend
```

## Detecção do sistema e dimensionamento automático

**Sistema:** o `setup-ec2.sh` lê `/etc/os-release` e escolhe o caminho de instalação:

| Sistema                  | Pacotes | Firewall | Observação                                         |
| ------------------------ | ------- | -------- | -------------------------------------------------- |
| Ubuntu 22.04 / 24.04     | `apt`   | UFW + fail2ban | certbot via apt                              |
| Debian 12 / 13           | `apt`   | UFW + fail2ban | idem                                         |
| Amazon Linux 2023        | `dnf`   | Security Group | certbot instalado em venv (`/opt/certbot`)   |
| Amazon Linux 2, outros   | —       | —        | recusado com mensagem clara (Node 22 exige glibc ≥ 2.28) |

Arquiteturas `x86_64` e `aarch64` (Graviton) são suportadas.

**Tamanho:** lê vCPU, RAM, swap, disco livre e o tipo da instância (IMDSv2) e valida:

- Mínimo para rodar: **700 MB de RAM e 3 GB livres** (cobre t3.micro/t4g.micro). Abaixo disso o script para
  (use `FORCE_SIZE=1` para ignorar, não recomendado). Recomendado: 2 vCPU e ~2 GB (t3.small ou maior).
- Com menos de 2 GB de RAM e sem swap, cria `/swapfile` (2× a RAM, entre 1 e 4 GB) para o `npm ci`/build não estourar a memória.

**Ajuste de recursos** (`tune.sh`): a memória deixada ao SO (256–1024 MB) e ao Nginx é descontada e o restante é dividido entre as instâncias do PM2.

| Item                | Regra                                                                          | t3.small (2 vCPU/2 GB) | c5.xlarge (4 vCPU/8 GB) |
| ------------------- | ------------------------------------------------------------------------------ | ---------------------- | ----------------------- |
| Instâncias PM2      | `min(vCPU, memória disponível / 384 MB, 8)`; `cluster` se > 1, senão `fork`    | 2 (cluster)            | 4 (cluster)             |
| Heap do Node        | 70% da memória de cada instância (`--max-old-space-size`)                      | 457 MB                 | 1193 MB                 |
| Reinício pelo PM2   | 90% da memória de cada instância (`max_memory_restart`)                        | 588 MB                 | 1534 MB                 |
| `UV_THREADPOOL_SIZE`| `2 × vCPU` (4 a 16)                                                            | 4                      | 8                       |
| Pool do banco       | `(DB_MAX_CONNECTIONS − 15) × 80% / instâncias` (3 a 25) → `DB_POOL_MAX`        | 25                     | 17                      |
| Nginx               | `worker_connections` 1024/2048/4096 por RAM; `keepalive` = 16 × instâncias     | 1024 / 32              | 2048 / 64               |
| Build               | `--max-old-space-size` de 65% da RAM no `npm run build`                        | 1235 MB                | 4096 MB                 |
| Kernel              | `vm.swappiness=10`, `net.core.somaxconn` conforme RAM                          |                        |                         |

Como aplicar e ajustar:

- O `setup-ec2.sh` já chama o `tune.sh`. Para refazer a qualquer momento: `sudo klinsync-tune`.
- O serviço `klinsync-tune.service` roda a cada boot e **só reaplica se o tipo/vCPU/RAM mudou**: ao redimensionar a EC2
  (parar → trocar o tipo → iniciar) o PM2, o Nginx e os limites se reajustam sozinhos.
- Override do nº de instâncias: `PM2_INSTANCES_OVERRIDE=<n>` em `/etc/klinsync/deploy.env`, depois `sudo klinsync-tune`.
- **Pool de conexões:** a EC2 de DB informa o `max_connections` calculado para ela. Copie-o para `DB_MAX_CONNECTIONS`
  em `/etc/klinsync/deploy.env` e rode `sudo klinsync-tune`; o resultado vai para `DB_POOL_MAX` no `backend.env`.
- Em modo `cluster` o estado em memória **não é compartilhado** entre instâncias: o app não deve guardar sessão,
  contador de rate limit ou cache que precise ser único dentro do processo (use o banco). Para forçar 1 instância: `PM2_INSTANCES_OVERRIDE=1`.

## Contrato com o código do backend

- Entrada: `dist/server.js` (mude com `APP_ENTRY` no setup ou em `/etc/klinsync/deploy.env`).
- Escuta em `HOST`/`PORT` (`127.0.0.1:3000`) e expõe **`GET /health`** (usado no health check do deploy).
- Lê a configuração de variáveis de ambiente, carregadas de `/etc/klinsync/backend.env` (`node --env-file`).
- Confia no proxy do Nginx (`X-Forwarded-For`) para obter o IP real do cliente (bloqueio de IP e logs de acesso).
- Precisa de `package.json` com script `build` (opcional) e, de preferência, `package-lock.json`.
- Deve ler `DB_POOL_MAX` (tamanho máximo do pool de conexões **por instância**) e responder bem a `SIGINT`/`SIGTERM`
  (o PM2 espera até 10 s antes de matar o processo).

## Arquivos na EC2

| Caminho                            | Conteúdo                                              |
| ---------------------------------- | ----------------------------------------------------- |
| `/etc/klinsync/deploy.env`         | Bucket, porta, entrada, nome do app PM2 e dimensionamento calculado (sem segredos) |
| `/etc/klinsync/backend.env`        | Segredos do app (`root:klinsync`, 640)                |
| `/opt/klinsync-backend/releases/*` | Releases extraídas (mantém 5)                         |
| `/opt/klinsync-backend/current`    | Symlink para a release ativa                          |
| `/opt/klinsync-backend/ecosystem.config.cjs` | Configuração do PM2 (gerada pelo `tune.sh`; não edite) |
| `/etc/nginx/conf.d/klinsync-upstream.conf`   | Upstream com keepalive (gerado pelo `tune.sh`)   |
| `/etc/sysctl.d/99-klinsync.conf`             | Ajustes de kernel (gerado pelo `tune.sh`)        |

## Policy inline da role da EC2

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::klinsync-backend" },
    { "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::klinsync-backend/*" }
  ]
}
```

Para as fotos de check-in (futuro), acrescente `s3:PutObject/GetObject/DeleteObject` no bucket de fotos.

## Observações

- Security Group do backend: 80/443 abertos; 22 só se usar SSH (com SSM não é necessário).
- Em Amazon Linux não há UFW: o isolamento é feito só pelo Security Group.
- Marque os scripts como executáveis no Git: `git update-index --chmod=+x scripts/*.sh`.
