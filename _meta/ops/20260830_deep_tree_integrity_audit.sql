-- 20260830_deep_tree_integrity_audit.sql
-- Read-only audit for binary tree placement, referral attribution and payment
-- activation integrity. Safe to run in prod with psql.

\set ON_ERROR_STOP on
\pset pager off

SET statement_timeout = '120s';

\echo == 1. Blanca / Juan confirmation ==
WITH blanca AS (
  SELECT a.id AS affiliate_id,
         a.person_id,
         p.email,
         concat_ws(' ', p.first_name, p.last_name) AS name,
         a.sponsor_id,
         a.parent_id,
         a.position::text AS position,
         a.depth,
         a.status::text AS affiliate_status,
         p.status::text AS person_status,
         a.created_at
    FROM mlm.affiliate a
    JOIN mlm.person p ON p.id = a.person_id
   WHERE lower(p.email) = 'bcorado492@gmail.com'
), juan AS (
  SELECT a.id AS affiliate_id,
         p.email,
         concat_ws(' ', p.first_name, p.last_name) AS name,
         a.status::text AS status
    FROM mlm.affiliate a
    JOIN mlm.person p ON p.id = a.person_id
   WHERE lower(p.email) = 'juan0114aguila@gmail.com'
)
SELECT b.affiliate_id AS blanca_affiliate_id,
       b.email AS blanca_email,
       b.name AS blanca_name,
       b.sponsor_id AS blanca_sponsor_id,
       j.affiliate_id AS juan_affiliate_id,
       j.email AS juan_email,
       b.parent_id,
       b.position,
       b.depth,
       EXISTS (
         SELECT 1
           FROM mlm.affiliate_closure c
          WHERE c.ancestor_id = j.affiliate_id
            AND c.descendant_id = b.affiliate_id
       ) AS juan_is_ancestor,
       (
         SELECT c.distance
           FROM mlm.affiliate_closure c
          WHERE c.ancestor_id = j.affiliate_id
            AND c.descendant_id = b.affiliate_id
          LIMIT 1
       ) AS distance_from_juan,
       (
         SELECT count(*)
           FROM mlm.tree_event te
          WHERE te.kind::text = 'position_move'
            AND te.affiliate_id = b.affiliate_id
       ) AS position_move_events
  FROM blanca b
 CROSS JOIN juan j;

\echo == 2. Fast structural checks ==
WITH roots AS (
  SELECT count(*) AS cnt FROM mlm.affiliate WHERE parent_id IS NULL
), duplicate_slots AS (
  SELECT count(*) AS cnt
    FROM (
      SELECT parent_id, position
        FROM mlm.affiliate
       WHERE parent_id IS NOT NULL
       GROUP BY parent_id, position
      HAVING count(*) > 1
    ) d
), orphan_parent AS (
  SELECT count(*) AS cnt
    FROM mlm.affiliate a
   WHERE a.parent_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM mlm.affiliate p WHERE p.id = a.parent_id)
), orphan_sponsor AS (
  SELECT count(*) AS cnt
    FROM mlm.affiliate a
   WHERE a.sponsor_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM mlm.affiliate s WHERE s.id = a.sponsor_id)
), missing_self AS (
  SELECT count(*) AS cnt
    FROM mlm.affiliate a
   WHERE NOT EXISTS (
     SELECT 1
       FROM mlm.affiliate_closure c
      WHERE c.ancestor_id = a.id
        AND c.descendant_id = a.id
        AND c.distance = 0
   )
), duplicate_person_affiliate AS (
  SELECT count(*) AS cnt
    FROM (
      SELECT person_id
        FROM mlm.affiliate
       GROUP BY person_id
      HAVING count(*) > 1
    ) d
), total AS (
  SELECT count(*) AS cnt FROM mlm.affiliate
)
SELECT 'affiliate_total' AS metric, total.cnt::text AS value FROM total
UNION ALL SELECT 'roots', roots.cnt::text FROM roots
UNION ALL SELECT 'duplicate_parent_side_slots', duplicate_slots.cnt::text FROM duplicate_slots
UNION ALL SELECT 'orphan_parent_refs', orphan_parent.cnt::text FROM orphan_parent
UNION ALL SELECT 'orphan_sponsor_refs', orphan_sponsor.cnt::text FROM orphan_sponsor
UNION ALL SELECT 'self_parent_refs', count(*)::text FROM mlm.affiliate WHERE parent_id = id
UNION ALL SELECT 'missing_closure_self_rows', missing_self.cnt::text FROM missing_self
UNION ALL SELECT 'bad_closure_self_distance', count(*)::text FROM mlm.affiliate_closure WHERE ancestor_id = descendant_id AND distance <> 0
UNION ALL SELECT 'persons_with_multiple_affiliates', duplicate_person_affiliate.cnt::text FROM duplicate_person_affiliate
ORDER BY metric;

