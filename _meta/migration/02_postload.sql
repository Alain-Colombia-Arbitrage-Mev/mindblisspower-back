-- =============================================================================
-- 02_postload.sql — transform staging.* into mlm.*
-- Pre-req: schema_mlm.sql already executed; staging.* loaded by pgloader.
-- Idempotent: TRUNCATEs mlm.* tables in dependency order before re-loading.
-- Run: psql -d vicionpower -f 02_postload.sql -v ON_ERROR_STOP=1
-- =============================================================================

\timing on
SET search_path = mlm, public;
\set TZ 'America/Bogota'

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Reset target tables (allow re-runs during dry-run testing)
-- ---------------------------------------------------------------------------
-- trg_rank_achieved_immutable es BEFORE UPDATE/DELETE; TRUNCATE no lo dispara.
TRUNCATE
  mlm.bonus_run_payout, mlm.bonus_run, mlm.affiliate_period_snapshot,
  mlm.affiliate_rank_achieved, mlm.affiliate_payout_state,
  mlm.tree_event, mlm.withdrawal_request, mlm.money_account,
  mlm.affiliate_package, mlm.wallet_movement, mlm.transaction,
  mlm.wallet, mlm.affiliate, mlm.person,
  audit.activity_log
RESTART IDENTITY CASCADE;

-- ---------------------------------------------------------------------------
-- 1. Catalogs (idempotent upsert — small, fast)
-- ---------------------------------------------------------------------------
INSERT INTO mlm.country (id, iso2, name_es, name_en, phone_code, phone_regex)
SELECT idcountry, iso2, namees, nameen, codenumber, regex
  FROM staging.country
ON CONFLICT (id) DO UPDATE
  SET iso2 = EXCLUDED.iso2, name_es = EXCLUDED.name_es,
      name_en = EXCLUDED.name_en, phone_code = EXCLUDED.phone_code;

INSERT INTO mlm.asset (id, symbol, name, is_fiat, decimals, current_value_usd, updated_at)
SELECT idasset, name,
       name,
       (name IN ('USD','MXN','EUR')),
       CASE WHEN name IN ('USD','MXN','EUR') THEN 2 ELSE 8 END,
       currentvaluedls, lastupdatetime AT TIME ZONE 'America/Bogota'
  FROM staging.asset
ON CONFLICT (id) DO UPDATE SET current_value_usd = EXCLUDED.current_value_usd, updated_at = EXCLUDED.updated_at;

-- Concept: map old idconcept -> new (kind, factor, requires_pair).
-- The 'inter_platform_legacy_unpaired' concept is created here and used only
-- for backfilling the historical $348M concepto-16 movements.
INSERT INTO mlm.concept (id, kind, name_es, name_en, factor, requires_pair, active) VALUES
  -- Reserve id ranges: 1-99 legacy migrated; 1000+ new concepts
  -- The legacy IDs come straight from staging.concept; we add metadata.
  (16, 'inter_platform', 'Crédito (legado, sin contraparte)', 'Credit (legacy, unpaired)', 1, false, false),
  (15, 'inter_platform', 'Débito (legado, sin contraparte)', 'Debit (legacy, unpaired)', -1, false, false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO mlm.concept (id, kind, name_es, name_en, factor, requires_pair, active)
SELECT c.idconcept,
       -- Heuristic mapping: refine after reviewing staging.concept.namees per row.
       -- For unknown legacy concepts, default to 'manual_adjustment' which is paired-required.
       CASE lower(c.namees)
         WHEN 'roi' THEN 'roi'::mlm.concept_kind
         WHEN 'bono binario' THEN 'binary_bonus'::mlm.concept_kind
         WHEN 'bono de liderazgo' THEN 'leadership_bonus'::mlm.concept_kind
         WHEN 'bono directo' THEN 'direct_bonus'::mlm.concept_kind
         WHEN 'compra de paquete' THEN 'package_purchase'::mlm.concept_kind
         WHEN 'retiro' THEN 'withdrawal'::mlm.concept_kind
         ELSE 'manual_adjustment'::mlm.concept_kind
       END,
       c.namees, c.nameen,
       CASE WHEN c.factor IN (-1,1) THEN c.factor ELSE 1 END,
       false,  -- legacy concepts default to NOT requiring pair (forensic mode)
       coalesce(c.active, true)
  FROM staging.concept c
 WHERE c.idconcept NOT IN (15, 16)
ON CONFLICT (id) DO NOTHING;

-- Rank — los rangos legacy NO se importan a mlm.rank. mlm.rank contiene los
-- 14 rangos de la carrera nueva (seed: schema_ranks.sql). El rango heredado
-- del 2.0 se traduce vía staging.rank_map, una tabla de mapeo MANUAL que se
-- llena y aprueba antes del cutover (directiva 2026-06-04: se conserva
-- posición y rango; el volumen arranca en 0).
CREATE TABLE IF NOT EXISTS staging.rank_map (
  legacy_id_rank  integer  PRIMARY KEY,   -- staging.rank.idrank
  new_rank_id     smallint NOT NULL REFERENCES mlm.rank(id),  -- 1..14
  notes           text
);

-- Fail-closed: todo rango legacy EN USO debe estar mapeado antes de seguir.
DO $$
DECLARE v_unmapped int;
BEGIN
  SELECT count(DISTINCT v.idrank) INTO v_unmapped
    FROM staging.vicionario v
   WHERE v.idrank IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM staging.rank_map rm WHERE rm.legacy_id_rank = v.idrank);
  IF v_unmapped > 0 THEN
    RAISE EXCEPTION 'staging.rank_map incompleta: % rangos legacy en uso sin mapear. '
      'Llenar con: INSERT INTO staging.rank_map (legacy_id_rank, new_rank_id, notes) VALUES ...', v_unmapped;
  END IF;
