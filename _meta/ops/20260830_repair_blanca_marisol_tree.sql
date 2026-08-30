-- 20260830_repair_blanca_marisol_tree.sql
--
-- Purpose:
--   Repair Blanca Marisol (bcorado492@gmail.com) so her direct sponsor is
--   Juan Lopez Martinez (juan0114aguila@gmail.com), place her in Juan's
--   weak-leg slot using the production auto-placement rule, and correct the
--   already-posted period-3 direct/royalty bonuses append-only.
--
-- Important:
--   Must be run with the owner/admin role for mlm.affiliate_closure
--   (currently postgres in production). The vp_engine app role cannot delete
--   and rebuild closure rows.
--
-- Safety:
--   - leaf-only move; aborts if Blanca has descendants.
--   - checks expected affiliate ids and event totals.
--   - uses advisory locks around the old sponsor, new sponsor, Blanca, and
--     target parent.
--   - does not delete posted wallet movements; freezes the two wrong credits,
--     offsets materialized wallet balances with frozen debit adjustments, and
--     credits the correct recipients with traceable transactions.
--   - validates PV drift and count drift for all affected ancestors.

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

CREATE TEMP TABLE _ops_old_ancestors(
  ancestor_id bigint PRIMARY KEY,
  leg mlm.tree_position NOT NULL
) ON COMMIT DROP;

CREATE TEMP TABLE _ops_new_ancestors(
  ancestor_id bigint PRIMARY KEY,
  leg mlm.tree_position NOT NULL
) ON COMMIT DROP;

CREATE TEMP TABLE _ops_summary(k text, v text) ON COMMIT DROP;

DO $$
DECLARE
  v_blanca_id bigint;
  v_blanca_person_id bigint;
  v_old_parent_id bigint;
  v_old_position mlm.tree_position;
  v_old_sponsor_id bigint;
  v_old_path ltree;
  v_old_depth int;
  v_juan_id bigint;
  v_new_parent_id bigint;
  v_new_position mlm.tree_position;
  v_new_path ltree;
  v_new_depth int;
  v_desc_count bigint;
  v_slot_taken bigint;
  v_pv_total numeric(20,2);
  v_enroll_count int;
  v_old_direct_mov_id bigint;
  v_old_direct_wallet_id bigint;
  v_old_direct_affiliate_id bigint;
  v_old_direct_amount numeric(20,8);
  v_direct_posted_at timestamptz;
  v_direct_available_at date;
  v_old_roy_mov_id bigint;
  v_old_roy_wallet_id bigint;
  v_old_roy_affiliate_id bigint;
  v_old_roy_amount numeric(20,8);
  v_roy_posted_at timestamptz;
  v_roy_available_at date;
  v_juan_wallet_id bigint;
  v_correct_royalty_affiliate_id bigint;
  v_correct_royalty_wallet_id bigint;
  v_txn_id uuid;
  v_drift_count bigint;
  v_count_drift bigint;
  v_updated_rows bigint;