\echo == 3. Recursive reachability and depth ==
WITH RECURSIVE walk AS (
  SELECT a.id,
         a.parent_id,
         a.depth,
         ARRAY[a.id] AS path_ids,
         false AS cycle,
         0 AS computed_depth
    FROM mlm.affiliate a
   WHERE a.parent_id IS NULL
  UNION ALL
  SELECT c.id,
         c.parent_id,
         c.depth,
         w.path_ids || c.id,
         c.id = ANY(w.path_ids),
         w.computed_depth + 1
    FROM walk w
    JOIN mlm.affiliate c ON c.parent_id = w.id
   WHERE NOT w.cycle
     AND w.computed_depth < 1024
), stats AS (
  SELECT count(DISTINCT id) AS reachable,
         count(*) FILTER (WHERE cycle) AS cycle_rows,
         count(*) FILTER (WHERE computed_depth >= 1024) AS depth_guard_rows,
         count(*) FILTER (WHERE depth <> computed_depth) AS depth_drift_rows,
         max(computed_depth) AS max_computed_depth
    FROM walk
), totals AS (
  SELECT count(*) AS total FROM mlm.affiliate
)
SELECT 'reachable_from_roots' AS metric, reachable::text AS value FROM stats
UNION ALL SELECT 'unreachable_from_roots', (total - reachable)::text FROM stats CROSS JOIN totals
UNION ALL SELECT 'cycle_rows_reached_from_roots', cycle_rows::text FROM stats
UNION ALL SELECT 'depth_guard_rows_1024', depth_guard_rows::text FROM stats
UNION ALL SELECT 'depth_drift_rows', depth_drift_rows::text FROM stats
UNION ALL SELECT 'max_computed_depth', max_computed_depth::text FROM stats;

\echo == 4. New payment placements health ==
WITH new_by_payment AS (
  SELECT pi.id,
         pi.created_at,
         pi.activated_at,
         pi.user_id,
         pi.person_id,
         p.email AS person_email,
         pi.affiliate_id,
         a.created_at AS affiliate_created_at,
         a.sponsor_id AS actual_sponsor_id,
         pi.sponsor_affiliate_id,
         a.parent_id,
         a.position::text AS position,
         a.depth,
         pi.stripe_payment_intent_id,
         pi.package_id,
         pi.pv,
         EXISTS (
           SELECT 1
             FROM mlm.affiliate_closure c
            WHERE c.ancestor_id = pi.sponsor_affiliate_id
              AND c.descendant_id = pi.affiliate_id
         ) AS sponsor_is_ancestor,
         EXISTS (
           SELECT 1
             FROM mlm.tree_event te
            WHERE te.external_ref = 'enroll:' || pi.affiliate_id::text
              AND te.kind::text = 'enrollment'
         ) AS has_enroll_event,
         EXISTS (
           SELECT 1
             FROM mlm.tree_event te
            WHERE te.external_ref = 'package_purchase:' || pi.stripe_payment_intent_id
              AND te.kind::text = 'pv_credit'
         ) AS has_pv_event,
         EXISTS (
           SELECT 1
             FROM mlm.affiliate_package ap
            WHERE ap.affiliate_id = pi.affiliate_id
              AND ap.transaction_hash = pi.stripe_payment_intent_id
              AND ap.status::text = 'active'
         ) AS has_active_package
    FROM payments.purchase_intent pi
    JOIN mlm.person p ON p.id = pi.person_id
    JOIN mlm.affiliate a ON a.id = pi.affiliate_id
   WHERE pi.status = 'activated'
     AND pi.affiliate_id IS NOT NULL
     AND a.created_at BETWEEN pi.created_at - interval '10 minutes'
                          AND COALESCE(pi.activated_at, pi.paid_at, pi.updated_at, pi.created_at) + interval '10 minutes'
)
SELECT 'new_by_payment_total' AS metric, count(*)::text AS value FROM new_by_payment
UNION ALL SELECT 'identity_mismatch', count(*)::text FROM new_by_payment WHERE lower(trim(user_id)) <> lower(trim(person_email))
UNION ALL SELECT 'sponsor_mismatch', count(*)::text FROM new_by_payment WHERE sponsor_affiliate_id IS NOT NULL AND sponsor_affiliate_id <> actual_sponsor_id
UNION ALL SELECT 'sponsor_not_ancestor', count(*)::text FROM new_by_payment WHERE sponsor_affiliate_id IS NOT NULL AND NOT sponsor_is_ancestor
UNION ALL SELECT 'missing_enrollment_event', count(*)::text FROM new_by_payment WHERE NOT has_enroll_event
UNION ALL SELECT 'missing_pv_event', count(*)::text FROM new_by_payment WHERE NOT has_pv_event
UNION ALL SELECT 'missing_active_package', count(*)::text FROM new_by_payment WHERE NOT has_active_package
ORDER BY metric;

