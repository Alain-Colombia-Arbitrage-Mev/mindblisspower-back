-- 20260901_repair_reynaldo_sanchez_under_tiburcio.sql
--
-- Purpose:
--   Repair Reynaldo Sanchez (ereynaldosanchez@gmail.com) so his direct sponsor
--   is Tiburcio Hernandez Ramos (tibhern@gmail.com), and place the leaf node in
--   Tiburcio's weak-leg slot using the same production auto-placement rule.
--
-- Safety:
--   - leaf-only move; aborts if Reynaldo has descendants.
--   - checks expected affiliate ids, old sponsor, purchase intent and PV totals.
--   - uses advisory locks around old sponsor, new sponsor, Reynaldo and target
--     parent.
--   - rebuilds closure rows for the moved leaf.
--   - validates materialized PV/count drift for all affected ancestors.

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
  v_reynaldo_id bigint;
  v_reynaldo_person_id bigint;
  v_old_parent_id bigint;
  v_old_position mlm.tree_position;
  v_old_sponsor_id bigint;
  v_old_path ltree;
  v_old_depth int;
  v_tiburcio_id bigint;
  v_new_parent_id bigint;
  v_new_position mlm.tree_position;
  v_new_path ltree;
  v_new_depth int;
  v_desc_count bigint;
  v_slot_taken bigint;
  v_pv_total numeric(20,2);
  v_enroll_count int;
  v_updated_rows bigint;
  v_drift_count bigint;
  v_count_drift bigint;
