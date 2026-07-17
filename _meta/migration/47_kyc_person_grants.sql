-- 47_kyc_person_grants.sql — permisos que faltaban para KYC/provisión.
-- vp-payments (rol vp_engine) necesita crear/actualizar mlm.person:
--   - EnsurePerson (auto-provisión de usuarios nuevos en checkout y KYC)
--   - ConfirmKYCDocument / FinishKYCOCR (person.kyc_status)
--   - GetMemberContext persiste invitation_link en mlm.affiliate (código de referido)
-- La migración 41 concedió sobre mlm.kyc_document pero olvidó mlm.person/affiliate.
-- Idempotente; condicional para correr igual en dev (sin esos roles) y en RDS.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vp_engine') THEN
    GRANT INSERT, UPDATE ON mlm.person    TO vp_engine;
    GRANT INSERT, UPDATE ON mlm.affiliate TO vp_engine;
  END IF;
END $$;
