-- 55_refund_accounting.sql
-- Auditoria de reembolsos ejecutados desde el panel admin.

BEGIN;

ALTER TABLE payments.purchase_intent
  ADD COLUMN IF NOT EXISTS refund_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz,
  ADD COLUMN IF NOT EXISTS stripe_refund_id text,
  ADD COLUMN IF NOT EXISTS refund_reason text,
  ADD COLUMN IF NOT EXISTS refunded_by text;

CREATE INDEX IF NOT EXISTS purchase_intent_refunded_at_idx
  ON payments.purchase_intent (refunded_at)
  WHERE refunded_at IS NOT NULL;

COMMENT ON COLUMN payments.purchase_intent.refund_cents IS
  'Monto reembolsado en centavos USD. Para reembolsos completos coincide con total_cents.';
COMMENT ON COLUMN payments.purchase_intent.stripe_refund_id IS
  'ID re_ de Stripe generado por el panel admin, cuando aplica.';
COMMENT ON COLUMN payments.purchase_intent.refunded_by IS
  'Email del super_admin que ejecuto el reembolso desde el panel.';

COMMIT;
