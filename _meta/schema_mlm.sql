-- =============================================================================
-- VicionPower v2 — Postgres 17 schema
-- Target: Hetzner AX52, Postgres 17, extensions ltree + pg_partman + pgcrypto
-- Design goals:
--   1. Fix root causes from credito_audit.sql findings:
--      - idVicionario NULL on 186,729 movements → enforce NOT NULL
--      - dateMovement corrupted (2-digit/5024 dates) → CHECK constraint
--      - $348M concepto 16 with no paired debit → double-entry by transaction_id
--      - reversiones manuales mezcladas → entry_type explicit
--   2. Binary tree maintenance under heavy concurrent input:
--      - ltree path + denormalized aggregates updated incrementally
--      - tree_event append-only ledger, idempotent by external_ref
--   3. Auditability for fintech: every money mutation is replayable from
--      tree_event + wallet_movement; affiliate_snapshot is the closed read model.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;   -- mlm.person.email
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
-- timescaledb se carga vía shared_preload_libraries, su CREATE EXTENSION
-- vive en _meta/migration/05_timescaledb.sql (conversión a hypertables)

CREATE SCHEMA IF NOT EXISTS auth;     -- Better Auth owns this
CREATE SCHEMA IF NOT EXISTS mlm;      -- network + ledger
CREATE SCHEMA IF NOT EXISTS audit;    -- append-only logs

SET search_path = mlm, public;

-- =============================================================================
-- 1. CATALOGS (immutable reference data)
-- =============================================================================

CREATE TABLE mlm.country (
  id              smallint PRIMARY KEY,
  iso2            char(2)   NOT NULL UNIQUE,
  name_es         text      NOT NULL,
  name_en         text      NOT NULL,
  phone_code      text,
  phone_regex     text
);

CREATE TABLE mlm.asset (
  id              smallint PRIMARY KEY,
  symbol          text      NOT NULL UNIQUE,    -- 'USD', 'USDT', 'BTC'
  name            text      NOT NULL,
  is_fiat         boolean   NOT NULL,
  decimals        smallint  NOT NULL CHECK (decimals BETWEEN 0 AND 18),
  current_value_usd numeric(20,8),
  updated_at      timestamptz
);

-- Concept replaces the old [concept] table. factor stays for backwards compat
-- but kind is the new authoritative discriminator.
CREATE TYPE mlm.concept_kind AS ENUM (
  'roi',                -- automatic ROI distribution
  'binary_bonus',       -- pair-matching commission
  'leadership_bonus',   -- rank-based bonus
  'direct_bonus',       -- sponsor bonus
  'package_purchase',   -- debit when buying package
  'withdrawal',         -- outflow to bank/crypto
  'platform_fee',       -- house take
  'inter_platform',     -- VG <-> VP bridge (old concepto 16)
  'manual_adjustment',  -- ops correction with audit trail
  'reversal'            -- chargeback / mistake correction
);

CREATE TABLE mlm.concept (
  id              integer PRIMARY KEY,
  kind            mlm.concept_kind NOT NULL,
  name_es         text      NOT NULL,
  name_en         text      NOT NULL,
  factor          smallint  NOT NULL CHECK (factor IN (-1, 1)),  -- +credit / -debit
  requires_pair   boolean   NOT NULL DEFAULT false,
  -- requires_pair = true → wallet_movement MUST be part of a balanced
  -- transaction (sum of imports = 0). Set TRUE on inter_platform, withdrawal,
  -- package_purchase, reversal. Enforced by trigger below.
  active          boolean   NOT NULL DEFAULT true
);

CREATE TABLE mlm.rank (
  id                  smallint PRIMARY KEY,
  code                text     NOT NULL UNIQUE,
  name_es             text     NOT NULL,
  name_en             text     NOT NULL,
  required_points     integer  NOT NULL,
  accumulated_points  integer,
  bonus_amount_usd    numeric(14,2) NOT NULL DEFAULT 0,
  previous_rank_id    smallint REFERENCES mlm.rank(id),
  display_order       smallint NOT NULL
);