END $$;

-- Package
INSERT INTO mlm.package (id, name, amount_usd, pv, type, is_active, created_at, updated_at)
SELECT idpackage,
       coalesce(name, 'package_' || idpackage::text),
       coalesce(amount, 0),
       coalesce(amount, 0)::int,  -- v1 doesn't separate price from PV; assume parity, refine later
       coalesce(idtype::text, 'enrollment'),
       coalesce(isactive, true),
       coalesce(timeupdated, now()) AT TIME ZONE 'America/Bogota',
       coalesce(timeupdated, now()) AT TIME ZONE 'America/Bogota'
  FROM staging.package
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name, amount_usd = EXCLUDED.amount_usd,
      pv = EXCLUDED.pv, is_active = EXCLUDED.is_active,
      updated_at = EXCLUDED.updated_at;

-- ---------------------------------------------------------------------------
-- 2. Persons
--    Persons exist for both end users (downline) and admins. KYC details
--    flattened from vicionarioKyc into mlm.person fields.
-- ---------------------------------------------------------------------------
INSERT INTO mlm.person (
  legacy_id_person, first_name, last_name, alias, email,
  phone_country_id, phone_number, birthday, birth_country_id,
  status, kyc_status, kyc_approved_at, is_admin, blacklisted,
  created_at, updated_at
)
SELECT p.idperson,
       p.firstname, p.lastname, p.alias, lower(p.email),
       p.idcountryphone, p.phonenumber, p.birthday, p.idcountrybirthday,
       CASE p.idstatus
         WHEN 1 THEN 'active'::mlm.person_status
         WHEN 2 THEN 'pending'::mlm.person_status
         WHEN 3 THEN 'suspended'::mlm.person_status
         WHEN 4 THEN 'banned'::mlm.person_status
         ELSE 'pending'::mlm.person_status
       END,
       CASE WHEN v.kycapproved THEN 'approved'::mlm.kyc_status
            ELSE 'not_started'::mlm.kyc_status END,
       v.timekycapproved AT TIME ZONE 'America/Bogota',
       (p.idrole = 1),  -- assuming 1 = admin role; verify with staging.role
       coalesce(p.blacklist, false),
       coalesce(p.creationtime, '2020-01-01'::timestamp) AT TIME ZONE 'America/Bogota',
       coalesce(p.timeupdated, p.creationtime, '2020-01-01'::timestamp) AT TIME ZONE 'America/Bogota'
  FROM staging.person p
  LEFT JOIN staging.vicionario v ON v.idperson = p.idperson
 WHERE p.email IS NOT NULL
   AND p.email <> ''
ON CONFLICT (email) DO NOTHING;

-- Catch invalid birthdays — quarantine, don't fail
UPDATE mlm.person SET birthday = NULL WHERE birthday < '1900-01-01' OR birthday > CURRENT_DATE;

-- ---------------------------------------------------------------------------
-- 3. Affiliates — load with parent_id, then rebuild path in topological order
-- ---------------------------------------------------------------------------

