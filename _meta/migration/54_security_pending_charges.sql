-- 54_security_pending_charges.sql
-- Estados de riesgo para ventas con cobro operativo pendiente de $70:
-- pagos bloqueados por seguridad, disputas y chargebacks.

BEGIN;

ALTER TABLE payments.purchase_intent
  DROP CONSTRAINT IF EXISTS purchase_intent_status_check;

ALTER TABLE payments.purchase_intent
  ADD CONSTRAINT purchase_intent_status_check
  CHECK (status IN (
    'created',
    'paid',
    'activated',
    'needs_placement',
    'failed',
    'expired',
    'refunded',
    'security_blocked',
    'disputed',
    'chargeback'
  ));

COMMENT ON CONSTRAINT purchase_intent_status_check ON payments.purchase_intent IS
  'Incluye estados de riesgo usados por el panel admin para totalizar cargos pendientes de seguridad de $70.';

COMMIT;
