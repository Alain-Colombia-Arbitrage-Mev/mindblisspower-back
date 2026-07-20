-- =============================================================================
-- 49_withdrawal_bmp_and_fee.sql — verificación BMP + fee de retiro
-- =============================================================================
-- Agrega a mlm.withdrawal_request:
--
--   a) El resultado de la última verificación contra BMP. SetWithdrawalStatus
--      rechaza la transición a 'paid' si bmp_status <> 'allowed' o si
--      bmp_verified_at tiene más de 15 minutos (fail-closed al pagar).
--
--   b) El fee de retiro (4%). fee_pct se persiste POR RETIRO y no se lee de
--      configuración al pagar: si la política cambia, los retiros ya
--      solicitados conservan el porcentaje que se les prometió.
--
-- El afiliado se debita el BRUTO (amount_usd) con el concepto 1013 ya
-- existente; recibe net_usd en BMP. Los ingresos por fee se reportan con
-- SUM(fee_usd) WHERE status='paid' — mismo criterio que el fee del 1% de
-- compras, cuyo asiento contable también está diferido.
--
-- Idempotente (IF NOT EXISTS).
-- =============================================================================

BEGIN;

ALTER TABLE mlm.withdrawal_request
  ADD COLUMN IF NOT EXISTS bmp_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS bmp_status      text,
  ADD COLUMN IF NOT EXISTS bmp_email_used  text,
  ADD COLUMN IF NOT EXISTS fee_pct         numeric(5,4) NOT NULL DEFAULT 0.04,
  ADD COLUMN IF NOT EXISTS fee_usd         numeric(14,2),
  ADD COLUMN IF NOT EXISTS net_usd         numeric(14,2);

COMMENT ON COLUMN mlm.withdrawal_request.bmp_status IS
  'allowed | not_registered | kyc_pending | va_incomplete | bmp_blocked | unavailable';
COMMENT ON COLUMN mlm.withdrawal_request.fee_pct IS
  'Fracción de comisión aplicada a este retiro (0.04 = 4%). Congelada al solicitar.';
COMMENT ON COLUMN mlm.withdrawal_request.net_usd IS
  'Monto que recibe el afiliado en BMP = amount_usd - fee_usd.';

-- Backfill de retiros históricos: fee 0 y neto = bruto, para no reescribir
-- retrospectivamente lo que ya se pagó sin comisión.
UPDATE mlm.withdrawal_request
   SET fee_pct = 0, fee_usd = 0, net_usd = amount_usd
 WHERE fee_usd IS NULL;

-- Índice para la cola admin filtrada por estado BMP.
CREATE INDEX IF NOT EXISTS withdrawal_request_bmp_status_idx
  ON mlm.withdrawal_request (bmp_status)
  WHERE status IN ('requested','approved');

COMMIT;
