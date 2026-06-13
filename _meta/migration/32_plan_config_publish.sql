-- 32_plan_config_publish.sql — Capa 3 (editor de comisiones con four-eyes).
--
-- 1) Nuevo tipo de operación de aprobación: 'plan_config_publish' (ADR-0010).
--    ALTER TYPE ... ADD VALUE no puede ir dentro de una transacción que lo use,
--    por eso va solo. Idempotente con IF NOT EXISTS (PG12+).
-- 2) Seed de la config baseline (v2-baseline) si no existe ninguna activa. El
--    primer INSERT usa el bypass autorizado (no hay cadena de approval todavía).
--    created_by = admin devfidubit (o el primer is_admin que exista).

ALTER TYPE mlm.approval_operation_type ADD VALUE IF NOT EXISTS 'plan_config_publish';
