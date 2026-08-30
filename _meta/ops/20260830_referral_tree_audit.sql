-- 20260830_referral_tree_audit.sql
--
-- Read-only audit for referral attribution and binary-tree placement.
--
-- Usage:
--   psql "$MIGRATOR_DATABASE_URL" -v sponsor_email='juan0114aguila@gmail.com' \
--     -f _meta/ops/20260830_referral_tree_audit.sql
--
-- Rule: sponsor_id is the commercial referrer. parent_id/position is the binary
-- spillover slot. They can differ, but a new auto-placement should be inside
-- the sponsor subtree.

\pset pager off
\set ON_ERROR_STOP on

\if :{?sponsor_email}
\else
\set sponsor_email 'juan0114aguila@gmail.com'
\endif

SET statement_timeout = '30s';

\echo == 1. Schema readiness ==
SELECT EXISTS (
  SELECT 1
    FROM information_schema.columns
   WHERE table_schema = 'payments'
     AND table_name = 'purchase_intent'
     AND column_name = 'referral_code'
) AS purchase_intent_has_referral_code;

\echo == 2. Fast integrity counts ==
WITH activated AS (
  SELECT pi.*,
         a.sponsor_id AS actual_sponsor_id,
         a.created_at AS affiliate_created_at,
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
         ) AS intent_sponsor_is_ancestor,
         EXISTS (
           SELECT 1
             FROM mlm.affiliate_closure c
            WHERE c.ancestor_id = a.sponsor_id
              AND c.descendant_id = a.id
         ) AS actual_sponsor_is_ancestor
    FROM payments.purchase_intent pi
    LEFT JOIN mlm.affiliate a ON a.id = pi.affiliate_id
   WHERE pi.status IN ('activated', 'paid', 'needs_placement')
), new_by_payment AS (
  SELECT *
    FROM activated
   WHERE affiliate_id IS NOT NULL
     AND (
       affiliate_created_at BETWEEN created_at - interval '10 minutes'
                                AND COALESCE(activated_at, paid_at, created_at) + interval '10 minutes'
       OR has_enroll_event
     )
)
SELECT 'activated_intents' AS metric, count(*)::text AS value FROM activated
UNION ALL
SELECT 'activated_intents_missing_affiliate', count(*)::text FROM activated WHERE affiliate_id IS NULL
UNION ALL
SELECT 'activated_intent_sponsor_mismatch', count(*)::text
  FROM activated
 WHERE sponsor_affiliate_id IS NOT NULL
   AND actual_sponsor_id IS NOT NULL
   AND sponsor_affiliate_id <> actual_sponsor_id
UNION ALL
SELECT 'new_by_payment_or_enroll_event', count(*)::text FROM new_by_payment
UNION ALL
SELECT 'new_by_payment_sponsor_mismatch', count(*)::text
  FROM new_by_payment
 WHERE sponsor_affiliate_id IS NOT NULL
   AND actual_sponsor_id IS NOT NULL
   AND sponsor_affiliate_id <> actual_sponsor_id
UNION ALL
SELECT 'new_by_payment_sponsor_not_ancestor', count(*)::text
  FROM new_by_payment
 WHERE sponsor_affiliate_id IS NOT NULL
   AND NOT intent_sponsor_is_ancestor
UNION ALL
SELECT 'active_affiliates_sponsor_not_ancestor_historical', count(*)::text
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
   )
UNION ALL
SELECT 'successful_payments_without_pv_event', count(*)::text
  FROM payments.purchase_intent pi
 WHERE pi.status = 'activated'
   AND pi.stripe_payment_intent_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM mlm.tree_event te
      WHERE te.external_ref = 'package_purchase:' || pi.stripe_payment_intent_id
   )
UNION ALL
SELECT 'failed_or_blocked_with_pv_event', count(*)::text
  FROM payments.purchase_intent pi
 WHERE pi.status IN ('failed', 'expired', 'security_blocked', 'disputed', 'chargeback')
   AND pi.stripe_payment_intent_id IS NOT NULL
   AND EXISTS (
     SELECT 1
       FROM mlm.tree_event te
      WHERE te.external_ref = 'package_purchase:' || pi.stripe_payment_intent_id
   )
UNION ALL
SELECT 'tree_duplicate_parent_side', count(*)::text
  FROM (
    SELECT parent_id, position
      FROM mlm.affiliate
     WHERE parent_id IS NOT NULL
     GROUP BY parent_id, position
    HAVING count(*) > 1
  ) d
UNION ALL
SELECT 'tree_orphan_parent', count(*)::text
  FROM mlm.affiliate a
 WHERE a.parent_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM mlm.affiliate p WHERE p.id = a.parent_id)
