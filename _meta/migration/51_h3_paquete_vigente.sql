-- =============================================================================
-- 51_h3_paquete_vigente.sql — el trigger de period-cap resuelve el paquete
-- VIGENTE (más nuevo con cap abierto), igual que el motor Go (candidate.go).
-- =============================================================================
-- H3: comprar un paquete mayor tras agotar uno chico congelaba la capacidad,
-- porque tanto el Go como este trigger resolvían el affiliate_package MÁS VIEJO
-- (ORDER BY id LIMIT 1). El Go ya resuelve el más nuevo con cap abierto; si el
-- trigger no hace lo mismo, valida el pago contra el period-cap del paquete
-- viejo (agotado → cap 0) y aborta el cierre con 'Daily cap breach'.
--
-- Cambio ÚNICO respecto de schema_payouts_v1.2.sql: el SELECT INTO v_pkg.
-- El resto de la función es idéntico (copiado verbatim para no divergir).
-- Idempotente (CREATE OR REPLACE).
-- =============================================================================

CREATE OR REPLACE FUNCTION mlm.fn_enforce_daily_cap() RETURNS trigger AS $$
DECLARE
  v_paid_today numeric(14,2);
  v_max_today  numeric(14,2);
  v_pcf        numeric(8,4);
  v_factor     numeric(8,4);
  v_pkg        numeric(14,2);
  v_rank_bonus numeric(14,2);
BEGIN
  SELECT bns.paid_today_amount INTO v_paid_today
    FROM mlm.binary_node_state bns
   WHERE bns.affiliate_id = NEW.affiliate_id
     AND bns.binary_period_id = NEW.binary_period_id;

  SELECT pc.period_cap_factor, pc.daily_cap_factor
    INTO v_pcf, v_factor
    FROM mlm.plan_config pc WHERE pc.id = NEW.plan_config_id;

  IF COALESCE(v_pcf, 0) > 0 THEN
    -- ADR-0014 + H3: T3 = period_cap_factor × paquete VIGENTE del afiliado
    -- (el más nuevo con cap abierto), consistente con candidate.go.
    SELECT p.amount_usd INTO v_pkg
      FROM mlm.affiliate_package ap
      JOIN mlm.package p ON p.id = ap.package_id
      JOIN mlm.package_cap_state cs ON cs.affiliate_package_id = ap.id
     WHERE ap.affiliate_id = NEW.affiliate_id
       AND ap.status = 'active'
       AND cs.closed_at IS NULL
     ORDER BY ap.id DESC LIMIT 1;
    v_max_today := v_pcf * COALESCE(v_pkg, 0);
  ELSE
    -- Legacy: daily_cap_factor × rank.bonus (fallback $100 sin rango).
    SELECT r.bonus_amount_usd INTO v_rank_bonus
      FROM mlm.affiliate a JOIN mlm.rank r ON r.id = a.current_rank_id
     WHERE a.id = NEW.affiliate_id;
    v_max_today := v_factor * COALESCE(v_rank_bonus, 100);
  END IF;

  IF COALESCE(v_paid_today, 0) + NEW.net_amount > v_max_today + 0.01 THEN
    RAISE EXCEPTION 'Daily cap breach: affiliate=% paid_today=%.2f new=%.2f max=%.2f',
      NEW.affiliate_id, v_paid_today, NEW.net_amount, v_max_today;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
