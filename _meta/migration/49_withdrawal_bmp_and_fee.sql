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
-- Idempotente (IF NOT EXISTS; el CHECK atrapa duplicate_object).
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

-- Candado de coherencia del dinero: net_usd = amount_usd - fee_usd.
--
-- Hasta ahora esta invariante vivía SÓLO en Go (withdrawals.CalcFee deriva el
-- neto por resta). Cualquier UPDATE manual, script de soporte o migración
-- futura podía dejar las tres columnas descuadradas sin que nada lo notara.
-- El CHECK la ata en la base, que es donde el dinero realmente vive.
--
-- Por qué el brazo `fee_usd IS NULL`:
--
--   * Filas históricas backfilleadas arriba: fee_usd=0, net_usd=amount_usd →
--     0 = amount_usd - 0 ✓ (las cubre el segundo brazo, no necesitan el
--     primero).
--   * Filas nuevas con fee real: net = amount - fee por construcción ✓.
--   * Filas "intermedias": entre aplicar esta migración y desplegar el binario
--     que calcula el fee, el código viejo inserta sin fee_usd/net_usd (ambas
--     nacen NULL, sin default). Sin el brazo `IS NULL` el constraint las
--     rechazaría y tumbaría los retiros durante la ventana de deploy. Con él,
--     pasan y quedan cubiertas por el backfill de una futura re-aplicación.
--
-- amount_usd es NOT NULL, así que el segundo brazo nunca es NULL por culpa del
-- bruto: si fee_usd está presente, la aritmética se exige de verdad.
--
-- Idempotente: ADD CONSTRAINT IF NOT EXISTS no existe para CHECK en Postgres,
-- así que se atrapa duplicate_object. El handler abre una subtransacción, de
-- modo que la excepción no aborta el BEGIN/COMMIT de esta migración.
DO $$
BEGIN
  ALTER TABLE mlm.withdrawal_request
    ADD CONSTRAINT withdrawal_request_net_is_gross_minus_fee_chk
    CHECK (fee_usd IS NULL OR net_usd = amount_usd - fee_usd);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Índice para la cola admin filtrada por estado BMP.
CREATE INDEX IF NOT EXISTS withdrawal_request_bmp_status_idx
  ON mlm.withdrawal_request (bmp_status)
  WHERE status IN ('requested','approved');

COMMIT;
