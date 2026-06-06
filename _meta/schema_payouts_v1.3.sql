-- =============================================================================
-- schema_payouts_v1.3.sql — Perfiles, CD de inversión, Plan de Jubilación,
-- Fundadores, Regalía gen-2 y Liquidación mensual (spec de negocio 2026-06-04)
--
--   §1  person.profile — registro KYC con dos perfiles: inversionista pasivo
--       y red. La compra de pack es lo que coloca en el árbol (ambos perfiles).
--   §2  CD de inversión — pack del perfil pasivo: principal + ROI diario
--       bloqueados 365 días. Tasa: 25% base anual; con 1 directo ACTIVO a
--       cada lado de tier ≥ al propio sube por tiers: 30/35/40/45/50%
--       según el pack (decisión 2026-06-04, re-verificado por período).
--   §3  Plan de Jubilación (híbrido 401k) — producto SEPARADO del CD:
--       modos moderado/acelerado/agresivo que redirigen bonos al plan,
--       permanencia hasta los 65 años, préstamos sobre la ganancia,
--       penalidad 10% por retiro anticipado.
--   §4  Fundadores — todo el que se registre y compre pack en v2.0:
--       10% referido (sobre compra del directo) + binario = 10% del matched.
--   §5  Regalía 5% — "si esos socios traen más usuarios, el 5% de cada pago":
--       5% de cada compra/recompra de pack de la 2ª generación de patrocinio.
--   §6  Liquidación — bonos devengan a diario, se compensan al cierre de mes
--       y quedan retirables 1 mes + 1 día después del cierre.
--   §7  Conceptos + plan_config nuevos.
--
-- Superávit de un período (α×inflows − pagado): queda en TESORERÍA (decisión
-- 2026-06-04). No se redistribuye a bonos. T3 por rango: no existe en la
-- versión nueva; el techo legacy "madura" en v2 (sin efecto en este schema).
--
-- Run order: ... schema_payouts_v1.2.sql → schema_ranks.sql → ESTE ARCHIVO
-- TimescaleDB: nada de aquí es hypertable (dimensión/estado). El devengo
-- diario de ROI y las contribuciones fluyen por mlm.wallet_movement
-- (hypertable) → compresión + mv_earnings_monthly los cubren.
-- =============================================================================

SET search_path = mlm, public;

-- ---------------------------------------------------------------------------
-- §0. Valores nuevos de enums (fuera de transacción)
-- ---------------------------------------------------------------------------
ALTER TYPE mlm.concept_kind ADD VALUE IF NOT EXISTS 'royalty';
ALTER TYPE mlm.concept_kind ADD VALUE IF NOT EXISTS 'retirement';

BEGIN;

-- ---------------------------------------------------------------------------
-- §1. Perfil de registro (candado: registro con KYC en dos formas)
-- ---------------------------------------------------------------------------
CREATE TYPE mlm.person_profile AS ENUM ('passive_investor', 'network');

ALTER TABLE mlm.person
  ADD COLUMN profile mlm.person_profile NOT NULL DEFAULT 'network';
-- Migrados 2.0 = 'network' (eran red). El registro nuevo elige perfil en KYC.
-- La colocación en el árbol ocurre al comprar pack, para ambos perfiles
-- (el pasivo genera volumen para su upline aunque no construya red).

-- ---------------------------------------------------------------------------
-- §2. CD de inversión (perfil pasivo) — lock 365 días
-- ---------------------------------------------------------------------------
-- Tiers de ROI por tamaño de pack (decisión 2026-06-04: ACTIVOS desde el
-- inicio — baja el pasivo de yield ~40% vs el flat 25→50 y acota el 50%
-- al tier de $50k). Banda: min_amount_usd ≤ principal < max_amount_usd.
-- Calificación al qualified_annual_rate: 1 directo activo A CADA LADO con
-- inversión del MISMO TIER O SUPERIOR (tier id ≥ el propio), re-verificado
-- mientras el CD/pack del directo siga activo (ver v_cd_qualification).
CREATE TABLE mlm.cd_roi_tier (
  id                     smallint PRIMARY KEY,   -- ordenados por monto: id mayor = tier mayor
  min_amount_usd         numeric(14,2) NOT NULL CHECK (min_amount_usd >= 0),
  max_amount_usd         numeric(14,2),            -- NULL = sin tope
  base_annual_rate       numeric(8,4)  NOT NULL CHECK (base_annual_rate >= 0),
  qualified_annual_rate  numeric(8,4)  NOT NULL CHECK (qualified_annual_rate >= base_annual_rate),
  active                 boolean       NOT NULL DEFAULT true,
  CHECK (max_amount_usd IS NULL OR max_amount_usd > min_amount_usd)
);

