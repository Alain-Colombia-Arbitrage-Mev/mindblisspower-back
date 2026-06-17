#!/usr/bin/env bash
# Corre EN el host vía SSM Run Command.
# Args por env: ENVN, IMAGE_TAG, COMPOSE (ruta relativa al repo root), SERVICES (lista separada por espacios), REGION
#
# NOTA (Task 5 / validar en Task 11 — live deploy):
#   (a) Los params SSM de vp-engine son la unión de server1 + server2; se inyectan vars extra en
#       ambos hosts — las vars que no usa el compose de ese server se ignoran silenciosamente.
#   (b) GRPC_TLS_CERT / GRPC_TLS_KEY y similares pueden ser RUTAS a archivos de certificado,
#       no valores inline. Si el host no tiene esos archivos montados en la ruta esperada, el
#       contenedor arrancará pero fallará al intentar leer el cert. Pendiente validar rutas vs.
#       volúmenes en el primer live deploy; NO se gestiona aquí todavía.
set -euo pipefail

REGION="${REGION:-us-east-1}"
REGISTRY="522814703714.dkr.ecr.${REGION}.amazonaws.com"

# ECR login
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

# Directorio para env-files (solo accesible por root / docker daemon)
install -d -m 700 /run/vicionpower

for svc in $SERVICES; do
  pfx="/vicionpower/$ENVN/$svc/"
  : > "/run/vicionpower/$svc.env"
  chmod 600 "/run/vicionpower/$svc.env"
  # aws ssm get-parameters-by-path auto-pagina; --output text devuelve valores raw (sin quotes JSON)
  aws ssm get-parameters-by-path \
    --region "$REGION" \
    --path "$pfx" \
    --with-decryption \
    --query 'Parameters[].[Name,Value]' \
    --output text \
  | while IFS="$(printf '\t')" read -r name value; do
      [ -n "$name" ] && printf '%s=%s\n' "${name#"$pfx"}" "$value" >> "/run/vicionpower/$svc.env"
    done
done

export REGISTRY IMAGE_TAG="$IMAGE_TAG"

docker compose -f "$COMPOSE" pull
docker compose -f "$COMPOSE" up -d --remove-orphans

# Health gate: dar tiempo a que los contenedores arranquen
sleep 5
docker compose -f "$COMPOSE" ps

FAIL=0
for svc in $SERVICES; do
  cid=$(docker compose -f "$COMPOSE" ps -q "$svc" 2>/dev/null || true)
  if [ -z "$cid" ]; then
    echo "UNHEALTHY: $svc (contenedor no encontrado)"
    FAIL=1
    continue
  fi
  state=$(docker inspect -f '{{.State.Health.Status}}{{.State.Status}}' "$cid" 2>/dev/null || echo "")
  case "$state" in
    *healthy*|*running*) ;;
    *) echo "UNHEALTHY: $svc ($state)"; FAIL=1 ;;
  esac
done

[ "$FAIL" = 0 ] && echo "DEPLOY OK tag=$IMAGE_TAG" || { echo "DEPLOY FAILED"; exit 1; }