-- Disable path trigger so we can bulk-load with NULL paths and fill them in one pass.
ALTER TABLE mlm.affiliate DISABLE TRIGGER trg_affiliate_path;

-- Step 3a: insert all affiliates with NULL path/depth temporarily.
-- We bypass the NOT NULL on path by adding a temporary default.
ALTER TABLE mlm.affiliate ALTER COLUMN path DROP NOT NULL;
ALTER TABLE mlm.affiliate ALTER COLUMN depth DROP NOT NULL;

INSERT INTO mlm.affiliate (
  legacy_id_vicionario, person_id, invitation_link,
  parent_id, position, sponsor_id,
  path, depth,
  left_count, right_count,
  left_pv_lifetime, right_pv_lifetime,
  left_pv_current, right_pv_current,
  left_carry, right_carry,
  current_rank_id, status,
  created_at, updated_at
)
SELECT v.idvicionario,
       p.id,
       v.invitationlink,
       NULL::bigint, NULL::mlm.tree_position,  -- filled in step 3c
       NULL::bigint,                            -- sponsor_id filled in step 3d
       NULL::ltree, NULL::int,                  -- path/depth filled in step 3e
       -- Volumen arranca en 0 (directiva 2026-06-04): PV piernas, carry y
       -- contadores de carrera NO se migran. counts se rebuildan en 03.
       0, 0, 0, 0, 0, 0, 0, 0,
       rm.new_rank_id,                          -- rango heredado vía staging.rank_map
       CASE v.idstatus
         WHEN 1 THEN 'active'::mlm.person_status
         WHEN 2 THEN 'pending'::mlm.person_status
         WHEN 3 THEN 'suspended'::mlm.person_status
         WHEN 4 THEN 'banned'::mlm.person_status
         ELSE 'active'::mlm.person_status
       END,
       coalesce(v.creationtime, '2020-01-01'::timestamp) AT TIME ZONE 'America/Bogota',
       coalesce(v.creationtime, '2020-01-01'::timestamp) AT TIME ZONE 'America/Bogota'
  FROM staging.vicionario v
  JOIN mlm.person p ON p.legacy_id_person = v.idperson
  LEFT JOIN staging.rank_map rm ON rm.legacy_id_rank = v.idrank;

-- Step 3b: temporary lookup table mapping legacy_id_vicionario -> new affiliate.id
CREATE TEMP TABLE map_aff AS
  SELECT id, legacy_id_vicionario FROM mlm.affiliate;
CREATE INDEX ON map_aff (legacy_id_vicionario);

-- Step 3c: backfill parent_id + position
UPDATE mlm.affiliate a
   SET parent_id = mp.id,
       position = CASE
         WHEN sv.idvicionarioleft  = a.legacy_id_vicionario THEN 'L'::mlm.tree_position
         WHEN sv.idvicionarioright = a.legacy_id_vicionario THEN 'R'::mlm.tree_position
         ELSE NULL
       END
  FROM staging.vicionario v
  LEFT JOIN map_aff mp ON mp.legacy_id_vicionario = v.idvicionarioparent
  LEFT JOIN staging.vicionario sv ON sv.idvicionario = v.idvicionarioparent
 WHERE a.legacy_id_vicionario = v.idvicionario;

-- Step 3d: backfill sponsor_id
UPDATE mlm.affiliate a
   SET sponsor_id = ms.id
  FROM staging.vicionario v
  JOIN map_aff ms ON ms.legacy_id_vicionario = v.idsponsor
 WHERE a.legacy_id_vicionario = v.idvicionario
   AND v.idsponsor IS NOT NULL;

-- Step 3e: rebuild path + depth recursively from root
WITH RECURSIVE tree(id, parent_id, position, path, depth) AS (
  SELECT id, parent_id, position,
         text2ltree(id::text), 0
    FROM mlm.affiliate WHERE parent_id IS NULL
  UNION ALL
  SELECT a.id, a.parent_id, a.position,
         t.path || text2ltree(a.position::text || '_' || a.id::text),
         t.depth + 1
    FROM mlm.affiliate a JOIN tree t ON a.parent_id = t.id
)
UPDATE mlm.affiliate a SET path = t.path, depth = t.depth FROM tree t WHERE a.id = t.id;

-- Path integrity check
DO $$
DECLARE v_orphans int;
BEGIN
  SELECT count(*) INTO v_orphans FROM mlm.affiliate WHERE path IS NULL;
  IF v_orphans > 0 THEN
    RAISE EXCEPTION 'Path reconstruction left % orphans (broken parent chain)', v_orphans;
  END IF;
