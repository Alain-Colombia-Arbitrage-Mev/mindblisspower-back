#!/usr/bin/env bash
# ============================================================================
# test-payment.sh — Validación automática del flujo de pago → activación.
#
# Levanta Postgres local (Docker), aplica el schema + seed, corre vp-payments
# con tu sk_test, crea una sesión REAL de Stripe Checkout (test, sin cobro) y
# simula el webhook FIRMADO para verificar la activación en DB. No toca RDS.
#
# Requisitos: docker, go, curl, openssl. Correr desde la raíz del repo:
#   bash backend/vp-engine/deploy/test-payment.sh
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"   # raíz del repo
ENGINE="$ROOT/backend/vp-engine"
ENVFILE="$ROOT/backend/.env.local"
DB_PORT=55432
DB_URL="postgres://postgres:test@localhost:${DB_PORT}/vicionpower_test?sslmode=disable"
WHSEC="whsec_localsim_$(openssl rand -hex 8)"
SVC_TOKEN="devtoken_$(openssl rand -hex 8)"
# Producto de TEST: de PAYMENTS_STRIPE_PRODUCT_ID / ID_PRODUCTO_TEST del .env.
# Si vacío → producto inline.
TEST_PRODUCT="${PAYMENTS_STRIPE_PRODUCT_ID:-$(grep -E '^ID_PRODUCTO_TEST=' "$ENVFILE" 2>/dev/null | head -1 | sed -E 's/^ID_PRODUCTO_TEST=//; s/[\"'"'"']//g')}"
CONTAINER="vp-pay-test-db"
BIN="$ENGINE/.test-payment.bin"
SVC_PID=""

# sk_test: de STRIPE_SECRET_KEY, o CLAVE_SECRETA del .env.local
SK="${STRIPE_SECRET_KEY:-$(grep -E '^CLAVE_SECRETA=' "$ENVFILE" | head -1 | sed -E 's/^CLAVE_SECRETA=//; s/[\"'"'"']//g')}"
case "$SK" in
  sk_test_*) ;;
  *) echo "ERROR: no encontré una sk_test_ (revisa CLAVE_SECRETA en $ENVFILE)"; exit 1;;
esac

cleanup() {
  [ -n "$SVC_PID" ] && kill "$SVC_PID" 2>/dev/null || true
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -f "$BIN" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> 1/7 Postgres local (Docker)…"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=test -e POSTGRES_DB=vicionpower_test \
  -p ${DB_PORT}:5432 timescale/timescaledb:latest-pg17 >/dev/null
# El image inicializa y REINICIA una vez → esperar 2 ocurrencias del log "ready"
# y luego confirmar una conexión real estable.
for i in $(seq 1 60); do
  [ "$(docker logs "$CONTAINER" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break; sleep 1
done
for i in $(seq 1 30); do
  docker exec "$CONTAINER" psql -U postgres -d vicionpower_test -c 'SELECT 1' >/dev/null 2>&1 && break; sleep 1
done

echo "==> 2/7 Schema + payments…"
docker exec -i "$CONTAINER" psql -q -U postgres -d vicionpower_test < "$ROOT/backend/_meta/schema_mlm.sql" >/dev/null
docker exec -i "$CONTAINER" psql -q -U postgres -d vicionpower_test < "$ROOT/backend/_meta/migration/30_payments.sql" >/dev/null

echo "==> 3/7 Seed (sponsor + comprador posicionado + 9 packs)…"
docker exec -i "$CONTAINER" psql -q -U postgres -d vicionpower_test >/dev/null <<'SQL'
INSERT INTO mlm.country (id, iso2, name_es, name_en) VALUES (1,'CO','Colombia','Colombia');
INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals) VALUES (1,'USD','US Dollar',true,2);
INSERT INTO mlm.concept (id, kind, name_es, name_en, factor, requires_pair, active)
  VALUES (1,'package_purchase','Compra','Purchase',-1,true,true);
INSERT INTO mlm.package (id, name, amount_usd, pv, type) VALUES
  (1001,'Pack 100',100,100,'enrollment'),(1002,'Pack 250',250,250,'enrollment'),
  (1003,'Pack 500',500,500,'enrollment'),(1004,'Pack 1.000',1000,1000,'enrollment'),
  (1005,'Pack 2.500',2500,2500,'enrollment'),(1006,'Pack 5.000',5000,5000,'enrollment'),
  (1007,'Pack 10.000',10000,10000,'enrollment'),(1008,'Pack 25.000',25000,25000,'enrollment'),
  (1009,'Pack 50.000',50000,50000,'enrollment');
INSERT INTO mlm.person (id, first_name, last_name, email, phone_number, status)
  OVERRIDING SYSTEM VALUE VALUES (1,'Spon','Sor','sponsor@test.local','0','active'),
                                 (2,'Comp','Rador','comprador@test.local','0','active');
INSERT INTO mlm.affiliate (person_id, parent_id, position, sponsor_id, status, path, depth)
  VALUES (1, NULL, NULL, NULL, 'active', ''::ltree, 0);
INSERT INTO mlm.affiliate (person_id, parent_id, position, sponsor_id, status, path, depth)
  SELECT 2, a.id, 'L', a.id, 'active', ''::ltree, 0 FROM mlm.affiliate a WHERE a.person_id=1;
SQL

echo "==> 4/7 Build + run vp-payments…"
( cd "$ENGINE" && go build -o "$BIN" ./cmd/vp-payments )
STRIPE_SECRET_KEY="$SK" \
STRIPE_WEBHOOK_SECRET="$WHSEC" \
PAYMENTS_SERVICE_TOKEN="$SVC_TOKEN" \
PAYMENTS_STRIPE_PRODUCT_ID="$TEST_PRODUCT" \
PAYMENTS_METHODS="card" \
DATABASE_URL="$DB_URL" \
PAYMENTS_HTTP_ADDR="127.0.0.1:9095" \
ENV=development LOG_LEVEL=info \
"$BIN" &
SVC_PID=$!
for i in $(seq 1 20); do curl -sf localhost:9095/health >/dev/null 2>&1 && break; sleep 0.5; done

echo "==> 5/7 Crear Checkout REAL (Stripe test)…  producto=${TEST_PRODUCT:-<inline>}"
CHECKOUT=$(curl -s localhost:9095/api/payments/checkout \
  -H "X-VP-Service-Token: $SVC_TOKEN" -H 'content-type: application/json' \
  -d '{"email":"comprador@test.local","package_id":1004}')
echo "    respuesta: $CHECKOUT"
SESSION=$(printf '%s' "$CHECKOUT" | sed -E 's/.*"session_id":"([^"]+)".*/\1/')
URL=$(printf '%s' "$CHECKOUT" | sed -E 's/.*"url":"([^"]+)".*/\1/')
case "$SESSION" in cs_*) ;; *) echo "FALLO: no se creó la sesión (¿sk_test válida? ¿producto?)"; exit 1;; esac
echo "    session=$SESSION"
echo "    URL pago (test, opcional manual): $URL"