BEGIN
  SELECT a.id, a.person_id, a.parent_id, a.position, a.sponsor_id, a.path, a.depth
    INTO STRICT v_blanca_id, v_blanca_person_id, v_old_parent_id, v_old_position, v_old_sponsor_id, v_old_path, v_old_depth
    FROM mlm.person p
    JOIN mlm.affiliate a ON a.person_id = p.id
   WHERE lower(p.email::text) = 'bcorado492@gmail.com'
   FOR UPDATE OF a;

  SELECT a.id
    INTO STRICT v_juan_id
    FROM mlm.person p
    JOIN mlm.affiliate a ON a.person_id = p.id
   WHERE lower(p.email::text) = 'juan0114aguila@gmail.com'
   FOR UPDATE OF a;

  IF v_blanca_id <> 121534 THEN
    RAISE EXCEPTION 'Unexpected Blanca affiliate id: %', v_blanca_id;
  END IF;
  IF v_juan_id <> 79295 THEN
    RAISE EXCEPTION 'Unexpected Juan affiliate id: %', v_juan_id;
  END IF;

  PERFORM pg_advisory_xact_lock(2, v_juan_id::int);
  PERFORM pg_advisory_xact_lock(2, v_old_sponsor_id::int);
  PERFORM pg_advisory_xact_lock(2, v_blanca_id::int);

  SELECT count(*)
    INTO v_desc_count
    FROM mlm.affiliate_closure
   WHERE ancestor_id = v_blanca_id
     AND distance > 0;

  IF v_desc_count <> 0 THEN
    RAISE EXCEPTION 'Blanca has % descendants; subtree move required', v_desc_count;
  END IF;

  SELECT COALESCE(SUM(pv_delta_left + pv_delta_right), 0),
         count(*) FILTER (WHERE kind = 'enrollment')::int
    INTO v_pv_total, v_enroll_count
    FROM mlm.tree_event
   WHERE affiliate_id = v_blanca_id;

  IF v_pv_total <> 100 OR v_enroll_count <> 1 THEN
    RAISE EXCEPTION 'Unexpected Blanca event totals pv=% enrollment=%', v_pv_total, v_enroll_count;
  END IF;

  WITH RECURSIVE walk AS (
    SELECT a.id AS node_id,
           CASE WHEN a.left_pv_current < a.right_pv_current THEN 'L'
                WHEN a.right_pv_current < a.left_pv_current THEN 'R'
                WHEN a.left_count < a.right_count THEN 'L'
                WHEN a.right_count < a.left_count THEN 'R'
                ELSE 'L' END AS side,
           0 AS lvl
      FROM mlm.affiliate a
     WHERE a.id = v_juan_id
    UNION ALL
    SELECT c.id,
           CASE WHEN c.left_pv_current < c.right_pv_current THEN 'L'
                WHEN c.right_pv_current < c.left_pv_current THEN 'R'
                WHEN c.left_count < c.right_count THEN 'L'
                WHEN c.right_count < c.left_count THEN 'R'
                ELSE 'L' END,
           w.lvl + 1
      FROM walk w
      JOIN mlm.affiliate c
        ON c.parent_id = w.node_id
       AND c.position = w.side::mlm.tree_position
     WHERE w.lvl < 512
  )
  SELECT node_id, side::mlm.tree_position
    INTO STRICT v_new_parent_id, v_new_position
    FROM walk
   ORDER BY lvl DESC
   LIMIT 1;

  PERFORM pg_advisory_xact_lock(2, v_new_parent_id::int);

  SELECT count(*)
    INTO v_slot_taken
    FROM mlm.affiliate
   WHERE parent_id = v_new_parent_id
     AND position = v_new_position;

  IF v_slot_taken <> 0 THEN
    RAISE EXCEPTION 'Target slot already taken parent=% position=%', v_new_parent_id, v_new_position;
  END IF;

  SELECT p.path || text2ltree(v_new_position::text || '_' || v_blanca_id::text),
         p.depth + 1
    INTO STRICT v_new_path, v_new_depth
    FROM mlm.affiliate p
   WHERE p.id = v_new_parent_id
   FOR UPDATE;

  INSERT INTO _ops_old_ancestors(ancestor_id, leg)
  SELECT c.ancestor_id,
         CASE WHEN substring(ltree2text(subpath(v_old_path, a.depth + 1, 1)) from 1 for 1) = 'L'
              THEN 'L'::mlm.tree_position
              ELSE 'R'::mlm.tree_position
          END
    FROM mlm.affiliate_closure c
    JOIN mlm.affiliate a ON a.id = c.ancestor_id
   WHERE c.descendant_id = v_blanca_id
     AND c.distance > 0;

  UPDATE mlm.affiliate
     SET parent_id = v_new_parent_id,
         position = v_new_position,
         sponsor_id = v_juan_id,
         path = v_new_path,
         depth = v_new_depth,
         updated_at = now()
   WHERE id = v_blanca_id;

  DELETE FROM mlm.affiliate_closure
   WHERE descendant_id = v_blanca_id;

  INSERT INTO mlm.affiliate_closure(ancestor_id, descendant_id, distance)
  VALUES (v_blanca_id, v_blanca_id, 0);

  INSERT INTO mlm.affiliate_closure(ancestor_id, descendant_id, distance)
  SELECT c.ancestor_id, v_blanca_id, c.distance + 1
    FROM mlm.affiliate_closure c
   WHERE c.descendant_id = v_new_parent_id;

  INSERT INTO _ops_new_ancestors(ancestor_id, leg)
  SELECT c.ancestor_id,
         CASE WHEN substring(ltree2text(subpath(v_new_path, a.depth + 1, 1)) from 1 for 1) = 'L'
              THEN 'L'::mlm.tree_position
              ELSE 'R'::mlm.tree_position
          END
    FROM mlm.affiliate_closure c
    JOIN mlm.affiliate a ON a.id = c.ancestor_id
   WHERE c.descendant_id = v_blanca_id
     AND c.distance > 0;

  UPDATE mlm.affiliate a
     SET left_count        = left_count        - CASE WHEN o.leg = 'L' THEN v_enroll_count ELSE 0 END,
         right_count       = right_count       - CASE WHEN o.leg = 'R' THEN v_enroll_count ELSE 0 END,
         left_pv_lifetime  = left_pv_lifetime  - CASE WHEN o.leg = 'L' THEN v_pv_total ELSE 0 END,
         right_pv_lifetime = right_pv_lifetime - CASE WHEN o.leg = 'R' THEN v_pv_total ELSE 0 END,
         left_pv_current   = left_pv_current   - CASE WHEN o.leg = 'L' THEN v_pv_total ELSE 0 END,
         right_pv_current  = right_pv_current  - CASE WHEN o.leg = 'R' THEN v_pv_total ELSE 0 END,
         updated_at = now()
    FROM _ops_old_ancestors o
   WHERE a.id = o.ancestor_id;

  UPDATE mlm.affiliate a
     SET left_count        = left_count        + CASE WHEN n.leg = 'L' THEN v_enroll_count ELSE 0 END,
         right_count       = right_count       + CASE WHEN n.leg = 'R' THEN v_enroll_count ELSE 0 END,
         left_pv_lifetime  = left_pv_lifetime  + CASE WHEN n.leg = 'L' THEN v_pv_total ELSE 0 END,
         right_pv_lifetime = right_pv_lifetime + CASE WHEN n.leg = 'R' THEN v_pv_total ELSE 0 END,
         left_pv_current   = left_pv_current   + CASE WHEN n.leg = 'L' THEN v_pv_total ELSE 0 END,
         right_pv_current  = right_pv_current  + CASE WHEN n.leg = 'R' THEN v_pv_total ELSE 0 END,
         updated_at = now()
    FROM _ops_new_ancestors n
   WHERE a.id = n.ancestor_id;

  IF EXISTS (
    SELECT 1
      FROM mlm.affiliate a
      JOIN (
        SELECT ancestor_id FROM _ops_old_ancestors
        UNION
        SELECT ancestor_id FROM _ops_new_ancestors
      ) x ON x.ancestor_id = a.id
     WHERE left_count < 0
        OR right_count < 0
        OR left_pv_lifetime < 0
        OR right_pv_lifetime < 0
        OR left_pv_current < 0
        OR right_pv_current < 0
  ) THEN
    RAISE EXCEPTION 'Negative aggregate after tree move';
  END IF;

  UPDATE payments.purchase_intent
     SET sponsor_affiliate_id = v_juan_id,
         updated_at = now()
   WHERE id = 'dbe26acb-0c09-4f9b-9bd4-13958784423d'::uuid
     AND affiliate_id = v_blanca_id;

  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
  IF v_updated_rows <> 1 THEN
    RAISE EXCEPTION 'Expected to update exactly one purchase_intent row, updated %', v_updated_rows;
  END IF;

  INSERT INTO mlm.tree_event(external_ref, kind, affiliate_id, payload, occurred_at)
  VALUES (
    'ops:treefix:blanca-marisol:position-move:20260830',
    'position_move',
    v_blanca_id,
    jsonb_build_object(
      'reason', 'Correct sponsor attribution for Blanca Marisol requested by ops',
      'old_parent_id', v_old_parent_id,
      'old_position', v_old_position::text,
      'old_sponsor_id', v_old_sponsor_id,
      'new_parent_id', v_new_parent_id,
      'new_position', v_new_position::text,
      'new_sponsor_id', v_juan_id,
      'pv_moved', v_pv_total,
      'enrollments_moved', v_enroll_count
    ),
    now()
  ) ON CONFLICT (external_ref) DO NOTHING;

  SELECT wm.id, wm.wallet_id, wm.affiliate_id, wm.amount, wm.posted_at, wm.available_at
    INTO STRICT v_old_direct_mov_id, v_old_direct_wallet_id, v_old_direct_affiliate_id,
                v_old_direct_amount, v_direct_posted_at, v_direct_available_at
    FROM mlm.wallet_movement wm
    JOIN mlm.transaction t ON t.id = wm.transaction_id
   WHERE t.external_ref = 'ref:3:14582'
     AND wm.affiliate_id = 117475
     AND wm.concept_id = 1012
     AND wm.amount = 5
   FOR UPDATE OF wm;

  SELECT wm.id, wm.wallet_id, wm.affiliate_id, wm.amount, wm.posted_at, wm.available_at
    INTO STRICT v_old_roy_mov_id, v_old_roy_wallet_id, v_old_roy_affiliate_id,
                v_old_roy_amount, v_roy_posted_at, v_roy_available_at
    FROM mlm.wallet_movement wm
    JOIN mlm.transaction t ON t.id = wm.transaction_id
   WHERE t.external_ref = 'roy:3:14582'
     AND wm.affiliate_id = 93856
     AND wm.concept_id = 1005
     AND wm.amount = 5
   FOR UPDATE OF wm;

  UPDATE mlm.wallet_movement
     SET is_frozen = true
   WHERE id IN (v_old_direct_mov_id, v_old_roy_mov_id);

  SELECT w.id
    INTO v_juan_wallet_id
    FROM mlm.wallet w
    JOIN mlm.asset s ON s.id = w.asset_id
   WHERE w.affiliate_id = v_juan_id
     AND s.symbol = 'USD'
   ORDER BY w.id
   LIMIT 1;

  IF v_juan_wallet_id IS NULL THEN
    INSERT INTO mlm.wallet(affiliate_id, asset_id, address, balance)
    SELECT v_juan_id, id, 'ledger:' || v_juan_id::text, 0
      FROM mlm.asset
     WHERE symbol = 'USD'
     LIMIT 1
    RETURNING id INTO v_juan_wallet_id;
  END IF;

  SELECT sponsor_id
    INTO STRICT v_correct_royalty_affiliate_id
    FROM mlm.affiliate
   WHERE id = v_juan_id;

  IF NOT EXISTS (
    SELECT 1
      FROM mlm.affiliate
     WHERE id = v_correct_royalty_affiliate_id
       AND status = 'active'
       AND parent_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Correct royalty affiliate % is not active/parented', v_correct_royalty_affiliate_id;
  END IF;

  SELECT w.id
    INTO v_correct_royalty_wallet_id
    FROM mlm.wallet w
    JOIN mlm.asset s ON s.id = w.asset_id
   WHERE w.affiliate_id = v_correct_royalty_affiliate_id
     AND s.symbol = 'USD'
   ORDER BY w.id
   LIMIT 1;

  IF v_correct_royalty_wallet_id IS NULL THEN
    INSERT INTO mlm.wallet(affiliate_id, asset_id, address, balance)
    SELECT v_correct_royalty_affiliate_id, id, 'ledger:' || v_correct_royalty_affiliate_id::text, 0
      FROM mlm.asset
     WHERE symbol = 'USD'
     LIMIT 1
    RETURNING id INTO v_correct_royalty_wallet_id;
  END IF;

  INSERT INTO mlm.transaction(external_ref, description, status, posted_at)
  VALUES (
    'ops:treefix:blanca-marisol:debit-direct:20260830',
    'Ops tree fix debit wrong direct bonus Blanca Marisol',
    'posted',
    v_direct_posted_at
  )
  ON CONFLICT (external_ref) DO UPDATE
    SET description = EXCLUDED.description
  RETURNING id INTO v_txn_id;

  INSERT INTO mlm.wallet_movement(
    transaction_id, wallet_id, affiliate_id, concept_id, amount,
    reference, posted_at, available_at, is_frozen
  )
  SELECT v_txn_id, v_old_direct_wallet_id, v_old_direct_affiliate_id, 17, -v_old_direct_amount,
         'Freeze/reverse wrong direct bonus ref:3:14582 for Blanca Marisol tree repair',
         v_direct_posted_at, v_direct_available_at, true
   WHERE NOT EXISTS (
     SELECT 1 FROM mlm.wallet_movement WHERE transaction_id = v_txn_id
   );

  INSERT INTO mlm.transaction(external_ref, description, status, posted_at)
  VALUES (
    'ops:treefix:blanca-marisol:debit-royalty:20260830',
    'Ops tree fix debit wrong royalty Blanca Marisol',
    'posted',
    v_roy_posted_at
  )
  ON CONFLICT (external_ref) DO UPDATE
    SET description = EXCLUDED.description
  RETURNING id INTO v_txn_id;

  INSERT INTO mlm.wallet_movement(
    transaction_id, wallet_id, affiliate_id, concept_id, amount,
    reference, posted_at, available_at, is_frozen
  )
  SELECT v_txn_id, v_old_roy_wallet_id, v_old_roy_affiliate_id, 17, -v_old_roy_amount,
         'Freeze/reverse wrong royalty roy:3:14582 for Blanca Marisol tree repair',
         v_roy_posted_at, v_roy_available_at, true
   WHERE NOT EXISTS (
     SELECT 1 FROM mlm.wallet_movement WHERE transaction_id = v_txn_id
   );

  INSERT INTO mlm.transaction(external_ref, description, status, posted_at)
  VALUES (
    'ops:treefix:blanca-marisol:credit-direct:20260830',
    'Ops tree fix credit correct direct bonus Blanca Marisol',
    'posted',
    v_direct_posted_at
  )
  ON CONFLICT (external_ref) DO UPDATE
    SET description = EXCLUDED.description
  RETURNING id INTO v_txn_id;

  INSERT INTO mlm.wallet_movement(
    transaction_id, wallet_id, affiliate_id, concept_id, amount,
    reference, posted_at, available_at
  )
  SELECT v_txn_id, v_juan_wallet_id, v_juan_id, 1012, v_old_direct_amount,
         'Correct direct bonus for Blanca Marisol sponsor Juan Lopez Martinez',
         v_direct_posted_at, v_direct_available_at
   WHERE NOT EXISTS (
     SELECT 1 FROM mlm.wallet_movement WHERE transaction_id = v_txn_id
   );

  INSERT INTO mlm.transaction(external_ref, description, status, posted_at)
  VALUES (
    'ops:treefix:blanca-marisol:credit-royalty:20260830',
    'Ops tree fix credit correct royalty Blanca Marisol',
    'posted',
    v_roy_posted_at
  )
  ON CONFLICT (external_ref) DO UPDATE
    SET description = EXCLUDED.description
  RETURNING id INTO v_txn_id;

  INSERT INTO mlm.wallet_movement(
    transaction_id, wallet_id, affiliate_id, concept_id, amount,
    reference, posted_at, available_at
  )
  SELECT v_txn_id, v_correct_royalty_wallet_id, v_correct_royalty_affiliate_id, 1005, v_old_roy_amount,
         'Correct royalty for Blanca Marisol via Juan Lopez Martinez sponsor',
         v_roy_posted_at, v_roy_available_at
   WHERE NOT EXISTS (
     SELECT 1 FROM mlm.wallet_movement WHERE transaction_id = v_txn_id
   );

  INSERT INTO audit.activity_log(
    actor_user_id, entity_type, entity_id, action, before_data, after_data
  )
  VALUES (
    NULL,
    'mlm.affiliate',
    v_blanca_id::text,
    'ops_tree_relocation_blanca_marisol',
    jsonb_build_object(
      'parent_id', v_old_parent_id,
      'position', v_old_position::text,
      'sponsor_id', v_old_sponsor_id,
      'path', v_old_path::text,
      'depth', v_old_depth
    ),
    jsonb_build_object(
      'parent_id', v_new_parent_id,
      'position', v_new_position::text,
      'sponsor_id', v_juan_id,
      'path', v_new_path::text,
      'depth', v_new_depth,
      'frozen_wrong_movements', jsonb_build_array(v_old_direct_mov_id, v_old_roy_mov_id),
      'credited_affiliates', jsonb_build_array(v_juan_id, v_correct_royalty_affiliate_id)
    )
  );

  SELECT count(*)
    INTO v_drift_count
    FROM mlm.v_tree_pv_truth v
    JOIN (
      SELECT ancestor_id FROM _ops_old_ancestors
      UNION
      SELECT ancestor_id FROM _ops_new_ancestors
    ) x ON x.ancestor_id = v.id
   WHERE v.materialized_left <> v.computed_left
      OR v.materialized_right <> v.computed_right;

  IF v_drift_count <> 0 THEN
    RAISE EXCEPTION 'Tree PV drift after move for % affected ancestors', v_drift_count;
  END IF;

  WITH affected AS (
    SELECT ancestor_id FROM _ops_old_ancestors
    UNION
    SELECT ancestor_id FROM _ops_new_ancestors
  ), counted AS (
    SELECT x.ancestor_id,
           COALESCE(count(*) FILTER (
             WHERE substring(ltree2text(subpath(d.path, a.depth + 1, 1)) from 1 for 1) = 'L'
           ), 0) AS left_count,
           COALESCE(count(*) FILTER (
             WHERE substring(ltree2text(subpath(d.path, a.depth + 1, 1)) from 1 for 1) = 'R'
           ), 0) AS right_count
      FROM affected x
      JOIN mlm.affiliate a ON a.id = x.ancestor_id
      LEFT JOIN mlm.affiliate_closure c
        ON c.ancestor_id = a.id
       AND c.distance > 0
      LEFT JOIN mlm.affiliate d ON d.id = c.descendant_id
     GROUP BY x.ancestor_id
  )
  SELECT count(*)
    INTO v_count_drift
    FROM counted c
    JOIN mlm.affiliate a ON a.id = c.ancestor_id
   WHERE a.left_count <> c.left_count
      OR a.right_count <> c.right_count;

  IF v_count_drift <> 0 THEN
    RAISE EXCEPTION 'Tree count drift after move for % affected ancestors', v_count_drift;
  END IF;

  INSERT INTO _ops_summary(k, v) VALUES
    ('blanca_id', v_blanca_id::text),
    ('old_sponsor_id', v_old_sponsor_id::text),
    ('new_sponsor_id', v_juan_id::text),
    ('old_parent_id', v_old_parent_id::text),
    ('new_parent_id', v_new_parent_id::text),
    ('new_position', v_new_position::text),
    ('pv_moved', v_pv_total::text),
    ('enrollments_moved', v_enroll_count::text),
    ('old_ancestors', (SELECT count(*)::text FROM _ops_old_ancestors)),
    ('new_ancestors', (SELECT count(*)::text FROM _ops_new_ancestors)),
    ('wrong_direct_frozen_movement', v_old_direct_mov_id::text),
    ('wrong_royalty_frozen_movement', v_old_roy_mov_id::text),
    ('correct_direct_affiliate_id', v_juan_id::text),
    ('correct_royalty_affiliate_id', v_correct_royalty_affiliate_id::text),
    ('tree_pv_drift_after', v_drift_count::text),
    ('tree_count_drift_after', v_count_drift::text);
END $$;

SELECT * FROM _ops_summary ORDER BY k;

COMMIT;

