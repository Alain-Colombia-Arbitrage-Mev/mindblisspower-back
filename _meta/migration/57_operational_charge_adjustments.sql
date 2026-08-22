-- 57_operational_charge_adjustments.sql
-- Ajustes agregados de cargos operativos del procesador. No alteran pagos
-- reales ni el ledger MLM; complementan el reporte de ventas cuando el cargo
-- llega como agregado externo (ej. 5 rechazos + 1 reembolso).

BEGIN;

CREATE TABLE IF NOT EXISTS payments.operational_charge_adjustment (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref      text UNIQUE,
  charge_type       text NOT NULL
                    CHECK (charge_type IN ('failed','refunded','security_blocked','disputed','chargeback')),
  quantity          integer NOT NULL CHECK (quantity > 0 AND quantity <= 10000),
  unit_amount_usd   numeric(14,2) NOT NULL DEFAULT 70.00 CHECK (unit_amount_usd >= 0),
  total_amount_usd  numeric(14,2) GENERATED ALWAYS AS (quantity * unit_amount_usd) STORED,
  reason            text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  created_by        text NOT NULL,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS operational_charge_adjustment_occurred_idx
  ON payments.operational_charge_adjustment (occurred_at DESC);

CREATE INDEX IF NOT EXISTS operational_charge_adjustment_type_idx
  ON payments.operational_charge_adjustment (charge_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS operational_charge_adjustment_external_ref_idx
  ON payments.operational_charge_adjustment (external_ref)
  WHERE external_ref IS NOT NULL;

COMMENT ON TABLE payments.operational_charge_adjustment IS
  'Cargos operativos agregados del procesador. Fuente complementaria para security_charges; no representa un pago Stripe individual.';

COMMENT ON COLUMN payments.operational_charge_adjustment.unit_amount_usd IS
  'Cargo unitario operativo por proceso. Regla vigente: 70 USD.';

GRANT SELECT ON payments.operational_charge_adjustment TO app_read;
GRANT SELECT, INSERT ON payments.operational_charge_adjustment TO app_write;
GRANT ALL ON payments.operational_charge_adjustment TO app_admin;

COMMIT;
