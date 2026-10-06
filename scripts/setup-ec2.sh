#!/usr/bin/env bash
# =============================================================================
# KlinSync — Preparação ÚNICA da EC2 de BACKEND (Node.js 22 + PM2 + Nginx)
#
# Detecta o sistema (Ubuntu 22.04/24.04, Debian 12/13 ou Amazon Linux 2023) e o tamanho da
# instância (vCPU/RAM/disco) e ajusta PM2, Node, Nginx e kernel para os recursos disponíveis.
# Rodar como root:
#
#   sudo API_DOMAIN=api.meudominio.com.br CORS_ORIGIN=https://app.meudominio.com.br \
#        CERT_EMAIL=voce@meudominio.com.br bash setup-ec2.sh
#
# Pré-requisito: instance profile (IAM role) com leitura no bucket S3 do backend (ver README).
# Idempotente: pode ser rodado de novo. Para reajustar após redimensionar a EC2: klinsync-tune.
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/common.sh"

# ----------------------------- CONFIGURAÇÃO ----------------------------------
AWS_REGION="${AWS_REGION:-us-east-2}"
BACKEND_BUCKET="${BACKEND_BUCKET:-klinsync-backend}"
API_DOMAIN="${API_DOMAIN:-api.meudominio.com.br}"
CORS_ORIGIN="${CORS_ORIGIN:-https://app.meudominio.com.br}"
CERT_EMAIL="${CERT_EMAIL:-}"
ENABLE_HTTPS="${ENABLE_HTTPS:-1}"
APP_DIR="${APP_DIR:-/opt/klinsync-backend}"
APP_PORT="${APP_PORT:-3000}"
APP_ENTRY="${APP_ENTRY:-dist/server.js}"      # arquivo de entrada dentro da release
PM2_APP_NAME="${PM2_APP_NAME:-klinsync-backend}"
HEALTH_PATH="${HEALTH_PATH:-/health}"
DATABASE_URL="${DATABASE_URL:-}"              # postgresql://klinsync_app:SENHA@IP_PRIVADO_DB:5432/klinsync
DB_MAX_CONNECTIONS="${DB_MAX_CONNECTIONS:-100}"  # max_connections do Postgres (a EC2 de DB informa o valor)
PM2_INSTANCES_OVERRIDE="${PM2_INSTANCES_OVERRIDE:-}"  # força o nº de instâncias PM2 (vazio = automático)
# -----------------------------------------------------------------------------

require_root
detect_os
detect_resources
log "Sistema: $OS_NAME ($ARCH) | gerenciador: $PKG | firewall: $FIREWALL"
validate_size backend
ensure_swap
[ "$API_DOMAIN" != "api.meudominio.com.br" ] || warn "API_DOMAIN é o valor de exemplo. Informe o seu domínio real."

