-- Smoke test: perfiles, CD, plan de jubilación, fundadores, liquidación (v1.3)
\set ON_ERROR_STOP 1
SET search_path = mlm, public;

BEGIN;

INSERT INTO mlm.person (first_name, last_name, email, phone_number, status, profile, birthday)
VALUES ('Pasivo', 'CD',  'cd@test.com',  '300010', 'active', 'passive_investor', '1980-06-15'),
       ('Red',    '401', 'red@test.com', '300011', 'active', 'network',          '1990-01-20');

INSERT INTO mlm.affiliate (person_id, parent_id, position, sponsor_id, path, depth, status, is_founder)
SELECT id, NULL, NULL, NULL, text2ltree(id::text), 0, 'active', true
  FROM mlm.person WHERE email = 'cd@test.com';

INSERT INTO mlm.affiliate (person_id, parent_id, position, sponsor_id, path, depth, status)
SELECT p.id, a.id, 'L', a.id, a.path || text2ltree('L_' || p.id::text), 1, 'active'
  FROM mlm.person p, mlm.affiliate a
 WHERE p.email = 'red@test.com' AND a.depth = 0;

-- CD: principal 5000 → tier 3 (2501-10001, 25%→40%), madura en 365 días
INSERT INTO mlm.investment_cd (affiliate_id, principal_usd, roi_tier_id, matures_at)
SELECT id, 5000, 3, now() + interval '365 days'
  FROM mlm.affiliate WHERE depth = 0;

DO $$
DECLARE r record;
BEGIN
  SELECT base_annual_rate, qualified_annual_rate INTO r FROM mlm.cd_roi_tier WHERE id = 3;
  IF r.base_annual_rate <> 0.25 OR r.qualified_annual_rate <> 0.40 THEN
    RAISE EXCEPTION 'tier 3 debía ser 25%%/40%%';
  END IF;
  IF (SELECT count(*) FROM mlm.cd_roi_tier WHERE active) <> 5 THEN
    RAISE EXCEPTION 'esperaba 5 tiers activos';
  END IF;
END $$;

-- Calificación del uplift: 1 directo activo a cada lado con tier >= 3.
-- Hijo L con CD tier 1 (insuficiente) → NO califica.
INSERT INTO mlm.investment_cd (affiliate_id, principal_usd, roi_tier_id, matures_at)
SELECT a.id, 500, 1, now() + interval '365 days'
  FROM mlm.affiliate a WHERE a.position = 'L';

DO $$
DECLARE q record;
BEGIN
  SELECT * INTO q FROM mlm.v_cd_qualification q2
   JOIN mlm.investment_cd cd ON cd.id = q2.investment_cd_id AND cd.roi_tier_id = 3
   JOIN mlm.affiliate root ON root.id = cd.affiliate_id AND root.depth = 0;
  IF q.qualifies_uplift THEN
    RAISE EXCEPTION 'no debía calificar (directo L tier 1 < 3, sin directo R)';
  END IF;
END $$;

-- Hijo R nuevo con CD tier 4 (superior) + upgrade del L a tier 3 → califica.
INSERT INTO mlm.person (first_name, last_name, email, phone_number, status, profile)
VALUES ('Hijo', 'Der', 'right2@test.com', '300012', 'active', 'passive_investor');

INSERT INTO mlm.affiliate (person_id, parent_id, position, sponsor_id, path, depth, status)
SELECT p.id, a.id, 'R', a.id, a.path || text2ltree('R_' || p.id::text), 1, 'active'
  FROM mlm.person p, mlm.affiliate a
 WHERE p.email = 'right2@test.com' AND a.depth = 0;

INSERT INTO mlm.investment_cd (affiliate_id, principal_usd, roi_tier_id, matures_at)
SELECT a.id, 25000, 4, now() + interval '365 days'
  FROM mlm.affiliate a WHERE a.position = 'R';

UPDATE mlm.investment_cd SET roi_tier_id = 3, principal_usd = 5000
 WHERE affiliate_id = (SELECT id FROM mlm.affiliate WHERE position = 'L');

DO $$
DECLARE q record;
BEGIN
  SELECT q2.* INTO q FROM mlm.v_cd_qualification q2
   JOIN mlm.investment_cd cd ON cd.id = q2.investment_cd_id AND cd.roi_tier_id = 3
   JOIN mlm.affiliate root ON root.id = cd.affiliate_id AND root.depth = 0;
  IF NOT q.qualifies_uplift THEN
    RAISE EXCEPTION 'debía calificar (L tier 3 = propio, R tier 4 > propio), L=% R=%',
      q.qualifying_directs_left, q.qualifying_directs_right;
  END IF;
