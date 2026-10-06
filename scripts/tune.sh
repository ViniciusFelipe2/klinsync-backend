#!/usr/bin/env bash
# =============================================================================
# KlinSync backend — ajusta PM2, Node, Nginx e kernel ao tamanho (vCPU/RAM) desta EC2.
#
#   sudo klinsync-tune           # recalcula e aplica agora
#   sudo klinsync-tune --boot    # chamado no boot: só reaplica se o tamanho da instância mudou
#
# Rode de novo (ou apenas reinicie) depois de redimensionar a instância (stop/start com outro tipo).
# Valores calculados:
#   instâncias PM2 = min(vCPU, memória disponível / 384 MB, 8)   (cluster se > 1)
#   heap do Node   = 70% da memória de cada instância; PM2 reinicia o processo em 90%
#   pool do banco  = conexões do Postgres * 80% / instâncias PM2  (DB_MAX_CONNECTIONS em deploy.env)
#   Nginx          = worker_connections e keepalive para o upstream conforme RAM e instâncias
# Overrides (em /etc/klinsync/deploy.env): PM2_INSTANCES_OVERRIDE=<n>
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/common.sh"

require_root
load_deploy_env
BOOT=0; [ "${1:-}" = "--boot" ] && BOOT=1

detect_os
detect_resources
FP="$(sizing_fingerprint)"
if [ "$BOOT" = 1 ] && [ -f "$FINGERPRINT_FILE" ] && [ "$(cat "$FINGERPRINT_FILE")" = "$FP" ]; then
  echo "klinsync-tune: tamanho da instância inalterado ($FP). Nada a fazer."
  exit 0
fi

log "Dimensionando para a instância $INSTANCE_TYPE"
validate_size backend
ensure_swap

# ------------------------------- Cálculo de recursos ------------------------------
OS_RES="$(os_reserve_mb)"
NGINX_MB="$(clamp $((48 + 16 * CPU_COUNT)) 64 256)"
AVAIL_MB=$(( MEM_MB - OS_RES - NGINX_MB ))
[ "$AVAIL_MB" -ge 256 ] || AVAIL_MB=256

BY_MEM=$(( AVAIL_MB / 384 ))
INSTANCES="$(clamp "$(( CPU_COUNT < BY_MEM ? CPU_COUNT : BY_MEM ))" 1 8)"
if [ -n "${PM2_INSTANCES_OVERRIDE:-}" ]; then INSTANCES="$PM2_INSTANCES_OVERRIDE"; fi

PER_MB=$(( AVAIL_MB / INSTANCES ))
HEAP_MB="$(clamp $((PER_MB * 70 / 100)) 128 4096)"
RESTART_MB="$(clamp $((PER_MB * 90 / 100)) $((HEAP_MB + 64)) 8192)"
THREADPOOL="$(clamp $((CPU_COUNT * 2)) 4 16)"
EXEC_MODE=fork; [ "$INSTANCES" -gt 1 ] && EXEC_MODE=cluster

DB_MAX_CONNECTIONS="${DB_MAX_CONNECTIONS:-100}"
DB_POOL_MAX="$(clamp $(( (DB_MAX_CONNECTIONS - 15) * 80 / 100 / INSTANCES )) 3 25)"
BUILD_HEAP_MB="$(clamp $((MEM_MB * 65 / 100)) 384 4096)"

if   [ "$MEM_MB" -lt 2048 ]; then WORKER_CONN=1024
elif [ "$MEM_MB" -lt 8192 ]; then WORKER_CONN=2048
else WORKER_CONN=4096; fi
RLIMIT_NOFILE=$(( WORKER_CONN * 2 ))
KEEPALIVE="$(clamp $((INSTANCES * 16)) 16 128)"
SOMAXCONN="$(clamp $((MEM_MB / 2)) 1024 4096)"

# --------------------------------- Aplicação do PM2 -------------------------------
log "PM2: $INSTANCES instância(s) em modo $EXEC_MODE | heap ${HEAP_MB} MB | reinício em ${RESTART_MB} MB"
cat > "$APP_DIR/ecosystem.config.cjs" <<EOF
// Gerado por scripts/tune.sh para $INSTANCE_TYPE (${CPU_COUNT} vCPU, ${MEM_MB} MB). Não edite: rode klinsync-tune.
// As variáveis do app vêm de $BACKEND_ENV (node --env-file).
module.exports = {
  apps: [
    {
      name: "$PM2_APP_NAME",
      cwd: "$APP_DIR/current",
      script: "$APP_ENTRY",
      node_args: ["--env-file=$BACKEND_ENV", "--max-old-space-size=$HEAP_MB"],
      exec_mode: "$EXEC_MODE",
      instances: $INSTANCES,
      autorestart: true,
      max_memory_restart: "${RESTART_MB}M",
      kill_timeout: 10000,
      listen_timeout: 15000,
      time: true,
      env: { UV_THREADPOOL_SIZE: "$THREADPOOL" },
    },
  ],
};
EOF
chown "$APP_USER:$APP_USER" "$APP_DIR/ecosystem.config.cjs"

