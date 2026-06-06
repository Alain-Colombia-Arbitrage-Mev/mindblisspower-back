#!/usr/bin/env bash
# /usr/local/bin/check-drift.sh
# Nightly drift check. Posts to Slack if any of the truth views report
# materialized != computed. Exits 0 on clean, 1 on drift, 2 on internal error.
#
# Cron: 0 4 * * * postgres /usr/local/bin/check-drift.sh
#
# Required env (sourced from /etc/vicionpower/check-drift.env, mode 600):
#   DATABASE_URL   read-only Postgres URL (app_read user is enough)
#   SLACK_WEBHOOK  https://hooks.slack.com/services/...
#   ENV_NAME       'production' | 'staging'
set -euo pipefail

ENV_FILE=/etc/vicionpower/check-drift.env
[[ -r "$ENV_FILE" ]] || { echo "missing $ENV_FILE" >&2; exit 2; }
# shellcheck disable=SC1090
source "$ENV_FILE"

: "${DATABASE_URL:?}"
: "${SLACK_WEBHOOK:?}"
: "${ENV_NAME:?}"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

log() { printf '[%s] %s\n' "$(date -Is)" "$*"; }
slack() {
  local color="$1" text="$2"
  curl -fsS -X POST -H 'Content-Type: application/json' \
    --data "$(jq -n --arg c "$color" --arg t "$text" --arg e "$ENV_NAME" \
      '{attachments:[{color:$c,title:("VicionPower drift check ["+$e+"]"),text:$t,ts:now}]}')" \
    "$SLACK_WEBHOOK" >/dev/null
}

# ─── 1. Wallet balance drift ──────────────────────────────────────────────────
psql "$DATABASE_URL" -At -F $'\t' -c "
  SELECT wallet_id, materialized_balance, computed_balance, drift
    FROM mlm.v_wallet_balance_truth
   WHERE abs(drift) > 0.00000001
   ORDER BY abs(drift) DESC
   LIMIT 50;
" >"$TMPDIR/wallet_drift.tsv"

WALLET_DRIFT_ROWS=$(wc -l <"$TMPDIR/wallet_drift.tsv" | tr -d ' ')

# ─── 2. Tree PV drift ─────────────────────────────────────────────────────────
psql "$DATABASE_URL" -At -F $'\t' -c "
  SELECT id, materialized_left, computed_left, materialized_right, computed_right
    FROM mlm.v_tree_pv_truth
   WHERE materialized_left  <> computed_left
      OR materialized_right <> computed_right
   ORDER BY id
   LIMIT 50;
" >"$TMPDIR/pv_drift.tsv"

PV_DRIFT_ROWS=$(wc -l <"$TMPDIR/pv_drift.tsv" | tr -d ' ')

# ─── 3. Unbalanced posted transactions (paired concepts) ──────────────────────
psql "$DATABASE_URL" -At -F $'\t' -c "
  SELECT t.id::text, t.external_ref, COALESCE(SUM(wm.amount), 0) AS net
    FROM mlm.transaction t
    JOIN mlm.wallet_movement wm ON wm.transaction_id = t.id
    JOIN mlm.concept c ON c.id = wm.concept_id
   WHERE t.status = 'posted' AND c.requires_pair = true
   GROUP BY t.id, t.external_ref
  HAVING COALESCE(SUM(wm.amount), 0) <> 0
   LIMIT 50;
" >"$TMPDIR/txn_unbalanced.tsv"

TXN_UNBAL_ROWS=$(wc -l <"$TMPDIR/txn_unbalanced.tsv" | tr -d ' ')

# ─── 4. Decide ────────────────────────────────────────────────────────────────
TOTAL=$((WALLET_DRIFT_ROWS + PV_DRIFT_ROWS + TXN_UNBAL_ROWS))

if [[ "$TOTAL" -eq 0 ]]; then
  log "OK: no drift detected"
  exit 0
fi

# Drift! Build a Slack-friendly digest and bail with code 1.
{
  printf '*Wallet drift rows*: %s\n' "$WALLET_DRIFT_ROWS"
  if [[ "$WALLET_DRIFT_ROWS" -gt 0 ]]; then
    echo '```'
    head -10 "$TMPDIR/wallet_drift.tsv"
    echo '```'
  fi
  printf '*Tree PV drift rows*: %s\n' "$PV_DRIFT_ROWS"
  if [[ "$PV_DRIFT_ROWS" -gt 0 ]]; then
    echo '```'
    head -10 "$TMPDIR/pv_drift.tsv"
    echo '```'
  fi
  printf '*Unbalanced posted txns*: %s\n' "$TXN_UNBAL_ROWS"
  if [[ "$TXN_UNBAL_ROWS" -gt 0 ]]; then
    echo '```'
    head -10 "$TMPDIR/txn_unbalanced.tsv"
    echo '```'
  fi
} >"$TMPDIR/digest.md"

slack danger "$(cat "$TMPDIR/digest.md")"
log "DRIFT detected ($TOTAL rows). Slack alerted."
exit 1