\echo == 5. Payment activation summary ==
WITH activated AS (
  SELECT pi.*,
         p.email AS person_email,
         a.created_at AS affiliate_created_at,
         a.person_id AS affiliate_person_id,
         a.sponsor_id AS actual_sponsor_id,
         EXISTS (
           SELECT 1
             FROM mlm.affiliate_closure c
            WHERE c.ancestor_id = pi.sponsor_affiliate_id
              AND c.descendant_id = pi.affiliate_id
         ) AS intent_sponsor_is_ancestor,
         EXISTS (
           SELECT 1
             FROM mlm.affiliate_closure c
            WHERE c.ancestor_id = a.sponsor_id
              AND c.descendant_id = a.id
         ) AS actual_sponsor_is_ancestor
    FROM payments.purchase_intent pi
    LEFT JOIN mlm.person p ON p.id = pi.person_id
    LEFT JOIN mlm.affiliate a ON a.id = pi.affiliate_id
   WHERE pi.status IN ('paid', 'activated', 'needs_placement')
), successful AS (
  SELECT *
    FROM payments.purchase_intent
   WHERE status = 'activated'
     AND stripe_payment_intent_id IS NOT NULL
     AND stripe_present IS DISTINCT FROM false
), failed_blocked AS (
  SELECT *
    FROM payments.purchase_intent
   WHERE status IN ('failed', 'expired', 'security_blocked', 'disputed', 'chargeback')
     AND stripe_payment_intent_id IS NOT NULL
     AND stripe_present IS DISTINCT FROM false
)
SELECT 'money_received_intents' AS metric, count(*)::text AS value FROM activated
UNION ALL SELECT 'activated_intents', count(*)::text FROM activated WHERE status = 'activated'
UNION ALL SELECT 'paid_not_activated', count(*)::text FROM activated WHERE status = 'paid'
UNION ALL SELECT 'needs_placement', count(*)::text FROM activated WHERE status = 'needs_placement'
UNION ALL SELECT 'money_received_missing_affiliate', count(*)::text FROM activated WHERE affiliate_id IS NULL
UNION ALL SELECT 'activated_with_affiliate_person_mismatch', count(*)::text FROM activated WHERE affiliate_id IS NOT NULL AND person_id IS NOT NULL AND affiliate_person_id IS NOT NULL AND person_id <> affiliate_person_id
UNION ALL SELECT 'activated_user_email_mismatch_person_email', count(*)::text FROM activated WHERE person_email IS NOT NULL AND lower(trim(user_id)) <> lower(trim(person_email))
UNION ALL SELECT 'activated_intent_sponsor_mismatch_current_affiliate', count(*)::text FROM activated WHERE sponsor_affiliate_id IS NOT NULL AND actual_sponsor_id IS NOT NULL AND sponsor_affiliate_id <> actual_sponsor_id
UNION ALL SELECT 'activated_intent_sponsor_not_ancestor_current_affiliate', count(*)::text FROM activated WHERE status = 'activated' AND sponsor_affiliate_id IS NOT NULL AND affiliate_id IS NOT NULL AND NOT intent_sponsor_is_ancestor
UNION ALL SELECT 'activated_actual_sponsor_not_ancestor_current_affiliate', count(*)::text FROM activated WHERE status = 'activated' AND actual_sponsor_id IS NOT NULL AND affiliate_id IS NOT NULL AND NOT actual_sponsor_is_ancestor
UNION ALL SELECT 'live_successful_activated', count(*)::text FROM successful
UNION ALL SELECT 'live_successful_without_pv_event', count(*)::text FROM successful s WHERE NOT EXISTS (SELECT 1 FROM mlm.tree_event te WHERE te.external_ref = 'package_purchase:' || s.stripe_payment_intent_id AND te.kind::text = 'pv_credit')
UNION ALL SELECT 'live_successful_without_affiliate_package', count(*)::text FROM successful s WHERE NOT EXISTS (SELECT 1 FROM mlm.affiliate_package ap WHERE ap.purchase_txn_id = s.id OR ap.transaction_hash = s.stripe_payment_intent_id)
UNION ALL SELECT 'live_failed_blocked_with_pv_event', count(*)::text FROM failed_blocked f WHERE EXISTS (SELECT 1 FROM mlm.tree_event te WHERE te.external_ref = 'package_purchase:' || f.stripe_payment_intent_id)
UNION ALL SELECT 'live_failed_blocked_with_affiliate_package', count(*)::text FROM failed_blocked f WHERE EXISTS (SELECT 1 FROM mlm.affiliate_package ap WHERE ap.purchase_txn_id = f.id OR ap.transaction_hash = f.stripe_payment_intent_id)
ORDER BY metric;

