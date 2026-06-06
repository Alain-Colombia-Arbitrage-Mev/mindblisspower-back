-- =============================================================================
-- VicionPower — Schema payouts v1.1 (patch aditivo sobre schema_payouts.sql)
--
-- Este archivo NO recrea objetos de schema_payouts.sql. Solo añade lo
-- necesario para cerrar gaps detectados en la revisión 2026-05-07:
--
--   1. T4 enforcement: revocar UPDATE en tablas append-only.
--   2. Shadow mode: tabla espejo para los 30 días previos al cutover.
--   3. plan_config governance: bloquear cambios sin approval_request aprobado.
--   4. Cadencia semanal: función para abrir el siguiente período (Bogotá).
--   5. Carry decay: función explícita que el motor llama al cerrar.
--
-- Pre-req: schema_payouts.sql + schema_governance.sql ya aplicados.
-- Run: psql -U migrator -d vicionpower -f schema_payouts_v1.1.sql
-- Idempotente sobre fresh + reaplicable (DROP IF EXISTS donde corresponde).
-- =============================================================================

SET search_path = mlm, public;

-- =============================================================================
-- 1. T4 — append-only en tablas de ledger y de payouts
-- =============================================================================
-- ADR 0012 §T4: "movement append-only. Cualquier corrección por transacción
-- reversa referenciada, nunca UPDATE/DELETE retroactivo."
-- schema_payouts.sql §8 daba UPDATE en binary_block_payment a engine_write.
-- Lo revocamos. El motor nunca actualiza filas existentes; corrige con INSERT
-- de signo opuesto contra una nueva transaction.

REVOKE UPDATE ON mlm.binary_block_payment FROM engine_write;
REVOKE UPDATE ON mlm.wallet_movement      FROM app_write;
REVOKE DELETE ON mlm.binary_block_payment FROM engine_write, app_admin;
REVOKE DELETE ON mlm.wallet_movement      FROM app_write,    app_admin;

-- binary_period sí necesita UPDATE (status pasa open→closing→closed con campos
-- de snapshot). binary_node_state sí necesita UPDATE (counters se mueven
-- durante el período). package_cap_state sí necesita UPDATE (paid_total).
-- Solo binary_block_payment y wallet_movement son inmutables post-INSERT.

-- =============================================================================
-- 2. SHADOW MODE — espejo de binary_block_payment para los 30d de paralel run
-- =============================================================================
-- ADR 0012 plan-migración Fase 2: shadow obligatorio antes de cutover.
-- El motor nuevo escribe sus pagos calculados acá en lugar de a la tabla
-- canónica. La vista v_shadow_diff compara contra los pagos legacy
-- replicados como tree_event para encontrar divergencias.

CREATE TABLE IF NOT EXISTS mlm.binary_block_payment_shadow (
  LIKE mlm.binary_block_payment INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  shadow_run_id        bigint NOT NULL,
  shadow_calculated_at timestamptz NOT NULL DEFAULT now(),
  shadow_engine_version text NOT NULL
);

-- shadow no es hypertable — son 4-6 semanas de datos, índices b-tree alcanzan.
CREATE INDEX IF NOT EXISTS bpp_shadow_period_idx
  ON mlm.binary_block_payment_shadow(binary_period_id, affiliate_id);
CREATE INDEX IF NOT EXISTS bpp_shadow_run_idx
  ON mlm.binary_block_payment_shadow(shadow_run_id, shadow_calculated_at DESC);

GRANT INSERT, SELECT ON mlm.binary_block_payment_shadow TO engine_write;
GRANT SELECT          ON mlm.binary_block_payment_shadow TO app_read;

-- Vista de divergencias (usada nightly para validar shadow vs producción).
-- Cero filas con abs(diff) > 0.01 por afiliado durante 30 días = OK cutover.
CREATE OR REPLACE VIEW mlm.v_shadow_diff AS
WITH shadow_agg AS (
  SELECT binary_period_id, affiliate_id,
         SUM(net_amount) AS shadow_paid
    FROM mlm.binary_block_payment_shadow
   GROUP BY binary_period_id, affiliate_id
),
prod_agg AS (
  SELECT binary_period_id, affiliate_id,
         SUM(net_amount) AS prod_paid
    FROM mlm.binary_block_payment
   GROUP BY binary_period_id, affiliate_id
)
SELECT
  COALESCE(s.binary_period_id, p.binary_period_id) AS binary_period_id,
  COALESCE(s.affiliate_id,     p.affiliate_id)     AS affiliate_id,
  COALESCE(s.shadow_paid, 0) AS shadow_paid,
  COALESCE(p.prod_paid,   0) AS prod_paid,
  COALESCE(s.shadow_paid, 0) - COALESCE(p.prod_paid, 0) AS diff,
  CASE
    WHEN ABS(COALESCE(s.shadow_paid, 0) - COALESCE(p.prod_paid, 0)) <= 0.01 THEN 'OK'
    ELSE 'DIVERGENCE'
  END AS status