INSERT INTO mlm.cd_roi_tier (id, min_amount_usd, max_amount_usd, base_annual_rate, qualified_annual_rate, active) VALUES
  (1,     0,   501, 0.25, 0.30, true),   -- packs 100/250/500
  (2,   501,  2501, 0.25, 0.35, true),   -- 1000/2500
  (3,  2501, 10001, 0.25, 0.40, true),   -- 5000/10000
  (4, 10001, 25001, 0.25, 0.45, true),   -- 25000
  (5, 25001,  NULL, 0.25, 0.50, true)    -- 50000
ON CONFLICT (id) DO NOTHING;

CREATE TYPE mlm.cd_status AS ENUM ('active', 'matured', 'closed');

CREATE TABLE mlm.investment_cd (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  affiliate_id          bigint NOT NULL REFERENCES mlm.affiliate(id) ON DELETE RESTRICT,
  affiliate_package_id  bigint REFERENCES mlm.affiliate_package(id),  -- compra que lo originó
  principal_usd         numeric(14,2) NOT NULL CHECK (principal_usd > 0),
  roi_tier_id           smallint NOT NULL REFERENCES mlm.cd_roi_tier(id),
  start_at              timestamptz NOT NULL DEFAULT now(),
  matures_at            timestamptz NOT NULL,   -- start_at + cd_lock_days (365)
  status                mlm.cd_status NOT NULL DEFAULT 'active',

  -- Calificación: 2 directos con la MISMA inversión (mismo tier o superior).
  -- La marca el motor al detectar el segundo directo; desde ahí devenga la
  -- tasa calificada (no retroactivo).
  qualified_since       timestamptz,

  -- Read model del devengo (la verdad contable = wallet_movement concept roi).
  -- Lock: principal Y roi_accrued indisponibles hasta matures_at — el devengo
  -- se postea con available_at = matures_at::date.
  roi_accrued_usd       numeric(20,2) NOT NULL DEFAULT 0 CHECK (roi_accrued_usd >= 0),
  last_accrual_date     date,

  closed_at             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),

  CHECK (matures_at > start_at),
  CHECK (status <> 'closed' OR closed_at IS NOT NULL)
);

CREATE INDEX investment_cd_affiliate_idx ON mlm.investment_cd(affiliate_id, status);
CREATE INDEX investment_cd_accrual_idx   ON mlm.investment_cd(last_accrual_date)
  WHERE status = 'active';
CREATE INDEX investment_cd_package_idx   ON mlm.investment_cd(affiliate_package_id);

COMMENT ON TABLE mlm.investment_cd IS
  'CD del perfil pasivo: principal + ROI diario bloqueados 365 días (no mover, '
  'no retirar, no reinvertir). El ROI diario se postea como wallet_movement '
  'concept=1006 con available_at = matures_at. Tasa = cd_roi_tier según '
  'principal; qualified_annual_rate mientras califique (v_cd_qualification).';

