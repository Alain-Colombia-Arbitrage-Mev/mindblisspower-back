#!/usr/bin/env sh
# Lee /vicionpower/$APP_ENV/$APP_SVC/* de SSM, exporta como env y arranca el proceso.
# Requiere: aws CLI en la imagen, permisos ssm:GetParametersByPath + kms:Decrypt.
# Variables requeridas: APP_ENV (ej. prod) y APP_SVC (ej. api, vp-engine, vp-payments).
set -e
: "${APP_ENV:?APP_ENV requerido}"; : "${APP_SVC:?APP_SVC requerido}"
REGION="${AWS_REGION:-us-east-1}"
PREFIX="/vicionpower/$APP_ENV/$APP_SVC/"

# Descarga todos los parámetros del prefijo (paginado) y los escribe a un env-file temporal.
ENVF=$(mktemp)
NEXT_TOKEN=""
while : ; do
  if [ -n "$NEXT_TOKEN" ]; then
    OUT=$(aws ssm get-parameters-by-path \
      --region "$REGION" --path "$PREFIX" --with-decryption \
      --query 'Parameters[].[Name,Value]' --output text \
      --starting-token "$NEXT_TOKEN")
    RAW_NEXT=$(aws ssm get-parameters-by-path \
      --region "$REGION" --path "$PREFIX" --with-decryption \
      --query 'NextToken' --output text --starting-token "$NEXT_TOKEN" 2>/dev/null || echo None)
  else
    OUT=$(aws ssm get-parameters-by-path \
      --region "$REGION" --path "$PREFIX" --with-decryption \
      --query 'Parameters[].[Name,Value]' --output text)
    RAW_NEXT=$(aws ssm get-parameters-by-path \
      --region "$REGION" --path "$PREFIX" --with-decryption \
      --query 'NextToken' --output text 2>/dev/null || echo None)
  fi
  printf '%s\n' "$OUT" | while IFS=$(printf '\t') read -r name value; do
    [ -n "$name" ] || continue
    key="${name#$PREFIX}"
    printf '%s=%s\n' "$key" "$value" >> "$ENVF"
  done
  [ "$RAW_NEXT" = "None" ] && break
  NEXT_TOKEN="$RAW_NEXT"
done

# Sourcea el env-file en el proceso actual (set -a exporta automáticamente).
set -a; . "$ENVF"; set +a
rm -f "$ENVF"

exec "$@"
