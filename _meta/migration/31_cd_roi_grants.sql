-- 31_cd_roi_grants.sql — Capa 2 (ROI por tiers / CD para todos).
--
-- vp_engine (rol de vp-payments y del motor, miembro de engine_write) necesita:
--   - vp-payments (activación): INSERT investment_cd + wallet (abrir el CD por tier
--     y asegurar la wallet USD del comprador).
--   - motor (AccrueCDROIDaily): INSERT wallet_movement + transaction, UPDATE
--     investment_cd (devengo diario del ROI, concepto 1006, available_at=matures_at).
--
-- wallet_movement sigue siendo APPEND-ONLY: aquí solo se concede INSERT; UPDATE/DELETE
-- permanecen revocados (schema_payouts_v1.1). Idempotente (GRANT no falla si ya existe).
--
-- Aplicar con rol migrator/owner:  psql "$MIGRATOR_DATABASE_URL" -f 31_cd_roi_grants.sql

GRANT INSERT ON mlm.investment_cd, mlm.wallet, mlm.wallet_movement, mlm.transaction TO engine_write;
GRANT UPDATE ON mlm.investment_cd, mlm.transaction TO engine_write;
GRANT SELECT ON mlm.investment_cd, mlm.cd_roi_tier, mlm.v_cd_qualification, mlm.wallet, mlm.asset TO engine_write;