log "Atualizando sistema e instalando dependências ($PKG)"
if [ "$PKG" = apt ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get upgrade -y
  pkg_install ca-certificates curl gnupg unzip openssl nginx ufw fail2ban unattended-upgrades
  dpkg-reconfigure -f noninteractive unattended-upgrades
else
  dnf upgrade -y
  pkg_install curl-minimal unzip openssl nginx tar gzip
fi

log "Instalando Node.js 22"
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q '^v22'; then
  if [ "$PKG" = apt ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  else
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
  fi
  pkg_install nodejs
fi

log "Instalando AWS CLI"
if ! command -v aws >/dev/null 2>&1; then
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$ARCH.zip" -o /tmp/awscli.zip
  unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/awscli.zip
fi

log "Instalando PM2"
npm install -g pm2

log "Criando usuário e diretórios"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$APP_HOME" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR/releases" "$CONFIG_DIR" "$LIB_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 755 "$CONFIG_DIR"

log "Gravando $DEPLOY_ENV (configuração sem segredos)"
cat > "$DEPLOY_ENV" <<EOF
AWS_REGION=$AWS_REGION
AWS_DEFAULT_REGION=$AWS_REGION
BACKEND_BUCKET=$BACKEND_BUCKET
APP_DIR=$APP_DIR
APP_PORT=$APP_PORT
APP_ENTRY=$APP_ENTRY
PM2_APP_NAME=$PM2_APP_NAME
HEALTH_PATH=$HEALTH_PATH
KEEP_RELEASES=5
DB_MAX_CONNECTIONS=$DB_MAX_CONNECTIONS
PM2_INSTANCES_OVERRIDE=$PM2_INSTANCES_OVERRIDE
EOF
chmod 644 "$DEPLOY_ENV"

if [ ! -f "$BACKEND_ENV" ]; then
  log "Criando $BACKEND_ENV (segredos gerados automaticamente)"
  cat > "$BACKEND_ENV" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=$APP_PORT
CORS_ORIGIN=$CORS_ORIGIN
DATABASE_URL=${DATABASE_URL:-COLE_AQUI_A_URL_DO_POSTGRES}
JWT_ACCESS_SECRET=$(openssl rand -hex 32)
JWT_REFRESH_SECRET=$(openssl rand -hex 32)
MFA_ENCRYPTION_KEY=$(openssl rand -hex 32)
APP_TIMEZONE=America/Sao_Paulo
RECAPTCHA_SECRET_KEY=
CHECKIN_PHOTOS_BUCKET=
AWS_REGION=$AWS_REGION
EOF
else
  warn "$BACKEND_ENV já existe; mantido sem alterações."
fi
chown "root:$APP_USER" "$BACKEND_ENV"
chmod 640 "$BACKEND_ENV"

log "Instalando scripts de operação"
install -m 0755 "$SCRIPT_DIR"/{common.sh,deploy.sh,rollback.sh,tune.sh} "$LIB_DIR/"
ln -sfn "$LIB_DIR/deploy.sh"   /usr/local/bin/klinsync-deploy
ln -sfn "$LIB_DIR/rollback.sh" /usr/local/bin/klinsync-rollback
ln -sfn "$LIB_DIR/tune.sh"     /usr/local/bin/klinsync-tune

log "Configurando PM2 no boot"
as_app pm2 install pm2-logrotate >/dev/null
as_app pm2 set pm2-logrotate:max_size 20M >/dev/null
as_app pm2 set pm2-logrotate:retain 14 >/dev/null
env PATH="$PATH:/usr/bin:/usr/local/bin" pm2 startup systemd -u "$APP_USER" --hp "$APP_HOME" >/dev/null
systemctl enable "pm2-$APP_USER" >/dev/null 2>&1 || true

log "Configurando Nginx (proxy para 127.0.0.1:$APP_PORT)"
if [ "$PKG" = apt ]; then rm -f /etc/nginx/sites-enabled/default; fi
cat > /etc/nginx/klinsync-proxy.conf <<'EOF'
proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_read_timeout 60s;
EOF
cat > /etc/nginx/conf.d/klinsync-api.conf <<'EOF'
limit_req_zone $binary_remote_addr zone=klinsync_auth:10m rate=10r/m;
limit_req_zone $binary_remote_addr zone=klinsync_geral:10m rate=30r/s;

# O upstream (klinsync_app) fica em klinsync-upstream.conf, gerado por scripts/tune.sh.
server {
    listen 80;
    server_name __API_DOMAIN__;
    server_tokens off;
    client_max_body_size 5M;   # check-in envia foto em base64 (até ~1,5 MB)

    # Rotas sensíveis a força bruta
    location ~ ^/(auth/login|auth/mfa/verify|auth/refresh|convites/validar|convites/aceitar)$ {
        limit_req zone=klinsync_auth burst=10 nodelay;
        proxy_pass http://klinsync_app;
        include /etc/nginx/klinsync-proxy.conf;
    }

    location / {
        limit_req zone=klinsync_geral burst=60 nodelay;
        proxy_pass http://klinsync_app;
        include /etc/nginx/klinsync-proxy.conf;
    }
}
EOF
sed -i "s|__API_DOMAIN__|$API_DOMAIN|g" /etc/nginx/conf.d/klinsync-api.conf

log "Dimensionando PM2, Node, Nginx e kernel conforme a instância"
"$LIB_DIR/tune.sh"

cat > /etc/systemd/system/klinsync-tune.service <<EOF
[Unit]
Description=KlinSync - reajusta recursos quando o tamanho da EC2 muda
After=network-online.target nginx.service pm2-$APP_USER.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/klinsync-tune --boot

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable klinsync-tune.service >/dev/null 2>&1

nginx -t
systemctl enable --now nginx
systemctl reload nginx

if [ "$FIREWALL" = ufw ]; then
  log "Firewall (UFW) e fail2ban"
  ufw --force reset
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow OpenSSH
  ufw allow 'Nginx Full'
  ufw --force enable
  systemctl enable --now fail2ban
else
  warn "Amazon Linux: não há UFW. Libere apenas 80/443 (e 22 se usar SSH) no Security Group."
fi

if [ "$ENABLE_HTTPS" = "1" ] && [ -n "$CERT_EMAIL" ]; then
  log "Emitindo certificado HTTPS (Let's Encrypt) para $API_DOMAIN"
  if ! command -v certbot >/dev/null 2>&1; then
    if [ "$PKG" = apt ]; then
      pkg_install certbot python3-certbot-nginx
    else
      pkg_install python3 python3-pip augeas-libs
      python3 -m venv /opt/certbot
      /opt/certbot/bin/pip install --quiet certbot certbot-nginx
      ln -sfn /opt/certbot/bin/certbot /usr/local/bin/certbot
    fi
  fi
  if certbot --nginx --non-interactive --agree-tos -m "$CERT_EMAIL" --redirect -d "$API_DOMAIN"; then
    echo "HTTPS ativo em https://$API_DOMAIN"
  else
    warn "Certificado não emitido. Aponte o DNS de $API_DOMAIN para esta máquina e rode:"
    warn "  certbot --nginx -d $API_DOMAIN -m SEU_EMAIL --agree-tos --redirect"
  fi
else
  warn "HTTPS pulado (defina CERT_EMAIL). Sem TLS na própria EC2, termine o HTTPS num ALB/CloudFront."
fi

cat <<EOF

============================================================
 EC2 de backend pronta ($OS_NAME, $INSTANCE_TYPE).

 1) Edite $BACKEND_ENV (DATABASE_URL, RECAPTCHA_SECRET_KEY, CHECKIN_PHOTOS_BUCKET).
 2) Defina DB_MAX_CONNECTIONS em $DEPLOY_ENV com o valor informado pela EC2 de DB
    e rode: sudo klinsync-tune
 3) Publique o código no S3:   scripts/publish.sh   (na sua máquina ou no CI)
 4) Baixe e suba a versão:     sudo klinsync-deploy
 5) Acompanhe:                 sudo -u $APP_USER env PM2_HOME=$APP_HOME/.pm2 pm2 logs $PM2_APP_NAME
 Se redimensionar a EC2, o ajuste é refeito sozinho no boot (ou rode: sudo klinsync-tune).
============================================================
EOF
