-- 44_receipt_and_verify.sql
-- Soporte para: (a) comprobante por email al comprador (idempotencia de envío),
-- (b) verificación de la venta contra Stripe live (excluir del reporte los cargos
--     que no existen en la cuenta live — p.ej. transacciones de PRUEBA que
--     quedaron en prod).
--
-- Ambas columnas son nullable y aditivas: no cambian el comportamiento existente.

ALTER TABLE payments.purchase_intent
  ADD COLUMN IF NOT EXISTS receipt_sent_at timestamptz,          -- cuándo se envió el comprobante (NULL = no enviado)
  ADD COLUMN IF NOT EXISTS stripe_present  boolean;              -- ¿el payment_intent existe en Stripe live? NULL = sin verificar

COMMENT ON COLUMN payments.purchase_intent.receipt_sent_at IS
  'Momento en que se envió el comprobante de compra al cliente (idempotencia; NULL = no enviado).';
COMMENT ON COLUMN payments.purchase_intent.stripe_present IS
  'Verificación contra Stripe live: true=existe, false=no existe (posible cargo de PRUEBA), NULL=sin verificar. El reporte de ventas excluye del revenue los intents con stripe_present=false.';
