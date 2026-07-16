-- 34_health_grants.sql — permisos para el endpoint /api/admin/health/system (vp-payments corre como vp_engine).
-- Aplicado a RDS 2026-07-03. Idempotente.
GRANT USAGE ON SCHEMA cron TO vp_engine;
GRANT SELECT ON cron.job TO vp_engine;
GRANT SELECT ON mlm.alert_event TO vp_engine;
