-- ============================================================================
-- validate_test_payment.sql — Verificar un pago de prueba de punta a punta.
-- Uso:  psql ... -v email='comprador@correo.com' -f validate_test_payment.sql
-- ============================================================================

\echo '== 1) PAGO (payments.purchase_intent) =='
SELECT id, status, package_id, amount_usd, fee_usd, total_cents,
       stripe_payment_intent_id, paid_at, activated_at, affiliate_id
  FROM payments.purchase_intent
 WHERE lower(user_id) = lower(:'email')
 ORDER BY created_at DESC LIMIT 5;
-- Esperado tras pago OK: status='activated', paid_at y activated_at no nulos,
-- affiliate_id asignado. ('needs_placement' = pagó pero sin sponsor para colocar.)

\echo '== 2) POSICIÓN (mlm.affiliate) =='
SELECT a.id AS affiliate_id, a.parent_id, a.position, a.sponsor_id, a.depth,
       a.status, a.path
  FROM mlm.affiliate a
  JOIN mlm.person p ON p.id = a.person_id
 WHERE lower(p.email) = lower(:'email');
-- Esperado: una fila con posición L/R y path bajo el sponsor.

\echo '== 3) PAQUETE ACTIVADO (mlm.affiliate_package) =='
SELECT ap.id, ap.package_id, ap.status, ap.payment_method, ap.transaction_hash,
       ap.pv_remaining, ap.activated_at
  FROM mlm.affiliate_package ap
  JOIN mlm.affiliate a ON a.id = ap.affiliate_id
  JOIN mlm.person p   ON p.id = a.person_id
 WHERE lower(p.email) = lower(:'email')
 ORDER BY ap.activated_at DESC;
-- Esperado: status='active', payment_method='stripe', transaction_hash = pi_...

\echo '== 4) PV ACREDITADO (mlm.tree_event) + propagación a ancestros =='
SELECT te.external_ref, te.kind, te.affiliate_id,
       te.pv_delta_left, te.pv_delta_right, te.occurred_at, te.applied_at
  FROM mlm.tree_event te
  JOIN mlm.affiliate a ON a.id = te.affiliate_id
  JOIN mlm.person p   ON p.id = a.person_id
 WHERE lower(p.email) = lower(:'email')
 ORDER BY te.occurred_at DESC LIMIT 5;
-- Esperado: un 'pv_credit' con external_ref='package_purchase:pi_...' (applied_at no nulo).

\echo '== 5) COMISIONES del miembro (lo que verá en la UI — solo wallet USD, excluye 401k USD-RET) =='
SELECT
  COALESCE(SUM(wm.amount) FILTER (WHERE NOT wm.is_frozen AND (wm.available_at IS NULL OR wm.available_at <= current_date)),0) AS disponible_retiro,
  COALESCE(SUM(wm.amount) FILTER (WHERE NOT wm.is_frozen AND wm.available_at > current_date AND wm.amount > 0),0) AS madurando
  FROM mlm.wallet_movement wm
  JOIN mlm.affiliate a ON a.id = wm.affiliate_id
  JOIN mlm.person p   ON p.id = a.person_id
  JOIN mlm.wallet  w  ON w.id = wm.wallet_id
  JOIN mlm.asset   s  ON s.id = w.asset_id AND s.symbol = 'USD'
 WHERE lower(p.email) = lower(:'email');
-- Día 1 normalmente 0 (las comisiones las devenga el bonus engine después).
-- Nota: esta query excluye la wallet USD-RET (401k) — espeja la lógica de
-- GetMemberSummary/RequestWithdrawal para que el resultado sea coherente.
