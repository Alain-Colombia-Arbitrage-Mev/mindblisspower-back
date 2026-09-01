-- Migration 63 — permisos para relocacion administrativa de sponsor/arbol.
-- El endpoint protegido por super_admin reconstruye closure/path/depth dentro
-- de una transaccion. Para eso vp-payments necesita DELETE en affiliate_closure,
-- ademas de los grants ya usados por activacion y auditoria.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vp_engine') THEN
    GRANT SELECT, UPDATE ON mlm.affiliate TO vp_engine;
    GRANT SELECT, INSERT, DELETE ON mlm.affiliate_closure TO vp_engine;
    GRANT SELECT, INSERT ON mlm.tree_event TO vp_engine;
    GRANT SELECT, INSERT ON audit.activity_log TO vp_engine;
    GRANT SELECT, UPDATE ON payments.purchase_intent TO vp_engine;
    GRANT SELECT, INSERT, UPDATE ON payments.registration_referral TO vp_engine;
  END IF;
END $$;