echo "==> 6/7 Simular webhook FIRMADO checkout.session.completed…"
PI="pi_test_$(openssl rand -hex 6)"
PAYLOAD="{\"id\":\"evt_$(openssl rand -hex 6)\",\"object\":\"event\",\"type\":\"checkout.session.completed\",\"data\":{\"object\":{\"id\":\"$SESSION\",\"object\":\"checkout.session\",\"payment_status\":\"paid\",\"payment_intent\":\"$PI\"}}}"
TS=$(date +%s)
SIG=$(printf '%s' "${TS}.${PAYLOAD}" | openssl dgst -sha256 -hmac "$WHSEC" | awk '{print $NF}')
WH=$(curl -s -o /dev/null -w '%{http_code}' localhost:9095/api/webhooks/stripe \
  -H "Stripe-Signature: t=${TS},v1=${SIG}" -H 'content-type: application/json' --data-raw "$PAYLOAD")
echo "    webhook HTTP $WH"
[ "$WH" = "200" ] || { echo "FALLO: webhook no devolvió 200"; exit 1; }
sleep 1

echo "==> 7/7 Verificar activación en DB…"
docker exec -i "$CONTAINER" psql -At -U postgres -d vicionpower_test >/tmp/vp_test_out.txt <<SQL
SELECT 'intent='||status FROM payments.purchase_intent WHERE stripe_session_id='$SESSION';
SELECT 'pkg='||status||'/'||payment_method||'/'||transaction_hash FROM mlm.affiliate_package WHERE transaction_hash='$PI';
SELECT 'pv='||pv_delta_left FROM mlm.tree_event WHERE external_ref='package_purchase:$PI';
SQL
cat /tmp/vp_test_out.txt | sed 's/^/    /'

if grep -q 'intent=activated' /tmp/vp_test_out.txt && grep -q "pkg=active/stripe/$PI" /tmp/vp_test_out.txt && grep -q 'pv=' /tmp/vp_test_out.txt; then
  echo ""; echo "✅ PASS — pago validado: sesión Stripe creada, webhook verificado, paquete activado + PV acreditado."
else
  echo ""; echo "❌ FAIL — revisar salida arriba."; exit 1
fi
