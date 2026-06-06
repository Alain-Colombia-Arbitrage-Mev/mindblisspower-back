-- Smoke test funcional: carrera de rangos + candados v1.2
\set ON_ERROR_STOP 1
SET search_path = mlm, public;

BEGIN;

-- Personas + afiliados de prueba (root + hijo L + hijo R)
INSERT INTO mlm.person (first_name, last_name, email, phone_number, status, is_admin)
VALUES ('Root', 'Test', 'root@test.com', '300000', 'active', true),
       ('Hijo', 'Izq',  'left@test.com', '300001', 'active', false),
       ('Hijo', 'Der',  'right@test.com', '300002', 'active', false);

INSERT INTO mlm.affiliate (person_id, parent_id, position, sponsor_id, path, depth, status)
SELECT id, NULL, NULL, NULL, text2ltree(id::text), 0, 'active'
  FROM mlm.person WHERE email = 'root@test.com';

INSERT INTO mlm.affiliate (person_id, parent_id, position, sponsor_id, path, depth, status)
SELECT p.id, r.id, 'L', r.id, r.path || text2ltree('L_' || p.id::text), 1, 'active'
  FROM mlm.person p, mlm.affiliate r
 WHERE p.email = 'left@test.com' AND r.depth = 0;

INSERT INTO mlm.affiliate (person_id, parent_id, position, sponsor_id, path, depth, status)
SELECT p.id, r.id, 'R', r.id, r.path || text2ltree('R_' || p.id::text), 1, 'active'
  FROM mlm.person p, mlm.affiliate r
 WHERE p.email = 'right@test.com' AND r.depth = 0;

-- Estado payout 1:1
INSERT INTO mlm.affiliate_payout_state (affiliate_id)
SELECT id FROM mlm.affiliate;

-- Root: 3000 puntos por pierna + baseline 0 → debe calificar Bronce(1000) y Plata(2500)
UPDATE mlm.affiliate SET left_pv_lifetime = 3000, right_pv_lifetime = 3000 WHERE depth = 0;

\echo '--- fn_pending_rank_achievements: esperado Bronce + Plata para root ---'
SELECT affiliate_id, rank_id, bonus_amount_usd FROM mlm.fn_pending_rank_achievements();

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM mlm.fn_pending_rank_achievements();
  IF n <> 2 THEN RAISE EXCEPTION 'esperaba 2 pendientes (Bronce, Plata), hubo %', n; END IF;
END $$;

-- Baseline (migrado con Oro heredado): baseline 5000 + 3000 nuevos = 8000 → no Platino(10000), sí hasta Oro
UPDATE mlm.affiliate SET rank_points_baseline = 5000 WHERE depth = 0;
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM mlm.fn_pending_rank_achievements()
   WHERE rank_id <= 3;  -- Bronce, Plata, Oro
  IF n <> 3 THEN RAISE EXCEPTION 'con baseline 5000 esperaba 3 (hasta Oro), hubo %', n; END IF;
  SELECT count(*) INTO n FROM mlm.fn_pending_rank_achievements() WHERE rank_id = 4;
  IF n <> 0 THEN RAISE EXCEPTION 'Platino no debía calificar (8000 < 10000)'; END IF;
END $$;

-- Insertar achievement → trigger debe sincronizar current_rank_id
INSERT INTO mlm.affiliate_rank_achieved (affiliate_id, rank_id, source, bonus_amount_usd, net_amount_usd)
SELECT id, 1, 'earned', 100, 45 FROM mlm.affiliate WHERE depth = 0;
INSERT INTO mlm.affiliate_rank_achieved (affiliate_id, rank_id, source, bonus_amount_usd, net_amount_usd)
SELECT id, 2, 'earned', 200, 90 FROM mlm.affiliate WHERE depth = 0;

DO $$
DECLARE v smallint;
BEGIN
  SELECT current_rank_id INTO v FROM mlm.affiliate WHERE depth = 0;
  IF v <> 2 THEN RAISE EXCEPTION 'current_rank_id debía ser 2 (Plata), es %', v; END IF;
END $$;

-- Append-only: UPDATE debe fallar
DO $$
BEGIN
  BEGIN
    UPDATE mlm.affiliate_rank_achieved SET bonus_amount_usd = 999 WHERE rank_id = 1;
    RAISE EXCEPTION 'UPDATE no fue bloqueado por trg_rank_achieved_immutable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE '%append-only%' THEN NULL;  -- esperado
    ELSE RAISE; END IF;
  END;
END $$;

-- Constraint legacy sin bono debe rechazar bono > 0
DO $$
BEGIN
  BEGIN
    INSERT INTO mlm.affiliate_rank_achieved (affiliate_id, rank_id, source, bonus_amount_usd, net_amount_usd)
    SELECT id, 3, 'legacy', 500, 0 FROM mlm.affiliate WHERE depth = 0;
    RAISE EXCEPTION 'CHECK ara_legacy_no_bonus no disparó';
  EXCEPTION WHEN check_violation THEN NULL;  -- esperado
  END;
END $$;

\echo '--- v_rank_progress (root: qualifying 8000, next Platino) ---'
SELECT affiliate_id, current_rank_code, points_qualifying, next_rank_code, pct_to_next_rank
  FROM mlm.v_rank_progress WHERE current_rank_id IS NOT NULL;

ROLLBACK;

\echo '=== SMOKE TEST OK (rollback) ==='
