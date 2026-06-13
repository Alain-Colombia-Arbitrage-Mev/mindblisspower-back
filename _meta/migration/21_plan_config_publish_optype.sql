-- Add the plan_config publish operation to the four-eyes enum (ADR-0010).
-- Owned by vp-api (Centro de Mando Sub-proyecto 3).
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction that then USES
-- the new value in the same txn; keep this migration standalone. Idempotent.
ALTER TYPE mlm.approval_operation_type ADD VALUE IF NOT EXISTS 'plan_config_publish';