-- Calificación del uplift, re-verificable cada período (decisión 2026-06-04:
-- el gate NO es de una sola vez — si los directos dejan de estar activos,
-- se vuelve a la tasa base). Directo calificante = patrocinado (sponsor_id)
-- colocado en el subtree, con CD ACTIVO de tier ≥ el del titular.
-- El motor consulta esta vista en cada devengo/cierre; qualified_since es
-- sólo el sello de la primera vez (no otorga derecho permanente).
CREATE VIEW mlm.v_cd_qualification AS
SELECT cd.id            AS investment_cd_id,
       cd.affiliate_id,
       cd.roi_tier_id,
       coalesce(d.l, 0) AS qualifying_directs_left,
       coalesce(d.r, 0) AS qualifying_directs_right,
       (coalesce(d.l, 0) >= 1 AND coalesce(d.r, 0) >= 1) AS qualifies_uplift
  FROM mlm.investment_cd cd
  JOIN mlm.affiliate own ON own.id = cd.affiliate_id
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE substring(ltree2text(subpath(rec.path, own.depth + 1, 1)) from 1 for 1) = 'L') AS l,
           count(*) FILTER (WHERE substring(ltree2text(subpath(rec.path, own.depth + 1, 1)) from 1 for 1) = 'R') AS r
      FROM mlm.affiliate rec
      JOIN mlm.investment_cd rcd
        ON rcd.affiliate_id = rec.id
       AND rcd.status = 'active'
       AND rcd.roi_tier_id >= cd.roi_tier_id     -- mismo tier O SUPERIOR
     WHERE rec.sponsor_id = own.id
       AND rec.path <@ own.path
       AND rec.id <> own.id
       AND rec.status = 'active'
  ) d ON true
 WHERE cd.status = 'active';

-- ---------------------------------------------------------------------------
-- §3. Plan de Jubilación (híbrido 401k) — producto separado del CD
-- ---------------------------------------------------------------------------
CREATE TYPE mlm.retirement_mode AS ENUM ('moderado', 'acelerado', 'agresivo');

CREATE TABLE mlm.retirement_plan (
  affiliate_id   bigint PRIMARY KEY REFERENCES mlm.affiliate(id) ON DELETE RESTRICT,
  mode           mlm.retirement_mode NOT NULL DEFAULT 'moderado',
  opened_at      timestamptz NOT NULL DEFAULT now(),
  -- Permanencia: retirable al cumplir 65 (person.birthday + 65y). NULL si no
  -- hay birthday — el retiro queda bloqueado hasta completar KYC con fecha.
  unlocks_at     date,
  -- Read model (verdad = wallet_movement kind='retirement')
  balance_usd    numeric(20,2) NOT NULL DEFAULT 0 CHECK (balance_usd >= 0),
  updated_at     timestamptz NOT NULL DEFAULT now()
) WITH (fillfactor = 90);

-- Ruteo de bonos al plan por modo. Config editable sin tocar código:
--   moderado  → sin filas = recibe todo en wallet (sólo cobra; su bono de
--               referido se habilita al activar 1 a cada lado — gate R2).
--   acelerado → DOS streams al plan, uno queda para gastos.
--   agresivo  → TODOS los bonos al plan.
CREATE TABLE mlm.retirement_mode_routing (
  mode          mlm.retirement_mode NOT NULL,
  concept_kind  mlm.concept_kind    NOT NULL,
  pct_to_plan   numeric(5,4)        NOT NULL CHECK (pct_to_plan BETWEEN 0 AND 1),
  PRIMARY KEY (mode, concept_kind)
);

INSERT INTO mlm.retirement_mode_routing (mode, concept_kind, pct_to_plan) VALUES
  -- acelerado: binario + puntos al plan; referido/regalía para gastos
  ('acelerado', 'binary_bonus', 1.0),
  ('acelerado', 'r3_points',    1.0),
  -- agresivo: todo al plan
  ('agresivo',  'binary_bonus', 1.0),
  ('agresivo',  'r3_points',    1.0),
  ('agresivo',  'direct_bonus', 1.0),
  ('agresivo',  'royalty',      1.0),
  ('agresivo',  'r2_yield',     1.0),
  ('agresivo',  'rank_bonus',   1.0)
ON CONFLICT DO NOTHING;

-- Préstamos sobre la ganancia acumulada del plan (permitidos pre-65).
-- Regla: saldo vivo de préstamos ≤ balance_usd (la valida el motor/app
-- al otorgar; ver v_retirement_status).
CREATE TABLE mlm.retirement_loan (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  affiliate_id  bigint NOT NULL REFERENCES mlm.retirement_plan(affiliate_id),
  amount_usd    numeric(14,2) NOT NULL CHECK (amount_usd > 0),
  granted_at    timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'repaid', 'written_off')),
  repaid_usd    numeric(14,2) NOT NULL DEFAULT 0 CHECK (repaid_usd >= 0),
  txn_id        uuid REFERENCES mlm.transaction(id),
  closed_at     timestamptz
);

