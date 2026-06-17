#!/usr/bin/env sh
# Lee /vicionpower/$APP_ENV/$APP_SVC/* de SSM Parameter Store (descifrado),
# los exporta como variables de entorno y arranca el proceso.
# El AWS CLI auto-pagina, y --output text entrega valores crudos (sin escapes JSON).
set -eu

: "${APP_ENV:?APP_ENV requerido}"
: "${APP_SVC:?APP_SVC requerido}"
REGION="${AWS_REGION:-us-east-1}"
PREFIX="/vicionpower/$APP_ENV/$APP_SVC/"

ENVF=$(mktemp)
trap 'rm -f "$ENVF"' EXIT

TAB=$(printf '\t')
# Una sola llamada: el CLI pagina internamente; --output text da valores crudos.
aws ssm get-parameters-by-path \
  --region "$REGION" \
  --path "$PREFIX" \
  --with-decryption \
  --query 'Parameters[].[Name,Value]' \
  --output text \
| while IFS="$TAB" read -r name value; do
    [ -n "$name" ] || continue
    key="${name#"$PREFIX"}"
    # Escapa single quotes para sourcing seguro
    escaped=$(printf '%s\n' "$value" | sed "s/'/'\\\\''/g")
    printf "export %s='%s'\n" "$key" "$escaped" >> "$ENVF"
  done

# Sourcea el env-file en el proceso actual
# shellcheck disable=SC1090
. "$ENVF"

rm -f "$ENVF"
trap - EXIT

exec "$@"