CREATE TABLE mlm.package (
  id              integer PRIMARY KEY,
  name            text     NOT NULL,
  amount_usd      numeric(14,2) NOT NULL CHECK (amount_usd > 0),
  pv             integer  NOT NULL CHECK (pv >= 0),  -- binary points value
  type            text     NOT NULL,                  -- enrollment | upgrade | renewal
  is_active       boolean  NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- 2. AUTH BRIDGE — links Better Auth users to business identity
-- =============================================================================
-- Better Auth creates auth.user, auth.session, auth.account, auth.verification.
-- We do NOT define those here (the Better Auth migrator owns them).
-- Just declare the FK target shape we depend on:

CREATE TABLE IF NOT EXISTS auth.user (
  id          text PRIMARY KEY,                 -- Better Auth uses text (cuid/uuid)
  email       text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  name        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- 3. PERSON / AFFILIATE — identity vs network position
-- =============================================================================
-- person = legal/KYC identity (1:1 with auth.user for end users; admins can
-- exist in auth.user without a person row).
-- affiliate = position in the binary tree (1:1 with person for downline users).
-- Splitting these lets staff/admins authenticate without polluting the tree.

CREATE TYPE mlm.person_status AS ENUM ('pending', 'active', 'suspended', 'banned', 'deleted');
CREATE TYPE mlm.kyc_status    AS ENUM ('not_started', 'in_review', 'approved', 'rejected', 'expired');
CREATE TYPE mlm.tree_position AS ENUM ('L', 'R');

CREATE TABLE mlm.person (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id             text   UNIQUE REFERENCES auth.user(id) ON DELETE RESTRICT,
  -- user_id NULL allowed for legacy migrated users without auth account yet
  legacy_id_person    integer UNIQUE,            -- old viciongroup.person.idPerson
  first_name          text   NOT NULL,
  last_name           text   NOT NULL,
  alias               text,
  email               citext NOT NULL UNIQUE,
  phone_country_id    smallint REFERENCES mlm.country(id),
  phone_number        text   NOT NULL,
  birthday            date,
  birth_country_id    smallint REFERENCES mlm.country(id),
  ssn_encrypted       bytea,                     -- pgcrypto pgp_sym_encrypt
  status              mlm.person_status NOT NULL DEFAULT 'pending',
  kyc_status          mlm.kyc_status    NOT NULL DEFAULT 'not_started',
  kyc_approved_at     timestamptz,
  is_admin            boolean NOT NULL DEFAULT false,
  blacklisted         boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (birthday IS NULL OR birthday BETWEEN '1900-01-01' AND CURRENT_DATE)
);
CREATE INDEX person_status_idx ON mlm.person(status) WHERE status <> 'deleted';

CREATE TABLE mlm.affiliate (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  legacy_id_vicionario integer UNIQUE,           -- old viciongroup.vicionario.idVicionario
  person_id           bigint NOT NULL UNIQUE REFERENCES mlm.person(id) ON DELETE RESTRICT,
  invitation_link     text   UNIQUE,

  -- Binary tree position
  parent_id           bigint REFERENCES mlm.affiliate(id) ON DELETE RESTRICT,
  position            mlm.tree_position,         -- L|R relative to parent; NULL only for root
  sponsor_id          bigint REFERENCES mlm.affiliate(id) ON DELETE RESTRICT,
  -- parent_id = upline placement (binary), sponsor_id = who recruited.
  -- They differ when sponsor places the recruit deep in the leg.

  path                ltree NOT NULL,            -- e.g. '1.7.42.L_19' (root.path)
  depth               integer NOT NULL CHECK (depth >= 0),

  -- Denormalized aggregates (updated by trigger on tree_event insert).
  -- These are the read model — never queried by recursive CTE.
  left_count          bigint NOT NULL DEFAULT 0,
  right_count         bigint NOT NULL DEFAULT 0,
  left_pv_lifetime    numeric(20,2) NOT NULL DEFAULT 0,
  right_pv_lifetime   numeric(20,2) NOT NULL DEFAULT 0,
  left_pv_current     numeric(20,2) NOT NULL DEFAULT 0,  -- current open cycle
  right_pv_current    numeric(20,2) NOT NULL DEFAULT 0,
  left_carry          numeric(20,2) NOT NULL DEFAULT 0,  -- weak-leg carry forward
  right_carry         numeric(20,2) NOT NULL DEFAULT 0,
  current_rank_id     smallint REFERENCES mlm.rank(id),

  status              mlm.person_status NOT NULL DEFAULT 'pending',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT affiliate_parent_position_required
    CHECK ((parent_id IS NULL AND position IS NULL) OR (parent_id IS NOT NULL AND position IS NOT NULL)),
  CONSTRAINT affiliate_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id)
);

-- One child per (parent, position) — enforces binary structure
CREATE UNIQUE INDEX affiliate_parent_position_unique
  ON mlm.affiliate(parent_id, position)
  WHERE parent_id IS NOT NULL;

-- NOTA GiST: en PRODUCCIÓN este índice se dropea a propósito
-- (_meta/migration/02_postload.sql) porque el árbol legacy llega a depth ~369
-- (path ~4KB) y supera el límite de página GiST de ltree. Las consultas de
-- ancestro/descendiente se sirven vía mlm.affiliate_closure (tabla de closure,
-- definida más abajo) — NO vía `path @>` / `path <@` sobre este índice. Se deja
-- el CREATE aquí para DBs frescas sin paths profundos (dev/test), pero el código
-- no depende de él.
CREATE INDEX affiliate_path_gist     ON mlm.affiliate USING gist(path);
CREATE INDEX affiliate_path_btree    ON mlm.affiliate USING btree(path);
CREATE INDEX affiliate_sponsor_idx   ON mlm.affiliate(sponsor_id);
CREATE INDEX affiliate_parent_idx    ON mlm.affiliate(parent_id);
CREATE INDEX affiliate_status_idx    ON mlm.affiliate(status) WHERE status = 'active';

-- Transitive-closure de la jerarquía binaria. Reemplaza los operadores ltree
-- `path @>` / `path <@` (que sin el índice GiST hacen SEQ SCAN) por joins
-- index-backed. Incluye la self-row (distance 0) de cada nodo. Se mantiene
-- incremental vía trg_maintain_affiliate_closure (AFTER INSERT). Ver
-- _meta/migration/39_affiliate_closure.sql.
CREATE TABLE mlm.affiliate_closure (
  ancestor_id   bigint NOT NULL REFERENCES mlm.affiliate(id),
  descendant_id bigint NOT NULL REFERENCES mlm.affiliate(id),
  distance      int    NOT NULL,
  PRIMARY KEY (ancestor_id, descendant_id)
);
-- descendiente -> ancestros; la dirección inversa se apoya en la PK.
CREATE INDEX affiliate_closure_desc_idx ON mlm.affiliate_closure (descendant_id, distance);

-- =============================================================================
-- 4. WALLETS & DOUBLE-ENTRY LEDGER
-- =============================================================================

CREATE TABLE mlm.wallet (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  legacy_id_wallet integer UNIQUE,
  affiliate_id    bigint NOT NULL REFERENCES mlm.affiliate(id) ON DELETE RESTRICT,
  asset_id        smallint NOT NULL REFERENCES mlm.asset(id),
  address         text   NOT NULL,
  -- Materialized balance, kept in sync by trigger on wallet_movement.
  -- Never trust this for audits — recompute from movements.
  balance         numeric(20,8) NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (affiliate_id, asset_id)
);

-- A "transaction" groups movements that must net to zero (for paired concepts)
-- or a single-side flow (ROI inflow has only credit, fee is single debit).
CREATE TYPE mlm.txn_status AS ENUM ('pending', 'posted', 'reversed');

CREATE TABLE mlm.transaction (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref    text UNIQUE,                   -- idempotency key from caller
  -- external_ref pattern: '<source>:<id>' e.g. 'roi_run:2026-04-26:42',
  -- 'package_purchase:vp_pkg_8123', 'withdrawal:wr_991'.
  -- UNIQUE prevents duplicate processing on retry (was missing in v1).
  description     text NOT NULL,
  status          mlm.txn_status NOT NULL DEFAULT 'pending',
  initiated_by_person_id bigint REFERENCES mlm.person(id),
  posted_at       timestamptz,
  reversed_by_txn_id uuid REFERENCES mlm.transaction(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- wallet_movement: this table is converted to a TimescaleDB hypertable
-- by _meta/migration/05_timescaledb.sql. TimescaleDB handles partitioning
-- (chunks), compression of cold chunks, and retention policies.
-- DO NOT add PARTITION BY RANGE here — incompatible with hypertables.
CREATE TABLE mlm.wallet_movement (
  id              bigint GENERATED ALWAYS AS IDENTITY,
  legacy_id_movement integer,
  transaction_id  uuid NOT NULL REFERENCES mlm.transaction(id) ON DELETE RESTRICT,
  wallet_id       bigint NOT NULL REFERENCES mlm.wallet(id),
  affiliate_id    bigint NOT NULL REFERENCES mlm.affiliate(id),  -- denorm of wallet.affiliate_id, NOT NULL fixes legacy gap
  concept_id      integer NOT NULL REFERENCES mlm.concept(id),
  vicionario_package_id bigint,                  -- FK added below to avoid forward ref
  vicionario_package_origin_id bigint,
  rank_id         smallint REFERENCES mlm.rank(id),
  amount          numeric(20,8) NOT NULL,
  -- amount is signed. concept.factor must match sign(amount):
  --   credit (factor=+1)  → amount > 0
  --   debit  (factor=-1)  → amount < 0
  reference       text,
  posted_at       timestamptz NOT NULL,
  available_at    date,                          -- when funds become withdrawable
  is_frozen       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- Composite PK includes posted_at because hypertable partition key must be in PK.
  PRIMARY KEY (id, posted_at),
  CONSTRAINT wallet_movement_date_sane
    CHECK (posted_at BETWEEN '2015-01-01' AND now() + interval '7 days')
);

CREATE INDEX wallet_movement_wallet_idx       ON mlm.wallet_movement(wallet_id, posted_at DESC);
CREATE INDEX wallet_movement_affiliate_idx    ON mlm.wallet_movement(affiliate_id, posted_at DESC);
CREATE INDEX wallet_movement_concept_idx      ON mlm.wallet_movement(concept_id, posted_at DESC);
CREATE INDEX wallet_movement_txn_idx          ON mlm.wallet_movement(transaction_id);

-- =============================================================================
-- 5. PACKAGE PURCHASES
-- =============================================================================

CREATE TYPE mlm.package_status AS ENUM ('pending_payment', 'active', 'expired', 'refunded', 'cancelled');

CREATE TABLE mlm.affiliate_package (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  legacy_id_vp        integer UNIQUE,
  affiliate_id        bigint  NOT NULL REFERENCES mlm.affiliate(id),
  package_id          integer NOT NULL REFERENCES mlm.package(id),
  status              mlm.package_status NOT NULL DEFAULT 'pending_payment',
  purchase_txn_id     uuid REFERENCES mlm.transaction(id),
  payment_method      text,
  payment_proof_url   text,
  transaction_hash    text,
  current_period_date date,
  periodicity_id      smallint,
  pv_remaining        integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  activated_at        timestamptz,
  expired_at          timestamptz
);
CREATE INDEX affiliate_package_aff_idx ON mlm.affiliate_package(affiliate_id, status);

ALTER TABLE mlm.wallet_movement
  ADD CONSTRAINT wm_vpkg_fk FOREIGN KEY (vicionario_package_id) REFERENCES mlm.affiliate_package(id),
  ADD CONSTRAINT wm_vpkg_origin_fk FOREIGN KEY (vicionario_package_origin_id) REFERENCES mlm.affiliate_package(id);

-- =============================================================================
-- 6. TREE EVENT LOG — append-only, source of truth for tree mutations
-- =============================================================================
-- Every event that affects tree aggregates (PV inflow, package activation,
-- bonus payout, position change) is recorded here. Triggers fan out from
-- here to update affiliate aggregates incrementally (~30 ancestors max).
-- Reconciliation job replays this to validate the materialized view.

CREATE TYPE mlm.tree_event_kind AS ENUM (
  'enrollment',         -- new affiliate joined tree
  'pv_credit',          -- PV added to a leg from package purchase / renewal
  'binary_payout',      -- weak-leg paid out, current_pv reduced
  'rank_advance',
  'position_move',      -- ops corrected a placement
  'pv_reversal'         -- chargeback / refund undoing earlier pv_credit
);

CREATE TABLE mlm.tree_event (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  external_ref    text UNIQUE NOT NULL,          -- idempotency key
  kind            mlm.tree_event_kind NOT NULL,
  affiliate_id    bigint NOT NULL REFERENCES mlm.affiliate(id),
  pv_delta_left   numeric(20,2) NOT NULL DEFAULT 0,   -- applied to ancestors on left side
  pv_delta_right  numeric(20,2) NOT NULL DEFAULT 0,
  payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  applied_at      timestamptz,
  CHECK (pv_delta_left = 0 OR pv_delta_right = 0)
  -- ^ a single event affects exactly one leg (it propagates from one affiliate up)
);
CREATE INDEX tree_event_affiliate_idx ON mlm.tree_event(affiliate_id, occurred_at);
CREATE INDEX tree_event_unapplied     ON mlm.tree_event(id) WHERE applied_at IS NULL;

-- =============================================================================
-- 7. BONUS RUNS — closed binary cycles, immutable read model
-- =============================================================================

CREATE TABLE mlm.bonus_run (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_date        date    NOT NULL,
  kind            mlm.concept_kind NOT NULL,     -- binary_bonus | leadership_bonus | roi
  closed_at       timestamptz,
  total_paid_usd  numeric(20,2),
  total_fee_usd   numeric(20,2),                 -- house margin (per mlm_binario_margen_operativo.md)
  parameters      jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (run_date, kind)
);

CREATE TABLE mlm.bonus_run_payout (
  bonus_run_id    bigint NOT NULL REFERENCES mlm.bonus_run(id),
  affiliate_id    bigint NOT NULL REFERENCES mlm.affiliate(id),
  weak_leg        mlm.tree_position,
  weak_leg_pv     numeric(20,2),
  strong_leg_pv   numeric(20,2),
  paired_pv       numeric(20,2),
  bonus_amount    numeric(14,2),
  carry_remaining numeric(20,2),
  txn_id          uuid REFERENCES mlm.transaction(id),  -- ledger reference
  PRIMARY KEY (bonus_run_id, affiliate_id)
);

-- Snapshot per affiliate per period — for reporting without recomputing
CREATE TABLE mlm.affiliate_period_snapshot (
  affiliate_id    bigint NOT NULL REFERENCES mlm.affiliate(id),
  period          char(7) NOT NULL,              -- 'YYYY-MM'
  rank_id         smallint REFERENCES mlm.rank(id),
  left_count      bigint NOT NULL,
  right_count     bigint NOT NULL,
  left_pv         numeric(20,2) NOT NULL,
  right_pv        numeric(20,2) NOT NULL,
  total_earned_usd numeric(14,2) NOT NULL,
  total_withdrawn_usd numeric(14,2) NOT NULL,
  closed_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (affiliate_id, period)
);

-- =============================================================================
-- 8. WITHDRAWALS & EXTERNAL ACCOUNTS
-- =============================================================================

CREATE TYPE mlm.withdrawal_status AS ENUM ('requested', 'approved', 'rejected', 'paid', 'cancelled');

CREATE TABLE mlm.money_account (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  affiliate_id    bigint NOT NULL REFERENCES mlm.affiliate(id),
  account_type    text   NOT NULL,                -- bank | crypto
  bank_id         smallint,
  asset_id        smallint REFERENCES mlm.asset(id),
  account_number  text,
  clabe           text,
  account_name    text,
  address         text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mlm.withdrawal_request (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  affiliate_id        bigint NOT NULL REFERENCES mlm.affiliate(id),
  wallet_id           bigint NOT NULL REFERENCES mlm.wallet(id),
  money_account_id    bigint REFERENCES mlm.money_account(id),
  amount_usd          numeric(14,2) NOT NULL CHECK (amount_usd > 0),
  status              mlm.withdrawal_status NOT NULL DEFAULT 'requested',
  txn_id              uuid REFERENCES mlm.transaction(id),
  comments            text,
  remark              text,
  approved_by_person_id bigint REFERENCES mlm.person(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- 9. AUDIT LOGS (separate schema so retention/archival is independent)
-- =============================================================================

CREATE TABLE audit.activity_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id   text REFERENCES auth.user(id),
  entity_type     text NOT NULL,
  entity_id       text NOT NULL,
  action          text NOT NULL,
  before_data     jsonb,
  after_data      jsonb,
  ip              inet,
  user_agent      text,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_log_entity_idx ON audit.activity_log(entity_type, entity_id, occurred_at DESC);
CREATE INDEX activity_log_actor_idx  ON audit.activity_log(actor_user_id, occurred_at DESC);

-- =============================================================================
-- 10. TRIGGERS — enforce invariants v1 was missing
-- =============================================================================

-- Enforce: amount sign matches concept.factor; required pairs balance to zero
CREATE OR REPLACE FUNCTION mlm.fn_validate_movement() RETURNS trigger AS $$
DECLARE
  v_factor smallint;
  v_requires_pair boolean;
BEGIN
  SELECT factor, requires_pair INTO v_factor, v_requires_pair
    FROM mlm.concept WHERE id = NEW.concept_id;
  IF v_factor = 1  AND NEW.amount <= 0 THEN RAISE EXCEPTION 'Credit concept % requires positive amount', NEW.concept_id; END IF;
  IF v_factor = -1 AND NEW.amount >= 0 THEN RAISE EXCEPTION 'Debit concept % requires negative amount', NEW.concept_id; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_validate_movement
  BEFORE INSERT OR UPDATE ON mlm.wallet_movement
  FOR EACH ROW EXECUTE FUNCTION mlm.fn_validate_movement();

-- On transaction posting, verify required-pair concepts net to zero
CREATE OR REPLACE FUNCTION mlm.fn_validate_transaction() RETURNS trigger AS $$
DECLARE v_unbalanced numeric;
BEGIN
  IF NEW.status = 'posted' AND OLD.status <> 'posted' THEN
    SELECT COALESCE(SUM(wm.amount), 0)
      INTO v_unbalanced
      FROM mlm.wallet_movement wm
      JOIN mlm.concept c ON c.id = wm.concept_id
     WHERE wm.transaction_id = NEW.id AND c.requires_pair = true;
    IF v_unbalanced <> 0 THEN
      RAISE EXCEPTION 'Transaction % does not balance: % ', NEW.id, v_unbalanced;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_validate_transaction
  BEFORE UPDATE ON mlm.transaction
  FOR EACH ROW EXECUTE FUNCTION mlm.fn_validate_transaction();

-- Maintain wallet.balance incrementally
CREATE OR REPLACE FUNCTION mlm.fn_update_wallet_balance() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE mlm.wallet SET balance = balance + NEW.amount WHERE id = NEW.wallet_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE mlm.wallet SET balance = balance - OLD.amount WHERE id = OLD.wallet_id;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_wallet_balance
  AFTER INSERT OR DELETE ON mlm.wallet_movement
  FOR EACH ROW EXECUTE FUNCTION mlm.fn_update_wallet_balance();

-- Compute path/depth on affiliate insert; reject placement under non-empty leg
CREATE OR REPLACE FUNCTION mlm.fn_compute_affiliate_path() RETURNS trigger AS $$
DECLARE
  v_parent_path ltree;
  v_parent_depth int;
BEGIN
  IF NEW.parent_id IS NULL THEN
    NEW.path  := text2ltree(NEW.id::text);
    NEW.depth := 0;
  ELSE
    SELECT path, depth INTO v_parent_path, v_parent_depth
      FROM mlm.affiliate WHERE id = NEW.parent_id;
    IF v_parent_path IS NULL THEN
      RAISE EXCEPTION 'Parent % not found', NEW.parent_id;
    END IF;
    NEW.path  := v_parent_path || text2ltree(NEW.position::text || '_' || NEW.id::text);
    NEW.depth := v_parent_depth + 1;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_affiliate_path
  BEFORE INSERT ON mlm.affiliate
  FOR EACH ROW EXECUTE FUNCTION mlm.fn_compute_affiliate_path();

-- Mantener mlm.affiliate_closure al insertar un afiliado. N con parent P hereda
-- los ancestros de P (incluido P) a distancia +1, más su self-row (distance 0).
-- Los nodos siempre se insertan bajo un parent existente (adjacency), así que la
-- closure de P ya existe. AFTER INSERT, misma transacción (no diferido).
CREATE OR REPLACE FUNCTION mlm.fn_maintain_affiliate_closure() RETURNS trigger AS $$
BEGIN
  INSERT INTO mlm.affiliate_closure (ancestor_id, descendant_id, distance)
  VALUES (NEW.id, NEW.id, 0)
  ON CONFLICT (ancestor_id, descendant_id) DO NOTHING;

  IF NEW.parent_id IS NOT NULL THEN
    INSERT INTO mlm.affiliate_closure (ancestor_id, descendant_id, distance)
    SELECT c.ancestor_id, NEW.id, c.distance + 1
      FROM mlm.affiliate_closure c
     WHERE c.descendant_id = NEW.parent_id
    ON CONFLICT (ancestor_id, descendant_id) DO NOTHING;
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_maintain_affiliate_closure
  AFTER INSERT ON mlm.affiliate
  FOR EACH ROW EXECUTE FUNCTION mlm.fn_maintain_affiliate_closure();

-- Apply tree_event to ancestor aggregates (the hot path).
-- Locks ancestors in path order to avoid deadlocks on concurrent inserts.
CREATE OR REPLACE FUNCTION mlm.fn_apply_tree_event() RETURNS trigger AS $$
DECLARE
  v_path ltree;
  v_position mlm.tree_position;
BEGIN
  SELECT path INTO v_path FROM mlm.affiliate WHERE id = NEW.affiliate_id FOR UPDATE;

  -- Walk ancestors. For each ancestor A, determine which leg of A this affiliate sits in
  -- (compare A's child label in NEW path). Add pv_delta to that leg.
  WITH ancestors AS (
    -- Ancestros vía closure (index-backed) en vez de `a.path @> v_path` (seq
    -- scan sin GiST). distance > 0 excluye la self-row — equivalente al viejo
    -- `a.id <> NEW.affiliate_id`. La detección de pierna abajo sigue path-based.
    SELECT a.id, a.path, a.depth
      FROM mlm.affiliate a
      JOIN mlm.affiliate_closure c ON c.ancestor_id = a.id
     WHERE c.descendant_id = NEW.affiliate_id AND c.distance > 0
     ORDER BY a.depth ASC
     FOR UPDATE OF a
  ), legged AS (
    SELECT
      anc.id,
      -- the label at depth+1 in v_path is the leg under anc
      CASE WHEN substring(ltree2text(subpath(v_path, anc.depth + 1, 1)) from 1 for 1) = 'L' THEN 'L'::mlm.tree_position
           ELSE 'R'::mlm.tree_position END AS leg
    FROM ancestors anc
  )
  UPDATE mlm.affiliate a
     SET left_pv_lifetime  = a.left_pv_lifetime  + CASE WHEN l.leg = 'L' THEN NEW.pv_delta_left  + NEW.pv_delta_right ELSE 0 END,
         right_pv_lifetime = a.right_pv_lifetime + CASE WHEN l.leg = 'R' THEN NEW.pv_delta_left  + NEW.pv_delta_right ELSE 0 END,
         left_pv_current   = a.left_pv_current   + CASE WHEN l.leg = 'L' THEN NEW.pv_delta_left  + NEW.pv_delta_right ELSE 0 END,
         right_pv_current  = a.right_pv_current  + CASE WHEN l.leg = 'R' THEN NEW.pv_delta_left  + NEW.pv_delta_right ELSE 0 END,
         left_count        = a.left_count        + CASE WHEN NEW.kind = 'enrollment' AND l.leg = 'L' THEN 1 ELSE 0 END,
         right_count       = a.right_count       + CASE WHEN NEW.kind = 'enrollment' AND l.leg = 'R' THEN 1 ELSE 0 END,
         updated_at        = now()
    FROM legged l
   WHERE a.id = l.id;

  UPDATE mlm.tree_event SET applied_at = now() WHERE id = NEW.id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_apply_tree_event
  AFTER INSERT ON mlm.tree_event
  FOR EACH ROW EXECUTE FUNCTION mlm.fn_apply_tree_event();

-- =============================================================================
-- 11. RECONCILIATION VIEWS — nightly job compares these against materialized state
-- =============================================================================

CREATE VIEW mlm.v_wallet_balance_truth AS
SELECT w.id AS wallet_id, w.affiliate_id, w.asset_id,
       w.balance AS materialized_balance,
       COALESCE(SUM(wm.amount), 0) AS computed_balance,
       w.balance - COALESCE(SUM(wm.amount), 0) AS drift
  FROM mlm.wallet w
  LEFT JOIN mlm.wallet_movement wm ON wm.wallet_id = w.id
 GROUP BY w.id;

-- Descendientes vía closure (distance > 0) en vez de `desc_a.path <@ a.path AND
-- desc_a.id <> a.id`. La detección de pierna sigue siendo path-based e idéntica.
CREATE VIEW mlm.v_tree_pv_truth AS
SELECT a.id, a.left_pv_lifetime AS materialized_left,
       a.right_pv_lifetime AS materialized_right,
       (SELECT COALESCE(SUM(te.pv_delta_left + te.pv_delta_right), 0)
          FROM mlm.tree_event te
          JOIN mlm.affiliate desc_a ON desc_a.id = te.affiliate_id
          JOIN mlm.affiliate_closure c
            ON c.ancestor_id = a.id AND c.descendant_id = desc_a.id AND c.distance > 0
         WHERE substring(ltree2text(subpath(desc_a.path, a.depth + 1, 1)) from 1 for 1) = 'L'
       ) AS computed_left,
       (SELECT COALESCE(SUM(te.pv_delta_left + te.pv_delta_right), 0)
          FROM mlm.tree_event te
          JOIN mlm.affiliate desc_a ON desc_a.id = te.affiliate_id
          JOIN mlm.affiliate_closure c
            ON c.ancestor_id = a.id AND c.descendant_id = desc_a.id AND c.distance > 0
         WHERE substring(ltree2text(subpath(desc_a.path, a.depth + 1, 1)) from 1 for 1) = 'R'
       ) AS computed_right
  FROM mlm.affiliate a;

-- Drift detection query (run nightly):
--   SELECT * FROM mlm.v_wallet_balance_truth WHERE drift <> 0;
--   SELECT * FROM mlm.v_tree_pv_truth
--     WHERE materialized_left <> computed_left OR materialized_right <> computed_right;

-- =============================================================================
-- 12. ROLES & PERMISSIONS
-- =============================================================================

-- Idempotente: 00-init.sql ya crea estos roles en producción (cluster-level,
-- sobreviven a DROP DATABASE) — sin guarda, re-aplicar el schema fallaba.
DO $$ BEGIN CREATE ROLE app_read NOLOGIN;  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE app_write NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE app_admin NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT USAGE ON SCHEMA mlm, auth, audit TO app_read, app_write, app_admin;

GRANT SELECT ON ALL TABLES IN SCHEMA mlm    TO app_read;
GRANT SELECT ON ALL TABLES IN SCHEMA auth   TO app_read;
ALTER DEFAULT PRIVILEGES IN SCHEMA mlm  GRANT SELECT ON TABLES TO app_read;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT SELECT ON TABLES TO app_read;

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA mlm TO app_write;
GRANT SELECT, INSERT ON audit.activity_log TO app_write;
ALTER DEFAULT PRIVILEGES IN SCHEMA mlm GRANT SELECT, INSERT, UPDATE ON TABLES TO app_write;

GRANT ALL ON ALL TABLES IN SCHEMA mlm, auth, audit TO app_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA mlm, auth, audit GRANT ALL ON TABLES TO app_admin;

-- Application connects as app_write. Ops as app_admin (separate role for
-- manual_adjustment / reversal concept inserts, with mandatory audit row).
