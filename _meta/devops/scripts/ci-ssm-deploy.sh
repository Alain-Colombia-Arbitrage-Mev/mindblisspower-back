#!/usr/bin/env bash
# Uso: ci-ssm-deploy.sh <env> <tag> "<inst|compose|svcs;inst|compose|svcs>"
# Campos por '|', targets por ';'. svcs puede contener espacios (e.g. "api vp-engine").
set -euo pipefail

ENVN="$1"
TAG="$2"
TARGETS="$3"
REGION=us-east-1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REMOTE=$(base64 -w0 "$SCRIPT_DIR/remote-deploy.sh")

[ -n "$TARGETS" ] || { echo "sin targets"; exit 1; }

IFS=';' read -ra T <<< "$TARGETS"
for t in "${T[@]}"; do
  inst="${t%%|*}"
  rest="${t#*|}"
  compose="${rest%%|*}"
  svcs="${rest#*|}"

  # El script remoto recibe sus args por env; lo invocamos con base64 para no pelear con comillas.
  CMD="ENVN='$ENVN' IMAGE_TAG='$TAG' COMPOSE='$compose' SERVICES='$svcs' bash -c \"echo $REMOTE | base64 -d | bash\""
  PARAMS=$(printf '{"commands":["%s"]}' "$CMD")
  TMP=$(mktemp)
  printf '%s' "$PARAMS" > "$TMP"

  CID=$(aws ssm send-command \
    --region "$REGION" \
    --document-name AWS-RunShellScript \
    --instance-ids "$inst" \
    --parameters "file://$TMP" \
    --query 'Command.CommandId' \
    --output text)
  rm -f "$TMP"

  echo "### $inst command=$CID — esperando resultado..."
  ST="Pending"
  for i in $(seq 1 60); do
    ST=$(aws ssm get-command-invocation \
      --region "$REGION" \
      --command-id "$CID" \
      --instance-id "$inst" \
      --query Status \
      --output text 2>/dev/null || echo Pending)
    case "$ST" in
      Success|Failed|Cancelled|TimedOut) break ;;
    esac
    sleep 5
  done

  echo "### $inst status=$ST"
  aws ssm get-command-invocation \
    --region "$REGION" \
    --command-id "$CID" \
    --instance-id "$inst" \
    --query StandardOutputContent \
    --output text

  [ "$ST" = Success ] || {
    aws ssm get-command-invocation \
      --region "$REGION" \
      --command-id "$CID" \
      --instance-id "$inst" \
      --query StandardErrorContent \
      --output text >&2
    exit 1
  }
done
