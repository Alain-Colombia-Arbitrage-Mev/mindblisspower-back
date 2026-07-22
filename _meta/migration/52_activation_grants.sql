-- 52_activation_grants.sql — permisos que faltaban para activar pagos cobrados.
-- vp-payments (rol vp_engine) activa un pago en ActivatePaidPurchase, que dispara
-- dos triggers cuyo cuerpo escribe en tablas sin grant para vp_engine:
--   - trg_wallet_balance (AFTER INSERT en mlm.wallet_movement) -> fn_update_wallet_balance()
--     hace UPDATE mlm.wallet  -> "permission denied for table wallet" en el post-inflow.
--   - trg_maintain_affiliate_closure (al INSERT en mlm.affiliate) -> INSERT mlm.affiliate_closure
--     -> "permission denied for table affiliate_closure" en el auto-place.
-- Cada activacion revienta y hace rollback -> el intent queda en 'created'.
-- Delta verificado en RDS con has_table_privilege (autoritativo, resuelve herencia):
-- INSERT ya presente en las 8 tablas de activacion; solo faltan estos 2.
-- Misma clase que 41/47 (grants olvidados). Idempotente y condicional (corre igual en dev sin el rol).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vp_engine') THEN
    GRANT UPDATE ON mlm.wallet            TO vp_engine;
    GRANT INSERT ON mlm.affiliate_closure TO vp_engine;
  END IF;
END $$;