END $$;

ALTER TABLE mlm.affiliate ALTER COLUMN path SET NOT NULL;
ALTER TABLE mlm.affiliate ALTER COLUMN depth SET NOT NULL;
ALTER TABLE mlm.affiliate ENABLE TRIGGER trg_affiliate_path;

-- Step 3f: baseline de carrera de rangos. El rango heredado acredita sus
-- puntos como baseline → el siguiente rango exige sólo el delta de puntos
-- NUEVOS (el volumen real arranca en 0). Para exigir threshold completo
-- desde cero: omitir este UPDATE (baseline queda 0).
UPDATE mlm.affiliate a
   SET rank_points_baseline = r.required_points
  FROM mlm.rank r
 WHERE r.id = a.current_rank_id;

-- Step 3g: registrar rangos heredados — TODOS los rangos hasta el actual se
-- marcan alcanzados con source='legacy' y bono 0 (SIN bono retroactivo).
-- trg_sync_current_rank se desactiva: current_rank_id ya viene correcto del
-- INSERT (rm.new_rank_id) y el trigger haría un UPDATE por fila insertada.
ALTER TABLE mlm.affiliate_rank_achieved DISABLE TRIGGER trg_sync_current_rank;

INSERT INTO mlm.affiliate_rank_achieved
  (affiliate_id, rank_id, achieved_at, source, bonus_amount_usd, net_amount_usd)
SELECT a.id, r.id, a.created_at, 'legacy', 0, 0
  FROM mlm.affiliate a
  JOIN mlm.rank cr ON cr.id = a.current_rank_id
  JOIN mlm.rank r  ON r.required_points <= cr.required_points
ON CONFLICT (affiliate_id, rank_id) DO NOTHING;

ALTER TABLE mlm.affiliate_rank_achieved ENABLE TRIGGER trg_sync_current_rank;

-- Step 3h: directos balanced para el gate R2 (ADR-0015). Un "directo" es un
-- patrocinado (sponsor_id = afiliado) colocado dentro de su subtree binario;
-- la pierna es el primer label del path debajo del sponsor. Patrocinados
-- fuera del subtree no cuentan (misma semántica que simulator.Node.Directs*).
WITH d AS (
  SELECT rec.sponsor_id AS sid,
         substring(ltree2text(subpath(rec.path, sp.depth + 1, 1)) from 1 for 1) AS leg
    FROM mlm.affiliate rec
    JOIN mlm.affiliate sp ON sp.id = rec.sponsor_id
   WHERE rec.path <@ sp.path
     AND rec.id <> sp.id
), agg AS (
  SELECT sid,
         count(*) FILTER (WHERE leg = 'L') AS l,
         count(*) FILTER (WHERE leg = 'R') AS r
    FROM d GROUP BY sid
)
UPDATE mlm.affiliate a
   SET directs_left  = agg.l,
       directs_right = agg.r
  FROM agg
 WHERE a.id = agg.sid;

-- Step 3i: estado del motor (R1/R2/R3) — una fila por afiliado. El volumen y
-- los puntos R3 arrancan en 0. last_purchase_at se siembra con la última
-- activación de paquete legacy para que R1 no marque a todos como stale en
-- el primer cierre (la ventana stale corre desde el cutover).
INSERT INTO mlm.affiliate_payout_state (affiliate_id, last_purchase_at)
SELECT mp.id,
       max(coalesce(vp.updatetime, vp.creationtime) AT TIME ZONE 'America/Bogota')
  FROM mlm.affiliate mp
  LEFT JOIN staging.vicionariopackage vp
         ON vp.idvicionario = mp.legacy_id_vicionario AND vp.idstatus = 1
 GROUP BY mp.id;

-- ---------------------------------------------------------------------------
-- 4. Wallets
-- ---------------------------------------------------------------------------
INSERT INTO mlm.wallet (legacy_id_wallet, affiliate_id, asset_id, address, balance, created_at)
SELECT w.idwallet, mp.id, w.idasset, w.address, 0,
       w.timecreation AT TIME ZONE 'America/Bogota'
  FROM staging.wallet w
  JOIN map_aff mp ON mp.legacy_id_vicionario = w.idvicionario;

