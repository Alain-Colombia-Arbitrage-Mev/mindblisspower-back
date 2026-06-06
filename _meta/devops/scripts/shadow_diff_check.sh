#!/usr/bin/env bash
# shadow_diff_check.sh — comparación nightly del shadow mode vs producción.
#
# Falla con exit code != 0 si encuentra cualquier divergencia > $0.01 entre
# binary_block_payment_shadow y binary_block_payment para el último período
# cerrado. Usado en CI / cron pre-cutover (4 semanas paralel run, ADR 0012).
#
# Env vars:
#   DATABASE_URL   postgres DSN (default: lee de ~/.pgpass)
#   PERIOD_ID      opcional: período a chequear; default = último cerrado
#   THRESHOLD_USD  default 0.01
#
# Exit codes:
#   0  sin divergencias
#   1  hay divergencias > THRESHOLD_USD
#   2  error de conexión / SQL
set -euo pipefail

DATABASE_URL="${DATABASE_URL:-}"
THRESHOLD_USD="${THRESHOLD_USD:-0.01}"
PERIOD_ID="${PERIOD_ID:-}"

if [[ -z "$DATABASE_URL" ]]; then
  echo "ERROR: DATABASE_URL no seteado" >&2
  exit 2
fi

if [[ -z "$PERIOD_ID" ]]; then
  PERIOD_ID=$(psql "$DATABASE_URL" -tAc \
    "SELECT id FROM mlm.binary_period WHERE status='closed' ORDER BY period_end DESC LIMIT 1") \
    || { echo "ERROR: no se pudo leer último período" >&2; exit 2; }
fi

if [[ -z "$PERIOD_ID" ]]; then
  echo "WARN: no hay períodos cerrados; nada que comparar"
  exit 0
fi

echo "Checking shadow diff for period_id=$PERIOD_ID (threshold=\$$THRESHOLD_USD)"

DIVERGENCES=$(psql "$DATABASE_URL" -tAc "
  SELECT count(*)
    FROM mlm.v_shadow_diff
   WHERE binary_period_id = $PERIOD_ID
     AND ABS(diff) > $THRESHOLD_USD;
") || { echo "ERROR: query falló" >&2; exit 2; }

if [[ "$DIVERGENCES" -gt 0 ]]; then
  echo "FAIL: $DIVERGENCES afiliados con divergencia > \$$THRESHOLD_USD"
  echo ""
  echo "Top 20 divergencias:"
  psql "$DATABASE_URL" -c "
    SELECT affiliate_id, shadow_paid, prod_paid, diff
      FROM mlm.v_shadow_diff
     WHERE binary_period_id = $PERIOD_ID
       AND ABS(diff) > $THRESHOLD_USD
     ORDER BY ABS(diff) DESC
     LIMIT 20;"
  echo ""
  echo "Cutover BLOQUEADO hasta entender la causa."
  exit 1
fi

echo "OK: cero divergencias > \$$THRESHOLD_USD para period_id=$PERIOD_ID"
exit 0
