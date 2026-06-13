-- ============================================================================
-- verify_payments.sql — Revisión de RDS para activar cobros (PACK MINDBLISS).
-- Correr con un rol owner/migrator. Idempotente.
-- ============================================================================

-- 1) ¿Existe el esquema payments? (lo crea 30_payments.sql)
SELECT to_regclass('payments.purchase_intent') AS purchase_intent,
       to_regclass('payments.stripe_event')    AS stripe_event;
-- Si ambas son NULL → correr antes: \i _meta/migration/30_payments.sql

-- 2) Catálogo: ¿están los 9 packs en mlm.package? (el checkout busca por id aquí)
SELECT id, name, amount_usd, pv, type, is_active
  FROM mlm.package
 ORDER BY amount_usd;

-- 2b) SEED idempotente de los 9 packs Mindbliss (ids 1001-1009) — correr SOLO si
--     no aparecen arriba con los montos correctos. pv = amount (convención v1;
--     ajustar si el plan define otro PV). El 1% NO va aquí: lo agrega el servicio.
INSERT INTO mlm.package (id, name, amount_usd, pv, type, is_active) VALUES
  (1001, 'Pack 100',     100,     100,    'enrollment', true),
  (1002, 'Pack 250',     250,     250,    'enrollment', true),
  (1003, 'Pack 500',     500,     500,    'enrollment', true),
  (1004, 'Pack 1.000',   1000,    1000,   'enrollment', true),
  (1005, 'Pack 2.500',   2500,    2500,   'enrollment', true),
  (1006, 'Pack 5.000',   5000,    5000,   'enrollment', true),
  (1007, 'Pack 10.000',  10000,   10000,  'enrollment', true),
  (1008, 'Pack 25.000',  25000,   25000,  'enrollment', true),
  (1009, 'Pack 50.000',  50000,   50000,  'enrollment', true)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name, amount_usd = EXCLUDED.amount_usd,
      pv = EXCLUDED.pv, type = EXCLUDED.type, is_active = EXCLUDED.is_active;
-- (VIP 100.000+ se agrega aparte cuando se defina; total cobrado siempre = pack × 1.01)

-- 3) GRANTS: el rol del servicio vp-payments (VP_ENGINE_DATABASE_URL) debe poder
--    leer/escribir payments.* y escribir las tablas de activación. Reemplazá
--    :svc_role por el rol real (p.ej. vp_engine).
--    \set svc_role vp_engine
GRANT USAGE ON SCHEMA payments TO :svc_role;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA payments TO :svc_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA payments GRANT SELECT, INSERT, UPDATE ON TABLES TO :svc_role;
-- Activación (ya deberían existir para el motor; confirmar):
GRANT SELECT, INSERT, UPDATE ON mlm.affiliate, mlm.affiliate_package, mlm.tree_event TO :svc_role;
GRANT SELECT ON mlm.package, mlm.person, mlm.wallet, mlm.wallet_movement TO :svc_role;

-- 4) Sanity de conceptos/triggers (solo lectura, informativo):
SELECT id, kind, factor, requires_pair, active FROM mlm.concept
 WHERE kind IN ('package_purchase','platform_fee') ORDER BY id;
