#!/usr/bin/env sh
# Lee /vicionpower/$APP_ENV/$APP_SVC/* de SSM, exporta como env y arranca el proceso.
# Requiere: aws CLI en la imagen, permisos ssm:GetParametersByPath + kms:Decrypt.
# Variables requeridas: APP_ENV (ej. prod) y APP_SVC (ej. api, vp-engine, vp-payments).
set -eu

: "${APP_ENV:?APP_ENV requerido}"
: "${APP_SVC:?APP_SVC requerido}"

REGION="${AWS_REGION:-us-east-1}"
PREFIX="/vicionpower/$APP_ENV/$APP_SVC/"

# Archivo temporal para el env-file (evita el subshell del pipe).
ENVF=$(mktemp)
trap 'rm -f "$ENVF"' EXIT

# Descarga todos los parámetros paginados con UNA sola llamada por página.
# --query 'Parameters[].[Name,Value]' --output text emite NAME<TAB>VALUE por línea.
# La misma respuesta incluye NextToken cuando hay más páginas (leemos JSON para ello).
NEXT_TOKEN=""
while : ; do
  if [ -n "$NEXT_TOKEN" ]; then
    RESPONSE=$(aws ssm get-parameters-by-path \
      --region "$REGION" \
      --path "$PREFIX" \
      --with-decryption \
      --output json \
      --starting-token "$NEXT_TOKEN")
  else
    RESPONSE=$(aws ssm get-parameters-by-path \
      --region "$REGION" \
      --path "$PREFIX" \
      --with-decryption \
      --output json)
  fi

  # Extraer NextToken (vacío si no existe en la respuesta).
  NEXT_TOKEN=$(printf '%s\n' "$RESPONSE" | \
    awk 'BEGIN{t=""} /"NextToken"/ {
      match($0, /"NextToken"[[:space:]]*:[[:space:]]*"([^"]+)"/, a)
      if (RLENGTH>0) { t=a[1] }
    } END{print t}')

  # Extraer Name y Value de cada parámetro y escribir KEY=VALUE al env-file.
  # Formato JSON: busca pares "Name":"..." y "Value":"..." consecutivos.
  printf '%s\n' "$RESPONSE" | \
    awk -v prefix="$PREFIX" '
      /"Name"[[:space:]]*:/ {
        match($0, /"Name"[[:space:]]*:[[:space:]]*"([^"]*)"/, a)
        if (RLENGTH > 0) name = a[1]
      }
      /"Value"[[:space:]]*:/ {
        match($0, /"Value"[[:space:]]*:[[:space:]]*"(.*)"/, a)
        if (RLENGTH > 0) {
          val = a[1]
          # Unescape JSON basic escapes
          gsub(/\\n/, "\n", val)
          gsub(/\\t/, "\t", val)
          gsub(/\\"/, "\"", val)
          gsub(/\\\\/, "\\", val)
          key = name
          sub(prefix, "", key)
          print key "=" val
        }
      }
    ' >> "$ENVF"

  [ -z "$NEXT_TOKEN" ] && break
done

# Sourcea el env-file en el proceso actual (set -a exporta automáticamente).
set -a
# shellcheck disable=SC1090
. "$ENVF"
set +a

rm -f "$ENVF"
trap - EXIT

exec "$@"
