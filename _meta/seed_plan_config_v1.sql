-- =============================================================================
-- VicionPower — Seed de plan_config v1-conservative (ADR 0012)
--
-- Pre-req:
--   1. schema_mlm.sql aplicado.
--   2. schema_governance.sql aplicado.
--   3. schema_payouts.sql + schema_payouts_v1.1.sql aplicados.
--   4. Existe al menos una mlm.person con is_admin=true.
--
-- Uso:
--   psql -U migrator -d vicionpower -v admin_id=<person_id> -f seed_plan_config_v1.sql
--
-- El admin_id corresponde a mlm.person.id del firmante. Para listar candidatos:
--   SELECT id, first_name, last_name, email FROM mlm.person WHERE is_admin = true;
--
-- Idempotencia: UNIQUE en version_label. Re-ejecutar no inserta de nuevo.
-- =============================================================================

\if :{?admin_id}
\else
  \echo 'ERROR: variable admin_id no provista. Usar: psql -v admin_id=<id> ...'
  \quit
\endif

BEGIN;

-- Verificar que el admin existe y es admin (fail-closed).
-- NOTA: psql NO interpola :variables dentro de $$...$$ — se pasa vía GUC.
SELECT set_config('app.seed_admin_id', :'admin_id', true);

DO $$
DECLARE v_admin bigint := current_setting('app.seed_admin_id')::bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM mlm.person WHERE id = v_admin AND is_admin = true) THEN
    RAISE EXCEPTION 'admin_id=% no existe o no tiene is_admin=true', v_admin;
  END IF;
END $$;

-- Bypass del trigger de approval — autorizado SOLO para el seed inicial.
-- Después del seed, todo cambio de plan_config requiere approval_request.
SET LOCAL app.bypass_approval = 'on';

INSERT INTO mlm.plan_config (
  version_label,
  effective_from,
  effective_to,
  block_size,
  bonus_per_block,
  depth_cap,
  daily_cap_factor,
  lifetime_cap_factor,
  treasury_alpha,
  carry_decay_days,
  qualified_directs_left,
  qualified_directs_right,
  created_by_person_id,
  approval_request_id,
  notes
) VALUES (
  'v1-conservative',
  now(),
  NULL,                        -- vigente sin fecha de fin hasta que aparezca v2
  500,                         -- B: tamaño de bloque
  10.00,                       -- r: bonus por bloque (USD)
  10,                          -- D: depth_cap
  3.0,                         -- K_user: daily cap × rank.bonus
  2.0,                         -- K_pkg: lifetime cap × paquete.amount_usd
  0.45,                        -- alpha: 45 % de inflows reasignable a binario
  14,                          -- carry decay (días)
  1,                           -- Q_L: directos calificados pierna izq
  1,                           -- Q_R: directos calificados pierna der
  :admin_id,
  NULL,                        -- approval_request_id NULL solo en seed inicial
  'Seed inicial. ADR 0012. Bypass autorizado para el primer registro; '
  || 'cambios subsiguientes pasan por approval_request (ADR 0010).'
)
ON CONFLICT (version_label) DO NOTHING;

-- Verificar que quedó exactamente uno vigente
DO $$
DECLARE v_count integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM mlm.plan_config
   WHERE effective_to IS NULL OR effective_to > now();
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Estado inconsistente: % plan_config vigentes (esperado 1)', v_count;
  END IF;
END $$;

-- Log de auditoría
INSERT INTO audit.activity_log (
  actor_user_id, action, entity_type, entity_id, after_data, occurred_at
)
SELECT
  (SELECT user_id FROM mlm.person WHERE id = :admin_id),
  'plan_config.seed',
  'plan_config',
  pc.id::text,
  to_jsonb(pc),
  now()
FROM mlm.plan_config pc
WHERE pc.version_label = 'v1-conservative';

COMMIT;

\echo ''
\echo 'plan_config v1-conservative insertado. Verificar:'
\echo '  SELECT * FROM mlm.plan_config WHERE version_label = ''v1-conservative'';'
\echo ''
\echo 'Siguiente paso: abrir el primer período binario:'
\echo '  SELECT mlm.fn_open_next_binary_period();'
