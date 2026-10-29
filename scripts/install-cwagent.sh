#!/usr/bin/env bash
# =============================================================================
# Instala e configura o CloudWatch Agent para enviar MEMÓRIA e DISCO ao CloudWatch
# (a aba "Observabilidade" do painel master usa essas métricas para antecipar falhas).
#
#   sudo ./install-cwagent.sh          # em cada EC2 (backend, db, nat)
#
# Pré-requisito: a role da instância precisa da política CloudWatchAgentServerPolicy
# (já prevista em tf-ec2/iam.tf). Sem NAT/endpoint, a instância precisa alcançar o CloudWatch.
# Métricas enviadas (namespace CWAgent), a cada 60 s, agregadas só por InstanceId:
#   mem_used_percent   |   disk_used_percent (path "/")
# =============================================================================
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Rode como root (sudo)." >&2; exit 1; }

if ! command -v amazon-cloudwatch-agent-ctl >/dev/null 2>&1 && [ ! -x /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl ]; then
  ARCH="$(dpkg --print-architecture)"   # amd64 | arm64
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  REGION="$(curl -fsS -H "X-aws-ec2-metadata-token: $(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')" http://169.254.169.254/latest/meta-data/placement/region)"
  URL="https://amazoncloudwatch-agent-${REGION}.s3.${REGION}.amazonaws.com/ubuntu/${ARCH}/latest/amazon-cloudwatch-agent.deb"
  echo "Baixando o CloudWatch Agent (${ARCH}, ${REGION})..."
  curl -fsSL "$URL" -o "$TMP/agent.deb"
  dpkg -i "$TMP/agent.deb"
fi

CFG=/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
cat > "$CFG" <<'JSON'
{
  "agent": { "metrics_collection_interval": 60, "run_as_user": "cwagent" },
  "metrics": {
    "append_dimensions": { "InstanceId": "${aws:InstanceId}" },
    "aggregation_dimensions": [["InstanceId"], ["InstanceId", "path"]],
    "metrics_collected": {
      "mem":  { "measurement": ["mem_used_percent"] },
      "disk": { "measurement": ["disk_used_percent"], "resources": ["/"], "drop_device": true }
    }
  }
}
JSON

/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c "file:$CFG"
systemctl enable amazon-cloudwatch-agent >/dev/null 2>&1 || true
echo "Pronto. Em ~2 minutos memória e disco aparecem na aba Servidores do painel master."
