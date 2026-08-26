#!/usr/bin/env bash
# Corre EN el host vía SSM Run Command.
# Args por env: ENVN, IMAGE_TAG, COMPOSE_B64, COMPOSE_NAME, SERVICES (lista separada por espacios), REGION
# SERVICES acepta entradas "servicio" o "servicio@path-ssm". Con override, Docker
# opera el servicio real y los env/secrets se leen desde /vicionpower/<env>/<path-ssm>/.
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

# Auto-provisión de dependencias: en hosts recién levantados (p.ej. staging) el
# deploy fallaba con "aws: command not found" o sin el plugin `docker compose`.
# Se instalan aquí si faltan (idempotente; en hosts ya provisionados es no-op),
# para que el deploy no dependa de un provisioning manual previo del box.
if ! command -v aws >/dev/null 2>&1; then
  echo "==> aws-cli ausente: instalando AWS CLI v2"
  tmpd=$(mktemp -d)
  arch=$(uname -m); case "$arch" in aarch64|arm64) awsarch=aarch64 ;; *) awsarch=x86_64 ;; esac
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${awsarch}.zip" -o "$tmpd/awscliv2.zip"
  (cd "$tmpd" && unzip -q awscliv2.zip && sudo ./aws/install --update)
  rm -rf "$tmpd"
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "==> plugin 'docker compose' ausente: instalando"
  sudo mkdir -p /usr/lib/docker/cli-plugins
  dcarch=$(uname -m); case "$dcarch" in aarch64|arm64) dcbin=aarch64 ;; *) dcbin=x86_64 ;; esac
  sudo curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${dcbin}" \
    -o /usr/lib/docker/cli-plugins/docker-compose
  sudo chmod +x /usr/lib/docker/cli-plugins/docker-compose
fi

# ECR login
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

# FIX 2: materializar el compose file desde COMPOSE_B64 si está presente
if [ -n "${COMPOSE_B64:-}" ]; then
  mkdir -p /opt/vicion/compose
  printf '%s' "$COMPOSE_B64" | base64 -d > "/opt/vicion/compose/$COMPOSE_NAME"
  COMPOSE="/opt/vicion/compose/$COMPOSE_NAME"
fi

# Directorio para env-files (solo accesible por root / docker daemon)
install -d -m 700 /run/vicionpower

COMPOSE_SERVICES=""
for spec in $SERVICES; do
  svc="${spec%%@*}"
  cfg_svc="$svc"
  if [ "$spec" != "$svc" ]; then
    cfg_svc="${spec#*@}"
  fi
  COMPOSE_SERVICES="$COMPOSE_SERVICES $svc"
  pfx="/vicionpower/$ENVN/$cfg_svc/"
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
  # Secretos sensibles desde AWS Secrets Manager (JSON por servicio). Se agregan
  # DESPUÉS de los params SSM, así que sobre-escriben cualquier copia stale en SSM
  # (última aparición gana al leer el env-file). Additivo: si el secreto no existe,
  # se omite en silencio → migración sin downtime (crear secreto → redeploy → borrar
  # el SecureString de SSM). Requiere jq en el host.
  sm=$(aws secretsmanager get-secret-value --region "$REGION" \
        --secret-id "vicionpower/$ENVN/$cfg_svc" --query SecretString --output text 2>/dev/null || true)
  if [ -n "${sm:-}" ] && [ "$sm" != "None" ]; then
    printf '%s' "$sm" | jq -r 'to_entries[] | "\(.key)=\(.value)"' >> "/run/vicionpower/$svc.env"
    echo "  (merged Secrets Manager secret for $svc from $cfg_svc)"
  fi
done

export REGISTRY IMAGE_TAG="$IMAGE_TAG"

docker compose -f "$COMPOSE" pull $COMPOSE_SERVICES
docker compose -f "$COMPOSE" up -d --remove-orphans $COMPOSE_SERVICES

# Health gate: dar tiempo a que los contenedores arranquen
sleep 5
docker compose -f "$COMPOSE" ps

FAIL=0
for svc in $COMPOSE_SERVICES; do
  cid=$(docker compose -f "$COMPOSE" ps -q "$svc" 2>/dev/null || true)
  if [ -z "$cid" ]; then
    echo "UNHEALTHY: $svc (contenedor no encontrado)"
    FAIL=1
    continue
  fi
  # FIX 1: separar health y running con delimitador '|' para evitar que "unhealthy" coincida
  # con el glob *healthy* de la versión anterior (substring falso-positivo).
  # FIX 3: contenedores SIN healthcheck tienen .State.Health nil y el template
  # fallaba entero (→ "|" → running vacío → falso NOT-RUNNING). Guard con {{if}}.
  state=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.State.Status}}' "$cid" 2>/dev/null || echo "|")
  health="${state%%|*}"
  running="${state#*|}"
  if [ "$health" = "unhealthy" ]; then echo "UNHEALTHY: $svc (health=$health)"; FAIL=1; continue; fi
  if [ "$running" != "running" ]; then echo "NOT-RUNNING: $svc (status=$running)"; FAIL=1; continue; fi
  echo "OK: $svc (health=${health:-none} status=$running)"
done

[ "$FAIL" = 0 ] && echo "DEPLOY OK tag=$IMAGE_TAG" || { echo "DEPLOY FAILED"; exit 1; }
