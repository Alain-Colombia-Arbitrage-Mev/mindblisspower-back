-- 45_cart_reminders.sql
-- Recuperación de carritos abandonados: seguimiento de recordatorios enviados a
-- checkouts en estado 'created' que nunca se pagaron.
--
-- Columnas nullable/aditivas: no cambian el comportamiento existente.

ALTER TABLE payments.purchase_intent
  ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz,               -- último recordatorio enviado (NULL = ninguno)
  ADD COLUMN IF NOT EXISTS reminder_count   integer NOT NULL DEFAULT 0; -- cuántos recordatorios se enviaron

COMMENT ON COLUMN payments.purchase_intent.reminder_sent_at IS
  'Momento del último recordatorio de carrito abandonado enviado al cliente (NULL = ninguno).';
COMMENT ON COLUMN payments.purchase_intent.reminder_count IS
  'Número de recordatorios de carrito abandonado enviados (tope configurable en el sweep).';

-- Índice parcial para el sweep de recordatorios (solo carritos abiertos).
CREATE INDEX IF NOT EXISTS purchase_intent_abandoned_idx
  ON payments.purchase_intent (created_at)
  WHERE status = 'created';
