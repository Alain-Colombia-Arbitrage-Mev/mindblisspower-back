-- 20260901_referral_prevention_guard.sql
--
-- Read-only guardrail audit for referral attribution and binary placement.
-- Run after deploys and daily while sponsor attribution is being monitored.
--
-- Usage:
--   psql "$MIGRATOR_DATABASE_URL" -f _meta/ops/20260901_referral_prevention_guard.sql

\set ON_ERROR_STOP on
\pset pager off

SET statement_timeout = '90s';

\echo == 1. Referral prevention guard metrics ==
WITH active_sponsor AS (
  SELECT a.id
    FROM mlm.affiliate a
    JOIN mlm.person p ON p.id = a.person_id
   WHERE a.status::text = 'active'
     AND p.status::text = 'active'
     AND NOT COALESCE(p.blacklisted,false)
), active_affiliate AS (
  SELECT a.id, a.person_id, a.sponsor_id, a.parent_id, a.position, a.created_at, a.status::text AS affiliate_status,
         p.email, p.status::text AS person_status, COALESCE(p.blacklisted,false) AS blacklisted,
         a.legacy_id_vicionario
    FROM mlm.affiliate a
    JOIN mlm.person p ON p.id = a.person_id
   WHERE a.status::text = 'active'
     AND p.status::text = 'active'
     AND NOT COALESCE(p.blacklisted,false)
), new_payment_affiliate AS (
  SELECT pi.id AS intent_id, pi.user_id, pi.person_id, pi.affiliate_id, pi.sponsor_affiliate_id, pi.referral_code,
         pi.created_at, pi.paid_at, pi.activated_at, pi.status,
         a.created_at AS affiliate_created_at, a.sponsor_id AS actual_sponsor_id, a.legacy_id_vicionario,
         EXISTS (
           SELECT 1
             FROM mlm.tree_event te
            WHERE te.external_ref = 'enroll:' || pi.affiliate_id::text
              AND te.kind::text = 'enrollment'
         ) AS has_enroll_event,
         EXISTS (
           SELECT 1
             FROM mlm.affiliate_closure c
            WHERE c.ancestor_id = pi.sponsor_affiliate_id
              AND c.descendant_id = pi.affiliate_id
         ) AS intent_sponsor_is_ancestor
    FROM payments.purchase_intent pi
    JOIN mlm.affiliate a ON a.id = pi.affiliate_id
   WHERE pi.status = 'activated'
     AND pi.affiliate_id IS NOT NULL
     AND (
       a.created_at BETWEEN pi.created_at - interval '10 minutes'
                        AND COALESCE(pi.activated_at, pi.paid_at, pi.updated_at, pi.created_at) + interval '10 minutes'
       OR EXISTS (
         SELECT 1
           FROM mlm.tree_event te
          WHERE te.external_ref = 'enroll:' || pi.affiliate_id::text
            AND te.kind::text = 'enrollment'
       )
     )
)
SELECT 'registration_referral_total' AS metric, count(*)::text AS value
  FROM payments.registration_referral
UNION ALL
SELECT 'registration_referral_open_30d', count(*)::text
  FROM payments.registration_referral
 WHERE consumed_at IS NULL
   AND updated_at >= now() - interval '30 days'
UNION ALL
SELECT 'registration_referral_open_30d_ineligible_sponsor', count(*)::text
  FROM payments.registration_referral rr
 WHERE rr.consumed_at IS NULL
   AND rr.updated_at >= now() - interval '30 days'
   AND NOT EXISTS (SELECT 1 FROM active_sponsor s WHERE s.id = rr.sponsor_affiliate_id)
UNION ALL
SELECT 'purchase_intent_live_ineligible_sponsor', count(*)::text
  FROM payments.purchase_intent pi
 WHERE pi.status IN ('created','paid','activated','needs_placement')
   AND pi.sponsor_affiliate_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM active_sponsor s WHERE s.id = pi.sponsor_affiliate_id)
UNION ALL
SELECT 'active_affiliate_missing_sponsor', count(*)::text
  FROM active_affiliate a
 WHERE a.parent_id IS NOT NULL
   AND a.sponsor_id IS NULL