BEGIN
  SELECT a.id, a.person_id, a.parent_id, a.position, a.sponsor_id, a.path, a.depth
    INTO STRICT v_reynaldo_id, v_reynaldo_person_id, v_old_parent_id, v_old_position,
                v_old_sponsor_id, v_old_path, v_old_depth
    FROM mlm.person p
    JOIN mlm.affiliate a ON a.person_id = p.id
   WHERE lower(p.email::text) = 'ereynaldosanchez@gmail.com'
   FOR UPDATE OF a;

  SELECT a.id
    INTO STRICT v_tiburcio_id
    FROM mlm.person p
    JOIN mlm.affiliate a ON a.person_id = p.id
   WHERE lower(p.email::text) = 'tibhern@gmail.com'
   FOR UPDATE OF a;

  IF v_reynaldo_id <> 121530 THEN
    RAISE EXCEPTION 'Unexpected Reynaldo affiliate id: %', v_reynaldo_id;
  END IF;
  IF v_reynaldo_person_id <> 121146 THEN
    RAISE EXCEPTION 'Unexpected Reynaldo person id: %', v_reynaldo_person_id;
  END IF;
  IF v_tiburcio_id <> 110763 THEN
    RAISE EXCEPTION 'Unexpected Tiburcio affiliate id: %', v_tiburcio_id;
  END IF;
  IF v_old_sponsor_id <> 117475 THEN
    RAISE EXCEPTION 'Unexpected old sponsor id: %', v_old_sponsor_id;
  END IF;

  PERFORM pg_advisory_xact_lock(2, v_old_sponsor_id::int);
  PERFORM pg_advisory_xact_lock(2, v_tiburcio_id::int);
  PERFORM pg_advisory_xact_lock(2, v_reynaldo_id::int);

  SELECT count(*)
    INTO v_desc_count
    FROM mlm.affiliate_closure
   WHERE ancestor_id = v_reynaldo_id
     AND distance > 0;

  IF v_desc_count <> 0 THEN
    RAISE EXCEPTION 'Reynaldo has % descendants; subtree move required', v_desc_count;
  END IF;

  SELECT COALESCE(SUM(pv_delta_left + pv_delta_right), 0),
         count(*) FILTER (WHERE kind = 'enrollment')::int
    INTO v_pv_total, v_enroll_count
    FROM mlm.tree_event
   WHERE affiliate_id = v_reynaldo_id;

  IF v_pv_total <> 500 OR v_enroll_count <> 1 THEN
    RAISE EXCEPTION 'Unexpected Reynaldo event totals pv=% enrollment=%', v_pv_total, v_enroll_count;
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
     WHERE a.id = v_tiburcio_id
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

  SELECT p.path || text2ltree(v_new_position::text || '_' || v_reynaldo_id::text),
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
   WHERE c.descendant_id = v_reynaldo_id
     AND c.distance > 0;

  UPDATE mlm.affiliate
     SET parent_id = v_new_parent_id,
         position = v_new_position,
         sponsor_id = v_tiburcio_id,
         path = v_new_path,
         depth = v_new_depth,
         updated_at = now()
   WHERE id = v_reynaldo_id;

  DELETE FROM mlm.affiliate_closure
   WHERE descendant_id = v_reynaldo_id;

  INSERT INTO mlm.affiliate_closure(ancestor_id, descendant_id, distance)
  VALUES (v_reynaldo_id, v_reynaldo_id, 0);

  INSERT INTO mlm.affiliate_closure(ancestor_id, descendant_id, distance)
  SELECT c.ancestor_id, v_reynaldo_id, c.distance + 1
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
   WHERE c.descendant_id = v_reynaldo_id
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
     SET sponsor_affiliate_id = v_tiburcio_id,
         referral_code = 'tiburcio65',
         updated_at = now()
   WHERE id = '108923c3-520f-44d3-b11c-30111c78b2b8'::uuid
     AND affiliate_id = v_reynaldo_id
     AND person_id = v_reynaldo_person_id;

  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
  IF v_updated_rows <> 1 THEN
    RAISE EXCEPTION 'Expected to update exactly one purchase_intent row, updated %', v_updated_rows;
  END IF;

  INSERT INTO payments.registration_referral(email_norm, referral_code, sponsor_affiliate_id, source, created_at, updated_at, consumed_at)
  VALUES ('ereynaldosanchez@gmail.com', 'tiburcio65', v_tiburcio_id, 'ops_repair', now(), now(), now())
  ON CONFLICT (email_norm) DO UPDATE SET
    referral_code = EXCLUDED.referral_code,
    sponsor_affiliate_id = EXCLUDED.sponsor_affiliate_id,
    source = EXCLUDED.source,
    updated_at = now(),
    consumed_at = now();

  INSERT INTO mlm.tree_event(external_ref, kind, affiliate_id, payload, occurred_at)
  VALUES (
    'ops:treefix:reynaldo-sanchez:tiburcio:20260901',
    'position_move',
    v_reynaldo_id,
    jsonb_build_object(
      'reason', 'Correct sponsor attribution for Reynaldo Sanchez requested by ops',
      'old_parent_id', v_old_parent_id,
      'old_position', v_old_position::text,
      'old_sponsor_id', v_old_sponsor_id,
      'new_parent_id', v_new_parent_id,
      'new_position', v_new_position::text,
      'new_sponsor_id', v_tiburcio_id,
      'pv_moved', v_pv_total,
      'enrollments_moved', v_enroll_count,
      'purchase_intent_id', '108923c3-520f-44d3-b11c-30111c78b2b8'
    ),
    now()
  ) ON CONFLICT (external_ref) DO NOTHING;

  INSERT INTO audit.activity_log(
    actor_user_id, entity_type, entity_id, action, before_data, after_data
  )
  VALUES (
    NULL,
    'mlm.affiliate',
    v_reynaldo_id::text,
    'ops_tree_relocation_reynaldo_sanchez',
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
      'sponsor_id', v_tiburcio_id,
      'path', v_new_path::text,
      'depth', v_new_depth,
      'purchase_intent_id', '108923c3-520f-44d3-b11c-30111c78b2b8'
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
    ('reynaldo_id', v_reynaldo_id::text),
    ('old_sponsor_id', v_old_sponsor_id::text),
    ('new_sponsor_id', v_tiburcio_id::text),
    ('old_parent_id', v_old_parent_id::text),
    ('new_parent_id', v_new_parent_id::text),
    ('new_position', v_new_position::text),
    ('pv_moved', v_pv_total::text),
    ('enrollments_moved', v_enroll_count::text),
    ('old_ancestors', (SELECT count(*)::text FROM _ops_old_ancestors)),
    ('new_ancestors', (SELECT count(*)::text FROM _ops_new_ancestors)),
    ('tree_pv_drift_after', v_drift_count::text),
    ('tree_count_drift_after', v_count_drift::text);
END $$;

SELECT * FROM _ops_summary ORDER BY k;

COMMIT;