\echo == 6. Identity mismatch sample ==
SELECT pi.id AS intent_id,
       pi.created_at,
       pi.activated_at,
       pi.status,
       pi.user_id,
       pi.person_id AS intent_person_id,
       p.email AS intent_person_email,
       pi.affiliate_id,
       a.person_id AS affiliate_person_id,
       ap.email AS affiliate_person_email,
       concat_ws(' ', ap.first_name, ap.last_name) AS affiliate_person_name,
       pi.sponsor_affiliate_id,
       pi.referral_code,
       pi.stripe_present
  FROM payments.purchase_intent pi
  LEFT JOIN mlm.person p ON p.id = pi.person_id
  LEFT JOIN mlm.affiliate a ON a.id = pi.affiliate_id
  LEFT JOIN mlm.person ap ON ap.id = a.person_id
 WHERE pi.status IN ('activated', 'paid', 'needs_placement')
   AND (
        (pi.affiliate_id IS NOT NULL AND pi.person_id IS NOT NULL AND a.person_id IS NOT NULL AND pi.person_id <> a.person_id)
        OR (p.email IS NOT NULL AND lower(trim(pi.user_id)) <> lower(trim(p.email)))
   )
 ORDER BY COALESCE(pi.activated_at, pi.paid_at, pi.created_at) DESC
 LIMIT 50;

\echo == 7. Historical sponsor not ancestor ==
SELECT count(*) AS total_active_sponsor_not_ancestor,
       min(a.created_at) AS oldest_affiliate_created_at,
       max(a.created_at) AS newest_affiliate_created_at
  FROM mlm.affiliate a
  JOIN mlm.person p ON p.id = a.person_id
 WHERE a.sponsor_id IS NOT NULL
   AND a.status::text = 'active'
   AND p.status::text = 'active'
   AND NOT EXISTS (
     SELECT 1
       FROM mlm.affiliate_closure c
      WHERE c.ancestor_id = a.sponsor_id
        AND c.descendant_id = a.id
   );