UNION ALL
SELECT 'active_affiliate_ineligible_sponsor', count(*)::text
  FROM active_affiliate a
 WHERE a.sponsor_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM active_sponsor s WHERE s.id = a.sponsor_id)
UNION ALL
SELECT 'active_affiliate_sponsor_not_ancestor', count(*)::text
  FROM active_affiliate a
 WHERE a.sponsor_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM mlm.affiliate_closure c
      WHERE c.ancestor_id = a.sponsor_id
        AND c.descendant_id = a.id
   )
UNION ALL
SELECT 'new_payment_nonlegacy_sponsor_not_ancestor', count(*)::text
  FROM new_payment_affiliate n
 WHERE n.legacy_id_vicionario IS NULL
   AND n.sponsor_affiliate_id IS NOT NULL
   AND NOT n.intent_sponsor_is_ancestor
UNION ALL
SELECT 'tree_duplicate_parent_side_slots', count(*)::text
  FROM (
    SELECT parent_id, position
      FROM mlm.affiliate
     WHERE parent_id IS NOT NULL
     GROUP BY parent_id, position
    HAVING count(*) > 1
  ) d
UNION ALL
SELECT 'persons_with_multiple_affiliates', count(*)::text
  FROM (
    SELECT person_id
      FROM mlm.affiliate
     GROUP BY person_id
    HAVING count(*) > 1
  ) d
UNION ALL
SELECT 'tree_closure_missing_self_rows', count(*)::text
  FROM mlm.affiliate a
 WHERE NOT EXISTS (
   SELECT 1
     FROM mlm.affiliate_closure c
    WHERE c.ancestor_id = a.id
      AND c.descendant_id = a.id
      AND c.distance = 0
 )
ORDER BY metric;

\echo == 2. Open registration referrals with ineligible sponsor ==
SELECT rr.email_norm,
       rr.referral_code,
       rr.sponsor_affiliate_id,
       sp.email AS sponsor_email,
       sa.status::text AS sponsor_affiliate_status,
       sp.status::text AS sponsor_person_status,
       COALESCE(sp.blacklisted,false) AS sponsor_blacklisted,
       rr.updated_at
  FROM payments.registration_referral rr
  LEFT JOIN mlm.affiliate sa ON sa.id = rr.sponsor_affiliate_id
  LEFT JOIN mlm.person sp ON sp.id = sa.person_id
 WHERE rr.consumed_at IS NULL
   AND rr.updated_at >= now() - interval '30 days'
   AND NOT EXISTS (
     SELECT 1
       FROM mlm.affiliate a
       JOIN mlm.person p ON p.id = a.person_id
      WHERE a.id = rr.sponsor_affiliate_id
        AND a.status::text = 'active'
        AND p.status::text = 'active'
        AND NOT COALESCE(p.blacklisted,false)
   )
 ORDER BY rr.updated_at DESC
 LIMIT 100;

\echo == 3. Recent nonlegacy payment placements outside sponsor subtree ==
SELECT n.intent_id,
       n.created_at,
       n.activated_at,
       n.user_id,
       bp.email AS buyer_email,
       n.affiliate_id,
       n.sponsor_affiliate_id AS intent_sponsor_id,
       isp.email AS intent_sponsor_email,
       n.actual_sponsor_id,
       asp.email AS actual_sponsor_email,
       n.referral_code
  FROM new_payment_affiliate n
  JOIN mlm.person bp ON bp.id = n.person_id
  LEFT JOIN mlm.affiliate isa ON isa.id = n.sponsor_affiliate_id
  LEFT JOIN mlm.person isp ON isp.id = isa.person_id
  LEFT JOIN mlm.affiliate asa ON asa.id = n.actual_sponsor_id
  LEFT JOIN mlm.person asp ON asp.id = asa.person_id
 WHERE n.legacy_id_vicionario IS NULL
   AND n.sponsor_affiliate_id IS NOT NULL
   AND NOT n.intent_sponsor_is_ancestor
 ORDER BY COALESCE(n.activated_at, n.paid_at, n.created_at) DESC
 LIMIT 100;