UNION ALL
SELECT 'tree_closure_missing_self', count(*)::text
  FROM mlm.affiliate a
 WHERE NOT EXISTS (
   SELECT 1
     FROM mlm.affiliate_closure c
    WHERE c.ancestor_id = a.id
      AND c.descendant_id = a.id
      AND c.distance = 0
 )
ORDER BY metric;

\echo == 3. Activated intent sponsor mismatch sample ==
SELECT pi.id AS intent_id,
       pi.created_at,
       pi.activated_at,
       pi.status,
       pi.user_id,
       p.email AS person_email,
       pi.affiliate_id,
       pi.sponsor_affiliate_id AS intent_sponsor_id,
       isp.email AS intent_sponsor_email,
       a.sponsor_id AS actual_sponsor_id,
       asp.email AS actual_sponsor_email,
       pi.referral_code
  FROM payments.purchase_intent pi
  JOIN mlm.person p ON p.id = pi.person_id
  LEFT JOIN mlm.affiliate a ON a.id = pi.affiliate_id
  LEFT JOIN mlm.affiliate ispa ON ispa.id = pi.sponsor_affiliate_id
  LEFT JOIN mlm.person isp ON isp.id = ispa.person_id
  LEFT JOIN mlm.affiliate aspa ON aspa.id = a.sponsor_id
  LEFT JOIN mlm.person asp ON asp.id = aspa.person_id
 WHERE pi.status IN ('activated', 'paid', 'needs_placement')
   AND pi.sponsor_affiliate_id IS NOT NULL
   AND a.sponsor_id IS NOT NULL
   AND pi.sponsor_affiliate_id <> a.sponsor_id
 ORDER BY COALESCE(pi.activated_at, pi.paid_at, pi.created_at) DESC
 LIMIT 50;

\echo == 4. New placement suspicious sample ==
WITH activated AS (
  SELECT pi.*,
         a.created_at AS affiliate_created_at,
         a.sponsor_id AS actual_sponsor_id,
         a.parent_id,
         a.position,
         a.depth,
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
         ) AS intent_sponsor_is_ancestor,
         EXISTS (
           SELECT 1
             FROM mlm.affiliate_closure c
            WHERE c.ancestor_id = a.sponsor_id
              AND c.descendant_id = a.id
         ) AS actual_sponsor_is_ancestor
    FROM payments.purchase_intent pi
    JOIN mlm.affiliate a ON a.id = pi.affiliate_id
   WHERE pi.status = 'activated'
), new_by_payment AS (
  SELECT *
    FROM activated
   WHERE affiliate_created_at BETWEEN created_at - interval '10 minutes'
                                  AND COALESCE(activated_at, paid_at, created_at) + interval '10 minutes'
      OR has_enroll_event
)
SELECT nbp.id AS intent_id,
       nbp.activated_at,
       nbp.user_id,
       p.email AS person_email,
       nbp.affiliate_id,
       nbp.sponsor_affiliate_id AS intent_sponsor_id,
       isp.email AS intent_sponsor_email,
       nbp.actual_sponsor_id,
       asp.email AS actual_sponsor_email,
       nbp.parent_id,
       pp.email AS parent_email,
       nbp.position,
       nbp.depth,
       nbp.intent_sponsor_is_ancestor,
       nbp.actual_sponsor_is_ancestor,
       nbp.referral_code
  FROM new_by_payment nbp
  JOIN mlm.person p ON p.id = nbp.person_id
  LEFT JOIN mlm.affiliate ispa ON ispa.id = nbp.sponsor_affiliate_id
  LEFT JOIN mlm.person isp ON isp.id = ispa.person_id
  LEFT JOIN mlm.affiliate aspa ON aspa.id = nbp.actual_sponsor_id
  LEFT JOIN mlm.person asp ON asp.id = aspa.person_id
  LEFT JOIN mlm.affiliate pa ON pa.id = nbp.parent_id
  LEFT JOIN mlm.person pp ON pp.id = pa.person_id
 WHERE (nbp.sponsor_affiliate_id IS NOT NULL AND nbp.actual_sponsor_id IS NOT NULL AND nbp.sponsor_affiliate_id <> nbp.actual_sponsor_id)
    OR (nbp.sponsor_affiliate_id IS NOT NULL AND NOT nbp.intent_sponsor_is_ancestor)
    OR (nbp.actual_sponsor_id IS NOT NULL AND NOT nbp.actual_sponsor_is_ancestor)
 ORDER BY nbp.activated_at DESC
 LIMIT 50;