FROM shadow_agg s
FULL OUTER JOIN prod_agg p
  ON s.binary_period_id = p.binary_period_id
 AND s.affiliate_id     = p.affiliate_id;

-- =============================================================================
-- 3. plan_config governance — no se modifica sin approval aprobado
-- =============================================================================
-- ADR 0010 (four-eyes) + ADR 0012: cambios de parámetros van por
-- approval_request con dos admins. Hoy nada bloquea un INSERT/UPDATE directo
-- en plan_config. Este trigger lo bloquea salvo que app.bypass_approval esté
-- en true (uso reservado a la migración inicial y al test harness).

CREATE OR REPLACE FUNCTION mlm.fn_enforce_plan_config_approval()
RETURNS trigger AS $$
DECLARE
  v_bypass    boolean;
  v_approved  boolean;
BEGIN
  -- Bypass autorizado: en la inserción inicial, antes de que exista la cadena
  -- de approval, o en tests. Setear con: SET LOCAL app.bypass_approval = 'on';
  BEGIN
    v_bypass := COALESCE(current_setting('app.bypass_approval', true)::boolean, false);
  EXCEPTION WHEN OTHERS THEN
    v_bypass := false;
  END;

  IF v_bypass THEN RETURN NEW; END IF;

  IF NEW.approval_request_id IS NULL THEN
    RAISE EXCEPTION 'plan_config requires approval_request_id (ADR 0010 four-eyes)';
  END IF;

  SELECT (status = 'approved') INTO v_approved
    FROM mlm.approval_request
   WHERE id = NEW.approval_request_id;

  IF NOT COALESCE(v_approved, false) THEN
    RAISE EXCEPTION 'plan_config.approval_request_id=% is not in status=approved',
      NEW.approval_request_id;
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_plan_config_approval ON mlm.plan_config;
CREATE TRIGGER trg_enforce_plan_config_approval
  BEFORE INSERT OR UPDATE ON mlm.plan_config
  FOR EACH ROW EXECUTE FUNCTION mlm.fn_enforce_plan_config_approval();

-- Para insertar la primera config (v1-conservative) durante la migración:
--   BEGIN;
--   SET LOCAL app.bypass_approval = 'on';
--   INSERT INTO mlm.plan_config (...) VALUES (...);
--   COMMIT;

-- =============================================================================
-- 4. CADENCIA SEMANAL — abrir el siguiente período (lunes 02:00 Bogotá)
-- =============================================================================
-- ADR 0012 §5. Esta función la llama el scheduler (gocron en vp-engine) o
-- pg_cron. Es idempotente: si el período de la próxima semana ya existe, la
-- función no hace nada.

CREATE OR REPLACE FUNCTION mlm.fn_open_next_binary_period()
RETURNS bigint AS $$
DECLARE
  v_plan_id   bigint;
  v_start_utc timestamptz;
  v_end_utc   timestamptz;
  v_existing  bigint;
  v_id        bigint;
BEGIN
  -- 4.1 plan_config vigente
  SELECT id INTO v_plan_id
    FROM mlm.plan_config
   WHERE effective_from <= now()
     AND (effective_to IS NULL OR effective_to > now())
   ORDER BY effective_from DESC
   LIMIT 1;

  IF v_plan_id IS NULL THEN
    RAISE EXCEPTION 'no active plan_config — cannot open period';
  END IF;

  -- 4.2 Próximo lunes 00:00 America/Bogota (UTC-5, sin DST)
  -- Si hoy es lunes y son <02:00, el período arrancó hoy; si no, es el lunes que viene.
  v_start_utc := (
    date_trunc('week', now() AT TIME ZONE 'America/Bogota')
  ) AT TIME ZONE 'America/Bogota';
  v_end_utc   := v_start_utc + interval '7 days';

  -- 4.3 Idempotencia
  SELECT id INTO v_existing
    FROM mlm.binary_period
   WHERE period_start = v_start_utc AND period_end = v_end_utc;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  -- 4.4 Crear
  INSERT INTO mlm.binary_period (plan_config_id, period_start, period_end, status)
  VALUES (v_plan_id, v_start_utc, v_end_utc, 'open')
  RETURNING id INTO v_id;

  RETURN v_id;
END $$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION mlm.fn_open_next_binary_period() TO engine_write;

-- pg_cron (si está instalado en el host): registrar la apertura semanal.
-- Lunes 02:00 America/Bogota = 07:00 UTC.
--   SELECT cron.schedule('vp-open-binary-period', '0 7 * * 1',
--                        $$SELECT mlm.fn_open_next_binary_period();$$);
-- Si no usás pg_cron, gocron en vp-engine llama esta función al mismo tiempo
-- que dispara CloseBinaryPeriod sobre el período recién cerrado.

