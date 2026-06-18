#!/usr/bin/env bash
# Corre en el host. Sube cada KEY=VALUE de un .env a SSM como SecureString.
# Uso (dentro del host): dump-env-to-ssm.sh <env> <servicio> <ruta-.env>
# Ejemplo: dump-env-to-ssm.sh prod api /etc/vp-api/app.env
set -euo pipefail
ENVN="$1"; SVC="$2"; FILE="$3"; REGION=us-east-1
while IFS= read -r line; do
  case "$line" in ''|\#*) continue;; esac
  key="${line%%=*}"; val="${line#*=}"
  aws ssm put-parameter --region "$REGION" \
    --name "/vicionpower/$ENVN/$SVC/$key" \
    --value "$val" --type SecureString \
    --key-id alias/vicionpower-secrets --overwrite >/dev/null
  echo "set /vicionpower/$ENVN/$SVC/$key"
done < "$FILE"
