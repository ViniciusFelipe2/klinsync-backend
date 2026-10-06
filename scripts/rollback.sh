#!/usr/bin/env bash
# =============================================================================
# KlinSync backend — volta para a release anterior (ou para uma específica).
#
#   sudo klinsync-rollback                  # release imediatamente anterior à atual
#   sudo klinsync-rollback 20260101120000   # nome da pasta em /opt/klinsync-backend/releases
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/common.sh"

require_root
load_deploy_env

exec 9>/var/lock/klinsync-backend-deploy.lock
flock -n 9 || die "Já existe um deploy em andamento."

CURRENT="$(readlink -f "$APP_DIR/current" 2>/dev/null || true)"

if [ -n "${1:-}" ]; then
  TARGET="$APP_DIR/releases/$1"
else
  TARGET=""
  while read -r r; do
    r="${r%/}"
    if [ "$(readlink -f "$r")" != "$CURRENT" ]; then TARGET="$r"; break; fi
  done < <(ls -1dt "$APP_DIR"/releases/*/ 2>/dev/null)
fi

[ -n "$TARGET" ] && [ -d "$TARGET" ] || die "Nenhuma release anterior encontrada."
log "Rollback: $CURRENT -> $TARGET"

ln -sfn "$TARGET" "$APP_DIR/current"
as_app pm2 startOrReload "$APP_DIR/ecosystem.config.cjs" --update-env
as_app pm2 save >/dev/null

if health_check "http://127.0.0.1:$APP_PORT$HEALTH_PATH" 40; then
  rm -f "$APP_DIR/CURRENT_KEY"   # a chave do S3 deixou de refletir a release ativa
  log "Rollback concluído."
else
  die "Rollback aplicado, mas a aplicação não respondeu em $HEALTH_PATH. Verifique os logs do PM2."
fi