-- =============================================================================
-- 5. CARRY DECAY — caducidad explícita por nodo
-- =============================================================================
-- ADR 0012 §carry: el carry de cada nodo caduca β días después de su
-- carry_started_at. La caducidad es por fila: cada nodo tiene su propio
-- timestamp. Un único cutoff global es correcto solo si la query compara por
-- fila. Esta función la llamada CloseBinaryPeriod después de pagar.

CREATE OR REPLACE FUNCTION mlm.fn_expire_carry(p_period_id bigint)
RETURNS integer AS $$
DECLARE
  v_decay_days integer;
  v_expired    integer;
BEGIN
  SELECT pc.carry_decay_days INTO v_decay_days
    FROM mlm.binary_period bp
    JOIN mlm.plan_config   pc ON pc.id = bp.plan_config_id
   WHERE bp.id = p_period_id;

  IF v_decay_days IS NULL THEN
    RAISE EXCEPTION 'period_id=% not found or has no plan_config', p_period_id;
  END IF;

  WITH expired AS (
    UPDATE mlm.binary_node_state bns
       SET carry_left       = 0,
           carry_right      = 0,
           carry_started_at = NULL,
           updated_at       = now()
     WHERE bns.binary_period_id = p_period_id
       AND bns.carry_started_at IS NOT NULL
       AND bns.carry_started_at < now() - make_interval(days => v_decay_days)
     RETURNING 1
  )
  SELECT count(*) INTO v_expired FROM expired;

  RETURN v_expired;
END $$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION mlm.fn_expire_carry(bigint) TO engine_write;

-- =============================================================================
-- 6. SANITY — invariantes verificables a posteriori
-- =============================================================================
-- Llamada nightly por monitoreo. Devuelve OK si todas las invariantes pasan.

CREATE OR REPLACE FUNCTION mlm.fn_check_payout_invariants()
RETURNS TABLE(invariant text, status text, detail text) AS $$
  -- T1: ningún período cerrado supera α × inflows
  SELECT 'T1_no_overspend' AS invariant,
         CASE WHEN count(*) = 0 THEN 'OK' ELSE 'FAIL' END,
         'breaches=' || count(*)::text
    FROM mlm.v_period_solvency
   WHERE solvency_status = 'BREACH'
  UNION ALL
  -- T2: ningún paquete excede su cap
  SELECT 'T2_package_cap',
         CASE WHEN count(*) = 0 THEN 'OK' ELSE 'FAIL' END,
         'breaches=' || count(*)::text
    FROM mlm.package_cap_state
   WHERE paid_total > cap_total + 0.01
  UNION ALL
  -- T3: revisar última semana, ningún día excedió cap × rank.bonus
  SELECT 'T3_daily_cap',
         CASE WHEN count(*) = 0 THEN 'OK' ELSE 'FAIL' END,
         'breaches=' || count(*)::text
    FROM (
      SELECT bbp.affiliate_id,
             (bbp.posted_at AT TIME ZONE 'America/Bogota')::date AS d,
             SUM(bbp.net_amount) AS paid,
             pc.daily_cap_factor * COALESCE(r.bonus_amount_usd, 100) AS max_allowed
        FROM mlm.binary_block_payment bbp
        JOIN mlm.affiliate    a  ON a.id = bbp.affiliate_id
        LEFT JOIN mlm.rank    r  ON r.id = a.current_rank_id
        JOIN mlm.plan_config  pc ON pc.id = bbp.plan_config_id
       WHERE bbp.posted_at > now() - interval '7 days'
       GROUP BY bbp.affiliate_id, d, pc.daily_cap_factor, r.bonus_amount_usd
      HAVING SUM(bbp.net_amount) > pc.daily_cap_factor *
                                   COALESCE(r.bonus_amount_usd, 100) + 0.01
    ) breaches
  UNION ALL
  -- T4: si quedaron permisos UPDATE/DELETE en append-only, fallar
  SELECT 'T4_append_only',
         CASE WHEN count(*) = 0 THEN 'OK' ELSE 'FAIL' END,
         'grants=' || count(*)::text
    FROM information_schema.table_privileges
   WHERE table_schema = 'mlm'
     AND table_name   IN ('binary_block_payment', 'wallet_movement')
     AND privilege_type IN ('UPDATE', 'DELETE')
     AND grantee NOT IN ('postgres', 'PUBLIC');
$$ LANGUAGE sql STABLE;

GRANT EXECUTE ON FUNCTION mlm.fn_check_payout_invariants() TO app_read;

\echo 'schema_payouts v1.1 aplicado. Verificar:'
\echo '  SELECT * FROM mlm.fn_check_payout_invariants();'
\echo '  -- Las 4 invariantes deben estar en status=OK.'