END $$;

-- Gate re-verificable: el directo R cierra su CD → pierde calificación
UPDATE mlm.investment_cd SET status = 'closed', closed_at = now()
 WHERE affiliate_id = (SELECT id FROM mlm.affiliate WHERE position = 'R');

DO $$
DECLARE q record;
BEGIN
  SELECT q2.* INTO q FROM mlm.v_cd_qualification q2
   JOIN mlm.investment_cd cd ON cd.id = q2.investment_cd_id AND cd.roi_tier_id = 3
   JOIN mlm.affiliate root ON root.id = cd.affiliate_id AND root.depth = 0;
  IF q.qualifies_uplift THEN
    RAISE EXCEPTION 'no debía seguir calificando tras cerrar el CD del directo R';
  END IF;
END $$;

-- Plan de jubilación agresivo, unlocks a los 65
INSERT INTO mlm.retirement_plan (affiliate_id, mode, unlocks_at)
SELECT a.id, 'agresivo', (p.birthday + interval '65 years')::date
  FROM mlm.affiliate a JOIN mlm.person p ON p.id = a.person_id
 WHERE p.email = 'red@test.com';

UPDATE mlm.retirement_plan SET balance_usd = 1000;

-- Préstamo de 400 → loanable restante 600
INSERT INTO mlm.retirement_loan (affiliate_id, amount_usd)
SELECT affiliate_id, 400 FROM mlm.retirement_plan;

DO $$
DECLARE v record;
BEGIN
  SELECT * INTO v FROM mlm.v_retirement_status;
  IF v.loans_outstanding_usd <> 400 OR v.loanable_usd <> 600 THEN
    RAISE EXCEPTION 'v_retirement_status: esperaba 400/600, dio %/%', v.loans_outstanding_usd, v.loanable_usd;
  END IF;
  IF v.is_unlocked THEN
    RAISE EXCEPTION 'plan no debía estar unlocked (1990+65=2055)';
  END IF;
END $$;

-- Routing agresivo: todos los streams al plan
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM mlm.retirement_mode_routing WHERE mode = 'agresivo' AND pct_to_plan = 1;
  IF n < 6 THEN RAISE EXCEPTION 'agresivo debía rutear ≥6 streams, tiene %', n; END IF;
  SELECT count(*) INTO n FROM mlm.retirement_mode_routing WHERE mode = 'moderado';
  IF n <> 0 THEN RAISE EXCEPTION 'moderado no debía tener filas'; END IF;
END $$;

\echo '--- fn_bonus_available_at: bono 2026-06-15 -> cierre 30-jun + 1m1d = 2026-07-31 ---'
SELECT mlm.fn_bonus_available_at('2026-06-15 10:00-05'::timestamptz) AS available_at;

DO $$
BEGIN
  IF mlm.fn_bonus_available_at('2026-06-15 10:00-05'::timestamptz) <> '2026-07-31'::date THEN
    RAISE EXCEPTION 'available_at esperado 2026-07-31, dio %',
      mlm.fn_bonus_available_at('2026-06-15 10:00-05'::timestamptz);
  END IF;
END $$;

-- monthly_settlement: CHECK gross = retirement + available
DO $$
BEGIN
  BEGIN
    INSERT INTO mlm.monthly_settlement (settlement_month, affiliate_id, gross_accrued_usd, to_retirement_usd, net_available_usd, available_at)
    SELECT '2026-06-01', id, 100, 30, 60, '2026-07-31' FROM mlm.affiliate WHERE depth = 0;
    RAISE EXCEPTION 'CHECK de monthly_settlement no disparó (100 <> 30+60)';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

INSERT INTO mlm.monthly_settlement (settlement_month, affiliate_id, gross_accrued_usd, to_retirement_usd, net_available_usd, available_at)
SELECT '2026-06-01', id, 100, 40, 60, '2026-07-31' FROM mlm.affiliate WHERE depth = 0;

\echo '--- fundador + perfil ---'
SELECT p.profile, a.is_founder FROM mlm.affiliate a JOIN mlm.person p ON p.id = a.person_id ORDER BY a.depth;

ROLLBACK;

\echo '=== SMOKE v1.3 OK (rollback) ==='
