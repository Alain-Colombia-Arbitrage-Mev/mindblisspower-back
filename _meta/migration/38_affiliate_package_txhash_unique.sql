-- 38_affiliate_package_txhash_unique.sql — Cierra la brecha I1 de la auditoría de pagos.
--
-- activation.go dedup-a la activación con `INSERT ... SELECT ... WHERE NOT EXISTS
-- (transaction_hash = $3)` — un check-then-insert NO atómico, sin respaldo a nivel DB.
-- El schema declaraba `transaction_hash text` SIN índice único, así que dos webhooks
-- concurrentes (o un reproceso por un intent distinto) podrían doble-activar
-- (doble PV + doble CD). El `FOR UPDATE` sobre purchase_intent serializa el caso
-- mismo-session, pero no hay garantía a nivel DB.
--
-- Fix: índice ÚNICO PARCIAL sobre transaction_hash (sólo NOT NULL). Los paquetes
-- legacy migrados con transaction_hash NULL quedan fuera del índice (no chocan);
-- sólo las activaciones Stripe (payment_intent único) quedan garantizadas únicas.
-- Con este índice, el NOT EXISTS de activation.go pasa a estar respaldado: un
-- segundo INSERT del mismo hash falla a nivel DB en vez de colarse por una carrera.
--
-- Pre-chequeo defensivo: aborta si ya existen duplicados NOT NULL (no debería
-- haberlos; si los hay hay que resolverlos antes de imponer la unicidad).

BEGIN;

DO $$
DECLARE
  dups int;
BEGIN
  SELECT count(*) INTO dups FROM (
    SELECT transaction_hash
      FROM mlm.affiliate_package
     WHERE transaction_hash IS NOT NULL
     GROUP BY transaction_hash
    HAVING count(*) > 1
  ) d;
  IF dups > 0 THEN
    RAISE EXCEPTION 'abort: % transaction_hash duplicados en mlm.affiliate_package — resolver antes de imponer unicidad', dups;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS affiliate_package_txhash_uidx
  ON mlm.affiliate_package (transaction_hash)
  WHERE transaction_hash IS NOT NULL;

COMMIT;