-- ---------------------------------------------------------------------------
-- 5. Affiliate packages
-- ---------------------------------------------------------------------------
INSERT INTO mlm.affiliate_package (
  legacy_id_vp, affiliate_id, package_id, status,
  payment_method, payment_proof_url, transaction_hash,
  current_period_date, periodicity_id,
  created_at, activated_at
)
SELECT vp.idvicionariopackage, mp.id, vp.idpackage,
       CASE vp.idstatus
         WHEN 1 THEN 'active'::mlm.package_status
         WHEN 2 THEN 'pending_payment'::mlm.package_status
         WHEN 3 THEN 'expired'::mlm.package_status
         WHEN 4 THEN 'refunded'::mlm.package_status
         ELSE 'active'::mlm.package_status
       END,
       vp.idpaymentmethod::text, vp.paymentproofpublicurl, vp.transactionhash,
       vp.currentperioddate, vp.idperiodicity::smallint,
       coalesce(vp.creationtime, '2020-01-01'::timestamp) AT TIME ZONE 'America/Bogota',
       vp.updatetime AT TIME ZONE 'America/Bogota'
  FROM staging.vicionariopackage vp
  JOIN map_aff mp ON mp.legacy_id_vicionario = vp.idvicionario;

-- ---------------------------------------------------------------------------
-- 6. Wallet movements — the largest and most defensive step
--    Strategy: every legacy movement becomes a single-side movement wrapped
--    in its own transaction with external_ref = 'legacy:<idMovement>'.
--    Real double-entry pairing only enforced for NEW transactions going forward.
-- ---------------------------------------------------------------------------

-- 6a. Quarantine corrupted dates BEFORE insertion to avoid CHECK violations.
-- staging.movement NO se modifica (es la copia forense — 04_reconcile C1
-- compara contra el conteo original); los pasos 6b/6c excluyen la cuarentena
-- vía NOT EXISTS. Idempotente en re-runs.
CREATE TABLE IF NOT EXISTS staging.movement_quarantine (LIKE staging.movement INCLUDING ALL);

INSERT INTO staging.movement_quarantine
SELECT * FROM staging.movement m
 WHERE (m.datemovement IS NULL
    OR m.datemovement < '2015-01-01'
    OR m.datemovement > CURRENT_DATE + interval '7 days'
    OR m.timecreation < '2015-01-01'
    OR m.timecreation > CURRENT_TIMESTAMP + interval '7 days')
   AND NOT EXISTS (SELECT 1 FROM staging.movement_quarantine q WHERE q.idmovement = m.idmovement);

-- 6b. Generate one transaction per legacy movement (idempotency_key = legacy id)
INSERT INTO mlm.transaction (id, external_ref, description, status, posted_at, created_at)
SELECT gen_random_uuid(),
       'legacy:movement:' || m.idmovement::text,
       'migrated legacy movement ' || m.idmovement::text,
       'posted',
       (m.timecreation AT TIME ZONE 'America/Bogota'),
       (m.timecreation AT TIME ZONE 'America/Bogota')
  FROM staging.movement m
 WHERE NOT EXISTS (SELECT 1 FROM staging.movement_quarantine q WHERE q.idmovement = m.idmovement);

-- 6c. Insert movements with affiliate_id backfilled from wallet (closes the NULL gap)
-- Disable validate trigger temporarily — legacy data may have sign mismatches we
-- consciously accept for forensic preservation.
ALTER TABLE mlm.wallet_movement DISABLE TRIGGER trg_validate_movement;

INSERT INTO mlm.wallet_movement (
  legacy_id_movement, transaction_id, wallet_id, affiliate_id,
  concept_id, vicionario_package_id, vicionario_package_origin_id,
  rank_id, amount, reference, posted_at, available_at, is_frozen, created_at
)
SELECT m.idmovement,
       t.id,
       w.id,
       w.affiliate_id,                              -- backfilled NOT NULL
       m.idconcept,
       ap.id, ap_origin.id,
       rm.new_rank_id,                              -- rango legacy → 1-14 vía rank_map (NULL si sin mapear)
       (m.import * coalesce(c.factor, 1))::numeric(20,8),  -- apply factor to get signed amount
       m.reference,
       (m.timecreation AT TIME ZONE 'America/Bogota'),
       m.dateavailable,
       coalesce(m.frozen, false),
       (m.timecreation AT TIME ZONE 'America/Bogota')
  FROM staging.movement m
  JOIN mlm.transaction t       ON t.external_ref = 'legacy:movement:' || m.idmovement::text
  JOIN mlm.wallet w            ON w.legacy_id_wallet = m.idwallet
  JOIN staging.concept c       ON c.idconcept = m.idconcept
  LEFT JOIN staging.rank_map rm ON rm.legacy_id_rank = m.idrank
  LEFT JOIN mlm.affiliate_package ap        ON ap.legacy_id_vp = m.idvicionariopackage
  LEFT JOIN mlm.affiliate_package ap_origin ON ap_origin.legacy_id_vp = m.idvicionariopackageorigin
 WHERE NOT EXISTS (SELECT 1 FROM staging.movement_quarantine q WHERE q.idmovement = m.idmovement);