CREATE INDEX retirement_loan_active_idx ON mlm.retirement_loan(affiliate_id)
  WHERE status = 'active';

CREATE VIEW mlm.v_retirement_status AS
SELECT rp.affiliate_id,
       rp.mode,
       rp.balance_usd,
       rp.unlocks_at,
       (rp.unlocks_at IS NOT NULL AND rp.unlocks_at <= CURRENT_DATE) AS is_unlocked,
       coalesce(l.outstanding, 0)                                    AS loans_outstanding_usd,
       rp.balance_usd - coalesce(l.outstanding, 0)                   AS loanable_usd
  FROM mlm.retirement_plan rp
  LEFT JOIN LATERAL (
    SELECT sum(amount_usd - repaid_usd) AS outstanding
      FROM mlm.retirement_loan
     WHERE affiliate_id = rp.affiliate_id AND status = 'active'
  ) l ON true;

COMMENT ON VIEW mlm.v_retirement_status IS
  'Retiro anticipado (antes de unlocks_at): penalidad = retirement_early_penalty '
  '(10%) sobre el monto retirado, posteada como concept 1009. Préstamos: '
  'loanable_usd es el máximo otorgable.';

-- ---------------------------------------------------------------------------
-- §4. Fundadores — cohorte de lanzamiento v2.0
-- ---------------------------------------------------------------------------
ALTER TABLE mlm.affiliate
  ADD COLUMN is_founder boolean NOT NULL DEFAULT false;
-- La app lo marca true en la PRIMERA compra de pack mientras
-- plan_config.founder_enrollment_open = true (ventana de lanzamiento v2).

CREATE INDEX affiliate_founder_idx ON mlm.affiliate(id) WHERE is_founder;

-- ---------------------------------------------------------------------------
-- §5+§6+§7. plan_config — regalía, fundadores, CD, jubilación, liquidación
-- ---------------------------------------------------------------------------
ALTER TABLE mlm.plan_config
  -- Regalía gen-2: 5% de cada compra/recompra de pack hecha por los
  -- reclutados de tus directos (línea de patrocinio, generación 2).
  ADD COLUMN royalty_enabled         boolean      NOT NULL DEFAULT false,
  ADD COLUMN royalty_rate            numeric(8,4) NOT NULL DEFAULT 0.05
    CHECK (royalty_rate >= 0),
  ADD COLUMN royalty_generation      integer      NOT NULL DEFAULT 2
    CHECK (royalty_generation >= 2),

  -- Bono referido directo (gen-1). Gate: 1 activo a cada lado (mismo gate R2).
  ADD COLUMN referral_rate           numeric(8,4) NOT NULL DEFAULT 0
    CHECK (referral_rate >= 0),

  -- Fundadores
  ADD COLUMN founder_enrollment_open      boolean      NOT NULL DEFAULT false,
  ADD COLUMN founder_referral_rate        numeric(8,4) NOT NULL DEFAULT 0.10
    CHECK (founder_referral_rate >= 0),
  -- Binario fundador: bono = 10% del volumen matched (reemplaza $/bloque)
  ADD COLUMN founder_binary_matched_rate  numeric(8,4) NOT NULL DEFAULT 0.10
    CHECK (founder_binary_matched_rate >= 0),

  -- CD
  ADD COLUMN cd_lock_days             integer NOT NULL DEFAULT 365
    CHECK (cd_lock_days > 0),
  ADD COLUMN cd_qualified_directs     integer NOT NULL DEFAULT 2
    CHECK (cd_qualified_directs >= 0),
  -- "misma inversión" = tier del directo ≥ tier del titular (decisión 2026-06-04)
  ADD COLUMN cd_same_tier_required    boolean NOT NULL DEFAULT true,
  -- Gate re-verificado por período: el uplift (R2 50% / tiers CD) exige
  -- directos ACTIVOS (CD vigente / recompra R1 fresca). Si dejan de estar
  -- activos, la tasa vuelve a la base. Aplica a R2 yield Y al uplift del CD.
  ADD COLUMN directs_active_required  boolean NOT NULL DEFAULT true,

  -- Jubilación
  ADD COLUMN retirement_age           integer NOT NULL DEFAULT 65
    CHECK (retirement_age > 0),
  ADD COLUMN retirement_early_penalty numeric(8,4) NOT NULL DEFAULT 0.10
    CHECK (retirement_early_penalty BETWEEN 0 AND 1),

  -- Liquidación: devengo diario, compensación al cierre de mes, retirable
  -- 1 mes + 1 día después del cierre.
  ADD COLUMN settlement_available_lag interval NOT NULL DEFAULT interval '1 month 1 day';