\echo == 8. Activated sponsor not ancestor sample ==
SELECT pi.id AS intent_id,
       pi.created_at,
       pi.activated_at,
       pi.user_id,
       p.email AS person_email,
       concat_ws(' ', p.first_name, p.last_name) AS person_name,
       pi.affiliate_id,
       pi.sponsor_affiliate_id AS intent_sponsor_id,
       isp.email AS intent_sponsor_email,
       concat_ws(' ', isp.first_name, isp.last_name) AS intent_sponsor_name,
       a.sponsor_id AS actual_sponsor_id,
       asp.email AS actual_sponsor_email,
       concat_ws(' ', asp.first_name, asp.last_name) AS actual_sponsor_name,
       a.parent_id,
       pp.email AS parent_email,
       concat_ws(' ', pp.first_name, pp.last_name) AS parent_name,
       a.position::text AS position,
       a.depth,
       a.created_at AS affiliate_created_at,
       EXISTS (
         SELECT 1
           FROM mlm.tree_event te
          WHERE te.external_ref = 'enroll:' || pi.affiliate_id::text
            AND te.kind::text = 'enrollment'
            AND te.occurred_at BETWEEN pi.created_at - interval '10 minutes'
                                   AND COALESCE(pi.activated_at, pi.paid_at, pi.updated_at, pi.created_at) + interval '10 minutes'
       ) AS new_activation_window
  FROM payments.purchase_intent pi
  JOIN mlm.person p ON p.id = pi.person_id
  LEFT JOIN mlm.affiliate a ON a.id = pi.affiliate_id
  LEFT JOIN mlm.affiliate ispa ON ispa.id = pi.sponsor_affiliate_id
  LEFT JOIN mlm.person isp ON isp.id = ispa.person_id
  LEFT JOIN mlm.affiliate aspa ON aspa.id = a.sponsor_id
  LEFT JOIN mlm.person asp ON asp.id = aspa.person_id
  LEFT JOIN mlm.affiliate par ON par.id = a.parent_id
  LEFT JOIN mlm.person pp ON pp.id = par.person_id
 WHERE pi.status = 'activated'
   AND pi.sponsor_affiliate_id IS NOT NULL
   AND pi.affiliate_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM mlm.affiliate_closure c
      WHERE c.ancestor_id = pi.sponsor_affiliate_id
        AND c.descendant_id = pi.affiliate_id
   )
 ORDER BY COALESCE(pi.activated_at, pi.paid_at, pi.created_at) DESC
 LIMIT 50;

\echo == 9. Referral code uniqueness ==
WITH codes AS (
  SELECT pi.id,
         pi.created_at,
         pi.status,
         pi.user_id,
         pi.referral_code,
         pi.sponsor_affiliate_id,
         sa.id AS resolved_sponsor_id
    FROM payments.purchase_intent pi
    LEFT JOIN mlm.affiliate sa ON lower(sa.invitation_link) = lower(trim(pi.referral_code))
   WHERE pi.referral_code IS NOT NULL
     AND trim(pi.referral_code) <> ''
)
SELECT 'intents_with_referral_code' AS metric, count(*)::text AS value FROM codes
UNION ALL SELECT 'referral_code_unresolved', count(*)::text FROM codes WHERE resolved_sponsor_id IS NULL
UNION ALL SELECT 'referral_code_resolved_but_mismatch_intent_sponsor', count(*)::text FROM codes WHERE resolved_sponsor_id IS NOT NULL AND sponsor_affiliate_id IS NOT NULL AND resolved_sponsor_id <> sponsor_affiliate_id
UNION ALL SELECT 'referral_code_missing_intent_sponsor', count(*)::text FROM codes WHERE sponsor_affiliate_id IS NULL
UNION ALL SELECT 'case_insensitive_duplicate_invitation_codes', count(*)::text FROM (
  SELECT lower(invitation_link) AS code
    FROM mlm.affiliate
   WHERE invitation_link IS NOT NULL
     AND trim(invitation_link) <> ''
   GROUP BY lower(invitation_link)
  HAVING count(*) > 1
) d
ORDER BY metric;

\echo == 10. Duplicate invitation code sample ==
SELECT lower(invitation_link) AS code,
       count(*) AS copies,
       string_agg(a.id::text || ':' || p.email || ':' || a.status::text, ', ' ORDER BY a.id) AS affiliates
  FROM mlm.affiliate a
  JOIN mlm.person p ON p.id = a.person_id
 WHERE invitation_link IS NOT NULL
   AND trim(invitation_link) <> ''
 GROUP BY lower(invitation_link)
HAVING count(*) > 1
 ORDER BY copies DESC, code
 LIMIT 50;