ALTER TABLE mlm.wallet_movement ENABLE TRIGGER trg_validate_movement;

-- 6d. Recompute wallet.balance from movements (trigger was active during INSERT
-- but a single set-based recompute is the audit-friendly version)
UPDATE mlm.wallet w
   SET balance = sub.s
  FROM (SELECT wallet_id, sum(amount) AS s FROM mlm.wallet_movement GROUP BY wallet_id) sub
 WHERE w.id = sub.wallet_id;

-- ---------------------------------------------------------------------------
-- 7. Money accounts + withdrawals
-- ---------------------------------------------------------------------------
INSERT INTO mlm.money_account (
  affiliate_id, account_type, bank_id, asset_id, account_number, clabe, account_name, address, created_at
)
SELECT mp.id,
       CASE WHEN ma.idbank IS NOT NULL THEN 'bank' ELSE 'crypto' END,
       ma.idbank, ma.idasset,
       ma.account, ma.clabe, ma.nameaccount, ma.address,
       coalesce(ma.creationtime, '2020-01-01'::timestamp) AT TIME ZONE 'America/Bogota'
  FROM staging.vicionariomoneyaccount ma
  JOIN map_aff mp ON mp.legacy_id_vicionario = ma.idvicionario;

INSERT INTO mlm.withdrawal_request (
  affiliate_id, wallet_id, money_account_id, amount_usd, status,
  txn_id, comments, remark, approved_by_person_id, created_at, updated_at
)
SELECT mp.id,
       wlt.id,
       NULL,  -- vicionarioMoneyAccount id not directly mappable without extra join; refine if needed
       wr.importrequest,
       CASE wr.idstatus
         WHEN 1 THEN 'requested'::mlm.withdrawal_status
         WHEN 2 THEN 'approved'::mlm.withdrawal_status
         WHEN 3 THEN 'paid'::mlm.withdrawal_status
         WHEN 4 THEN 'rejected'::mlm.withdrawal_status
         WHEN 5 THEN 'cancelled'::mlm.withdrawal_status
         ELSE 'requested'::mlm.withdrawal_status
       END,
       (SELECT id FROM mlm.transaction WHERE external_ref = 'legacy:movement:' || wr.idmovement::text),
       wr.comments, wr.remark,
       (SELECT id FROM mlm.person WHERE legacy_id_person = wr.idpersonupdate),
       wr.creationtime AT TIME ZONE 'America/Bogota',
       coalesce(wr.updatetime, wr.creationtime) AT TIME ZONE 'America/Bogota'
  FROM staging.withdrawalrequest wr
  JOIN map_aff mp ON mp.legacy_id_vicionario = wr.idvicionario
  LEFT JOIN mlm.wallet wlt ON wlt.legacy_id_wallet = wr.idwallet;

-- ---------------------------------------------------------------------------
-- 8. Audit trail of mega-transactions for ops review
-- ---------------------------------------------------------------------------
INSERT INTO audit.activity_log (entity_type, entity_id, action, after_data, occurred_at)
SELECT 'wallet_movement',
       wm.id::text,
       'flagged_mega_transaction',
       jsonb_build_object('amount', wm.amount, 'concept_id', wm.concept_id, 'reference', wm.reference),
       wm.posted_at
  FROM mlm.wallet_movement wm
 WHERE abs(wm.amount) >= 1000000;

COMMIT;

-- Run ANALYZE so reconciliation queries plan well
ANALYZE mlm.affiliate;
ANALYZE mlm.wallet;
ANALYZE mlm.wallet_movement;
ANALYZE mlm.transaction;

\echo '=== 02_postload.sql complete ==='
\echo 'Affiliates:'      SELECT count(*) FROM mlm.affiliate;
\echo 'Wallets:'         SELECT count(*) FROM mlm.wallet;
\echo 'Movements:'       SELECT count(*) FROM mlm.wallet_movement;
\echo 'Quarantined:'     SELECT count(*) FROM staging.movement_quarantine;