\echo == 5. Referral code mismatch sample ==
WITH resolved_refs AS (
  SELECT pi.id,
         COALESCE(exact.id, ci.id, mp.id) AS resolved_sponsor_id
    FROM payments.purchase_intent pi
    LEFT JOIN LATERAL (
      SELECT a.id
        FROM mlm.affiliate a
        JOIN mlm.person p ON p.id = a.person_id
       WHERE a.invitation_link = pi.referral_code
         AND a.status::text = 'active'
         AND p.status::text = 'active'
         AND NOT COALESCE(p.blacklisted, false)
       LIMIT 1
    ) exact ON true
    LEFT JOIN LATERAL (
      SELECT a.id
        FROM mlm.affiliate a
        JOIN mlm.person p ON p.id = a.person_id
       WHERE lower(a.invitation_link) = lower(pi.referral_code)
         AND a.status::text = 'active'
         AND p.status::text = 'active'
         AND NOT COALESCE(p.blacklisted, false)
       LIMIT 1
    ) ci ON exact.id IS NULL
    LEFT JOIN LATERAL (
      SELECT a.id
        FROM mlm.affiliate a
        JOIN mlm.person p ON p.id = a.person_id
       WHERE lower(pi.referral_code) ~ '^mp[0-9]+$'
         AND a.id = substring(lower(pi.referral_code) from 3)::bigint
         AND a.status::text = 'active'
         AND p.status::text = 'active'
         AND NOT COALESCE(p.blacklisted, false)
       LIMIT 1
    ) mp ON exact.id IS NULL AND ci.id IS NULL
   WHERE pi.referral_code IS NOT NULL
     AND btrim(pi.referral_code) <> ''
)
SELECT pi.id AS intent_id,
       pi.created_at,
       pi.status,
       pi.user_id,
       pi.referral_code,
       rr.resolved_sponsor_id,
       rsp.email AS resolved_sponsor_email,
       pi.sponsor_affiliate_id AS intent_sponsor_id,
       isp.email AS intent_sponsor_email,
       pi.affiliate_id
  FROM resolved_refs rr
  JOIN payments.purchase_intent pi ON pi.id = rr.id
  LEFT JOIN mlm.affiliate rsa ON rsa.id = rr.resolved_sponsor_id
  LEFT JOIN mlm.person rsp ON rsp.id = rsa.person_id
  LEFT JOIN mlm.affiliate isa ON isa.id = pi.sponsor_affiliate_id
  LEFT JOIN mlm.person isp ON isp.id = isa.person_id
 WHERE rr.resolved_sponsor_id IS DISTINCT FROM pi.sponsor_affiliate_id
 ORDER BY pi.created_at DESC
 LIMIT 50;

\echo == 6. Sponsor link and expected next weak-leg slot ==
WITH sponsor AS (
  SELECT a.id,
         a.invitation_link,
         p.email,
         trim(p.first_name || ' ' || p.last_name) AS name,
         a.left_pv_current,
         a.right_pv_current,
         a.left_count,
         a.right_count
    FROM mlm.affiliate a
    JOIN mlm.person p ON p.id = a.person_id
   WHERE lower(p.email) = lower(:'sponsor_email')
), next_slot AS (
  WITH RECURSIVE walk AS (
    SELECT a.id AS node_id,
           CASE WHEN a.left_pv_current < a.right_pv_current THEN 'L'
                WHEN a.right_pv_current < a.left_pv_current THEN 'R'
                WHEN a.left_count < a.right_count THEN 'L'
                WHEN a.right_count < a.left_count THEN 'R'
                ELSE 'L' END AS side,
           0 AS lvl
      FROM mlm.affiliate a
      JOIN sponsor s ON s.id = a.id
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
  SELECT node_id AS parent_id, side AS next_side, lvl AS level_below_sponsor
    FROM walk
   ORDER BY lvl DESC
   LIMIT 1
)
SELECT s.id AS sponsor_affiliate_id,
       s.email AS sponsor_email,
       COALESCE(s.invitation_link, 'MP' || s.id::text) AS referral_code,
       'https://app.mindblisspower.com/register?ref=' || COALESCE(s.invitation_link, 'MP' || s.id::text) AS referral_link,
       ns.parent_id AS expected_next_parent_id,
       pp.email AS expected_next_parent_email,
       ns.next_side AS expected_next_side,
       ns.level_below_sponsor
  FROM sponsor s
  CROSS JOIN next_slot ns
  LEFT JOIN mlm.affiliate pa ON pa.id = ns.parent_id
  LEFT JOIN mlm.person pp ON pp.id = pa.person_id;