# Valores de dimensionamento para o app (lidos de backend.env) e para os scripts (deploy.env)
set_kv "$BACKEND_ENV" DB_POOL_MAX "$DB_POOL_MAX"
set_kv "$BACKEND_ENV" WEB_CONCURRENCY "$INSTANCES"
chown "root:$APP_USER" "$BACKEND_ENV"; chmod 640 "$BACKEND_ENV"
set_kv "$DEPLOY_ENV" INSTANCE_TYPE "$INSTANCE_TYPE"
set_kv "$DEPLOY_ENV" CPU_COUNT "$CPU_COUNT"
set_kv "$DEPLOY_ENV" MEM_MB "$MEM_MB"
set_kv "$DEPLOY_ENV" PM2_INSTANCES "$INSTANCES"
set_kv "$DEPLOY_ENV" BUILD_HEAP_MB "$BUILD_HEAP_MB"
set_kv "$DEPLOY_ENV" DB_MAX_CONNECTIONS "$DB_MAX_CONNECTIONS"

# ------------------------------------- Nginx -------------------------------------
log "Nginx: worker_connections $WORKER_CONN | keepalive upstream $KEEPALIVE"
NGX=/etc/nginx/nginx.conf
if [ -f "$NGX" ]; then
  [ -f "$NGX.klinsync.bak" ] || cp "$NGX" "$NGX.klinsync.bak"
  sed -i -E "s/^[[:space:]]*worker_processes[[:space:]].*;/worker_processes auto;/" "$NGX"
  sed -i -E "s/^([[:space:]]*)worker_connections[[:space:]]+[0-9]+;/\1worker_connections $WORKER_CONN;/" "$NGX"
  if grep -q '^worker_rlimit_nofile' "$NGX"; then
    sed -i -E "s/^worker_rlimit_nofile.*/worker_rlimit_nofile $RLIMIT_NOFILE;/" "$NGX"
  else
    sed -i -E "0,/^worker_processes.*/s//&\nworker_rlimit_nofile $RLIMIT_NOFILE;/" "$NGX"
  fi
fi
cat > /etc/nginx/conf.d/klinsync-upstream.conf <<EOF
# Gerado por scripts/tune.sh
upstream klinsync_app {
    server 127.0.0.1:$APP_PORT;
    keepalive $KEEPALIVE;
}
EOF

# ------------------------------------ Kernel -------------------------------------
cat > /etc/sysctl.d/99-klinsync.conf <<EOF
# Gerado por scripts/tune.sh
vm.swappiness = 10
net.core.somaxconn = $SOMAXCONN
net.ipv4.tcp_max_syn_backlog = $SOMAXCONN
EOF
sysctl --system >/dev/null

# --------------------------------- Recarga dos serviços ---------------------------
if systemctl is-active --quiet nginx; then
  nginx -t || die "Configuração do Nginx inválida após o ajuste. Original em $NGX.klinsync.bak."
  systemctl reload nginx
fi
if [ -L "$APP_DIR/current" ]; then
  log "Recarregando o PM2 com a nova configuração"
  as_app pm2 startOrReload "$APP_DIR/ecosystem.config.cjs" --update-env
  as_app pm2 save >/dev/null
else
  echo "Sem release ativa ainda: o PM2 será configurado no primeiro klinsync-deploy."
fi

echo "$FP" > "$FINGERPRINT_FILE"

cat <<EOF

------------------------------------------------------------
 Dimensionamento aplicado ($INSTANCE_TYPE: ${CPU_COUNT} vCPU, ${MEM_MB} MB)
   PM2:    $INSTANCES x $EXEC_MODE | heap ${HEAP_MB} MB | restart em ${RESTART_MB} MB
   Pool:   DB_POOL_MAX=$DB_POOL_MAX por instância (DB_MAX_CONNECTIONS=$DB_MAX_CONNECTIONS)
   Nginx:  worker_connections $WORKER_CONN | keepalive $KEEPALIVE
   Build:  heap de ${BUILD_HEAP_MB} MB no npm run build
 O app deve ler DB_POOL_MAX para dimensionar o pool de conexões.
------------------------------------------------------------
EOF
