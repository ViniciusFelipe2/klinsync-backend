#!/usr/bin/env bash
# =============================================================================
# KlinSync backend — empacota o repositório e publica no S3 (rodar na sua máquina ou no CI).
#
#   scripts/publish.sh                    # sobe a release e atualiza releases/latest.txt
#   scripts/publish.sh --deploy           # idem + dispara o deploy na EC2 via SSM
#
# Variáveis: BACKEND_BUCKET (padrão klinsync-backend), AWS_REGION (padrão us-east-2),
#            EC2_INSTANCE_ID (obrigatória com --deploy).
# Requer: git, aws CLI autenticado, repositório com ao menos um commit.
# =============================================================================
set -euo pipefail

BACKEND_BUCKET="${BACKEND_BUCKET:-klinsync-backend}"
export AWS_REGION="${AWS_REGION:-us-east-2}" AWS_DEFAULT_REGION="${AWS_REGION:-us-east-2}"
cd "$(git rev-parse --show-toplevel)"
RELEASE_PUBLISHED=1

if [ -n "$(git status --porcelain)" ]; then
  echo "[aviso] Há alterações não commitadas; a release contém apenas o que está no HEAD." >&2
fi

if git cat-file -e HEAD:package.json 2>/dev/null; then
  VERSION="$(date +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD)"
  KEY="releases/klinsync-backend-$VERSION.tar.gz"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT

  echo "==> Empacotando $VERSION"
  git archive --format=tar.gz -o "$TMP/release.tar.gz" HEAD

  echo "==> Enviando s3://$BACKEND_BUCKET/$KEY"
  aws s3 cp "$TMP/release.tar.gz" "s3://$BACKEND_BUCKET/$KEY"
  printf '%s\n' "$KEY" | aws s3 cp - "s3://$BACKEND_BUCKET/releases/latest.txt" --content-type text/plain
else
  echo "[aviso] O repositório ainda não tem package.json no HEAD. Publicando apenas os scripts de operação." >&2
  RELEASE_PUBLISHED=0
fi

echo "==> Sincronizando scripts de operação"
aws s3 sync scripts "s3://$BACKEND_BUCKET/scripts" --delete

if [ "${1:-}" = "--deploy" ] && [ "${RELEASE_PUBLISHED:-1}" = "1" ]; then
  : "${EC2_INSTANCE_ID:?Defina EC2_INSTANCE_ID para usar --deploy}"
  echo "==> Disparando deploy em $EC2_INSTANCE_ID (SSM)"
  CMD_ID="$(aws ssm send-command --instance-ids "$EC2_INSTANCE_ID" \
    --document-name AWS-RunShellScript --comment "klinsync-backend $VERSION" \
    --parameters 'commands=["/usr/local/bin/klinsync-deploy"]' \
    --query Command.CommandId --output text)"
  aws ssm wait command-executed --command-id "$CMD_ID" --instance-id "$EC2_INSTANCE_ID" || true
  aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$EC2_INSTANCE_ID" \
    --query '[Status, StandardOutputContent, StandardErrorContent]' --output text
fi

if [ "${RELEASE_PUBLISHED:-1}" = "1" ]; then echo "==> Publicado: $KEY"; fi
