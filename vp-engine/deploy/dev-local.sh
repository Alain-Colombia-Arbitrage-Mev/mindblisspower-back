#!/usr/bin/env bash
# ============================================================================
# dev-local.sh — Levanta el ENTORNO LOCAL completo de pagos:
#   1) abre el túnel SSH a RDS (vía worker EC2) en 127.0.0.1:15432
#   2) corre vp-payments local en 127.0.0.1:9095 (modo TEST: sk_test)
#
# Lee secretos de backend/.env.local (sk_test, whsec test, túnel DB) y el token
# de frontend/.env.local (para que el BFF del Next local lo alcance).
#
# Uso (desde la raíz del repo):  bash backend/vp-engine/deploy/dev-local.sh
# Luego, en otra terminal:  cd frontend/vicion-growth-hub && npm run dev
# Y para webhooks de prueba:  stripe listen --forward-to localhost:9095/api/webhooks/stripe
# ============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BE="$ROOT/backend/.env.local"; FE="$ROOT/frontend/vicion-growth-hub/.env.local"
g(){ grep -E "^$1=" "$BE" | head -1 | sed -E "s/^$1=//; s/^[\"']//; s/[\"']$//"; }
gf(){ grep -E "^$1=" "$FE" | head -1 | sed -E "s/^$1=//; s/^[\"']//; s/[\"']$//"; }

PEM="$(g pem_key)"; WORKER="$(g server_ip_worker)"; SSHUSER="$(g ssh_user)"
LPORT="$(g TUNNEL_LOCAL_PORT)"; [ -z "$LPORT" ] && LPORT=15432
RDS="$(g MIGRATOR_DATABASE_URL | sed -E 's#.*@([^/:]+).*#\1#')"
SK="$(g CLAVE_SECRETA)"; WH="$(g SECRET_FIRMA_TEST)"; PROD="$(g ID_PRODUCTO_TEST)"
# DB writer vía túnel (fuerza sslmode=require para que no falle por hostname).
DBU="$(g VP_ENGINE_TUNNEL_URL | sed -E 's#\?.*##')?sslmode=require"
TOKEN="$(gf PAYMENTS_SERVICE_TOKEN)"

case "$SK" in sk_test_*) ;; *) echo "ERROR: CLAVE_SECRETA no es sk_test_ (revisa backend/.env.local)"; exit 1;; esac
[ -z "$TOKEN" ] && { echo "ERROR: falta PAYMENTS_SERVICE_TOKEN en frontend/.env.local"; exit 1; }

# 1) Túnel SSH a RDS (si no está arriba).
if ! (timeout 2 bash -c "echo > /dev/tcp/127.0.0.1/$LPORT") 2>/dev/null; then
  echo "==> abriendo túnel SSH a RDS (127.0.0.1:$LPORT)…"
  ssh -i "$PEM" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \
    -fN -L "${LPORT}:${RDS}:5432" "$SSHUSER@$WORKER"
  sleep 2
else
  echo "==> túnel ya abierto en :$LPORT"
fi

# 2) vp-payments local (TEST).
echo "==> vp-payments local en 127.0.0.1:9095 (Ctrl+C para detener)"
cd "$ROOT/backend/vp-engine"
STRIPE_SECRET_KEY="$SK" \
STRIPE_WEBHOOK_SECRET="${WH:-whsec_dev}" \
PAYMENTS_STRIPE_PRODUCT_ID="$PROD" \
PAYMENTS_METHODS="card" \
DATABASE_URL="$DBU" \
PAYMENTS_SERVICE_TOKEN="$TOKEN" \
PAYMENTS_ADMIN_EMAILS="devfidubit@gmail.com" \
PAYMENTS_HTTP_ADDR="127.0.0.1:9095" \
ENV=development LOG_LEVEL=info \
PAYMENTS_COMPANY_ROOT_AFFILIATE_ID="117475" $1
