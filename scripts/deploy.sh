#!/usr/bin/env bash
# =============================================================================
# KlinSync backend — baixa uma release do S3 e atualiza o sistema (PM2), com rollback.
#
#   sudo klinsync-deploy                       # usa s3://<bucket>/releases/latest.txt
#   sudo klinsync-deploy releases/<arquivo>    # versão específica (chave dentro do bucket)
#   SKIP_HEALTHCHECK=1 sudo -E klinsync-deploy # não valida o endpoint de saúde
#
# Formato da release: .tar.gz com o código-fonte do backend na raiz
# (package.json, package-lock.json, src/ ...). O build roda aqui (npm ci + npm run build).
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/common.sh"

require_root
load_deploy_env

exec 9>/var/lock/klinsync-backend-deploy.lock
flock -n 9 || die "Já existe um deploy em andamento."

KEY="${1:-}"
if [ -z "$KEY" ]; then
  log "Lendo s3://$BACKEND_BUCKET/releases/latest.txt"
  KEY="$(aws s3 cp "s3://$BACKEND_BUCKET/releases/latest.txt" - | tr -d '[:space:]')"
fi
[ -n "$KEY" ] || die "Não foi possível determinar a release."

PREV="$(readlink -f "$APP_DIR/current" 2>/dev/null || true)"
if [ -f "$APP_DIR/CURRENT_KEY" ] && [ "$(cat "$APP_DIR/CURRENT_KEY")" = "$KEY" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "A release $KEY já está em produção. Use FORCE=1 para reaplicar."
  exit 0
fi

REL="$APP_DIR/releases/$(date +%Y%m%d%H%M%S)"
cleanup_failed() { rm -rf "$REL"; }

log "Baixando s3://$BACKEND_BUCKET/$KEY"
mkdir -p "$REL"
aws s3 cp "s3://$BACKEND_BUCKET/$KEY" /tmp/klinsync-backend-release.tar.gz
tar -xzf /tmp/klinsync-backend-release.tar.gz -C "$REL"
rm -f /tmp/klinsync-backend-release.tar.gz
chown -R "$APP_USER:$APP_USER" "$REL"

log "Instalando dependências e compilando"
export APP_CWD="$REL"
if [ -f package-lock.json ]; then as_app npm ci --no-audit --no-fund; else as_app npm install --no-audit --no-fund; fi
as_app env NODE_OPTIONS="--max-old-space-size=${BUILD_HEAP_MB:-1024}" npm run build --if-present
as_app npm prune --omit=dev --no-audit --no-fund
unset APP_CWD

[ -f "$REL/$APP_ENTRY" ] || { cleanup_failed; die "Arquivo de entrada '$APP_ENTRY' não existe na release. Ajuste APP_ENTRY em $DEPLOY_ENV."; }

log "Ativando a nova release"
ln -sfn "$REL" "$APP_DIR/current"
as_app pm2 startOrReload "$APP_DIR/ecosystem.config.cjs" --update-env
as_app pm2 save >/dev/null

if [ "${SKIP_HEALTHCHECK:-0}" = "1" ]; then
  warn "Health check pulado."
else
  log "Verificando http://127.0.0.1:$APP_PORT$HEALTH_PATH"
  if ! health_check "http://127.0.0.1:$APP_PORT$HEALTH_PATH" 40; then
    warn "A aplicação não respondeu. Fazendo rollback."
    if [ -n "$PREV" ] && [ -d "$PREV" ]; then
      ln -sfn "$PREV" "$APP_DIR/current"
      as_app pm2 startOrReload "$APP_DIR/ecosystem.config.cjs" --update-env
      as_app pm2 save >/dev/null
    else
      as_app pm2 stop "$PM2_APP_NAME" || true
    fi
    as_app pm2 logs "$PM2_APP_NAME" --lines 30 --nostream || true
    die "Deploy de $KEY falhou e foi revertido."
  fi
fi

echo "$KEY" > "$APP_DIR/CURRENT_KEY"

log "Limpando releases antigas (mantém ${KEEP_RELEASES:-5})"
ls -1dt "$APP_DIR"/releases/*/ 2>/dev/null | tail -n +"$(( ${KEEP_RELEASES:-5} + 1 ))" | while read -r old; do
  [ "$(readlink -f "$old")" = "$(readlink -f "$APP_DIR/current")" ] || rm -rf "$old"
done

log "Deploy concluído: $KEY"
as_app pm2 status "$PM2_APP_NAME"