-- available_at de un bono devengado el día X:
--   último día del mes de X  +  settlement_available_lag (1 mes 1 día)
-- Ej: bono del 15-jun → cierre 30-jun → disponible 31-jul.
CREATE FUNCTION mlm.fn_bonus_available_at(p_posted timestamptz)
RETURNS date LANGUAGE sql STABLE AS $$
  SELECT (
    (date_trunc('month', p_posted AT TIME ZONE 'America/Bogota')
       + interval '1 month' - interval '1 day')::date   -- cierre del mes
    + (SELECT settlement_available_lag FROM mlm.plan_config
        WHERE effective_from <= now()
          AND (effective_to IS NULL OR effective_to > now())
        ORDER BY effective_from DESC LIMIT 1)
  )::date;
$$;

-- Compensación mensual: 1 fila por (mes, afiliado) al liquidar. Registra el
-- split entre lo que va al plan de jubilación (según modo) y lo retirable.
CREATE TABLE mlm.monthly_settlement (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settlement_month   date   NOT NULL,   -- primer día del mes liquidado
  affiliate_id       bigint NOT NULL REFERENCES mlm.affiliate(id),
  gross_accrued_usd  numeric(20,2) NOT NULL DEFAULT 0,
  to_retirement_usd  numeric(20,2) NOT NULL DEFAULT 0,
  net_available_usd  numeric(20,2) NOT NULL DEFAULT 0,
  available_at       date   NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (settlement_month, affiliate_id),
  CHECK (gross_accrued_usd = to_retirement_usd + net_available_usd)
);

CREATE INDEX monthly_settlement_aff_idx ON mlm.monthly_settlement(affiliate_id, settlement_month DESC);

-- ---------------------------------------------------------------------------
-- Conceptos nuevos (1005+). factor: +1 crédito al wallet, −1 débito.
-- ---------------------------------------------------------------------------
INSERT INTO mlm.concept (id, kind, name_es, name_en, factor, requires_pair, active) VALUES
  (1005, 'royalty',      'Regalía 5% (2ª generación)',        'Gen-2 royalty (5%)',            1, false, true),
  (1006, 'roi',          'ROI diario CD',                     'CD daily ROI',                  1, false, true),
  (1007, 'retirement',   'Aporte a plan de jubilación',       'Retirement contribution',      -1, false, true),
  (1008, 'retirement',   'Retiro de plan de jubilación',      'Retirement withdrawal',         1, false, true),
  (1009, 'retirement',   'Penalidad retiro anticipado (10%)', 'Early withdrawal penalty',     -1, false, true),
  (1010, 'retirement',   'Préstamo sobre plan',               'Retirement plan loan',          1, false, true),
  (1011, 'retirement',   'Pago de préstamo',                  'Loan repayment',               -1, false, true),
  (1012, 'direct_bonus', 'Bono referido directo',             'Direct referral bonus',         1, false, true)
ON CONFLICT (id) DO NOTHING;

COMMIT;

\echo '=== schema_payouts_v1.3.sql aplicado ==='
\echo 'CD tiers:'
SELECT id, min_amount_usd, max_amount_usd, base_annual_rate, qualified_annual_rate, active FROM mlm.cd_roi_tier;
