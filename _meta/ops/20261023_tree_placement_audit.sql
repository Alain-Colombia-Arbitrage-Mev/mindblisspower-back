-- Read-only structural audit; no names, emails or financial amounts exported.
\set ON_ERROR_STOP on
\pset pager off

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '45s';

SELECT 'affiliates' AS metric, count(*)::text AS value FROM mlm.affiliate
UNION ALL SELECT 'roots', count(*)::text FROM mlm.affiliate WHERE parent_id IS NULL
UNION ALL SELECT 'max_stored_depth', COALESCE(max(depth),0)::text FROM mlm.affiliate
UNION ALL SELECT 'duplicate_slots', count(*)::text FROM (
  SELECT parent_id, position FROM mlm.affiliate WHERE parent_id IS NOT NULL
   GROUP BY parent_id, position HAVING count(*) > 1
) duplicates
UNION ALL SELECT 'missing_parents', count(*)::text FROM mlm.affiliate a
  WHERE a.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM mlm.affiliate p WHERE p.id = a.parent_id)
UNION ALL SELECT 'parent_path_or_depth_drift', count(*)::text
  FROM mlm.affiliate a JOIN mlm.affiliate p ON p.id = a.parent_id
 WHERE a.depth <> p.depth + 1
    OR a.path <> p.path || text2ltree(a.position::text || '_' || a.id::text)
UNION ALL SELECT 'missing_closure_self', count(*)::text FROM mlm.affiliate a
 WHERE NOT EXISTS (SELECT 1 FROM mlm.affiliate_closure c
                    WHERE c.ancestor_id = a.id AND c.descendant_id = a.id AND c.distance = 0)
UNION ALL SELECT 'missing_closure_parent', count(*)::text FROM mlm.affiliate a
 WHERE a.parent_id IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM mlm.affiliate_closure c
    WHERE c.ancestor_id = a.parent_id AND c.descendant_id = a.id AND c.distance = 1)
UNION ALL SELECT 'sponsor_outside_binary_ancestry', count(*)::text FROM mlm.affiliate a
 WHERE a.sponsor_id IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM mlm.affiliate_closure c
    WHERE c.ancestor_id = a.sponsor_id AND c.descendant_id = a.id AND c.distance > 0)
ORDER BY metric;

WITH RECURSIVE walk AS (
  SELECT a.id, a.depth, 0 AS computed_depth, ARRAY[a.id] AS path_ids
    FROM mlm.affiliate a WHERE a.parent_id IS NULL
  UNION ALL
  SELECT a.id, a.depth, w.computed_depth + 1, w.path_ids || a.id
    FROM walk w JOIN mlm.affiliate a ON a.parent_id = w.id
   WHERE w.computed_depth < 1024 AND NOT a.id = ANY(w.path_ids)
)
SELECT 'reachable_from_roots' AS metric, count(*)::text AS value FROM walk
UNION ALL SELECT 'unreachable_or_beyond_guard',
  ((SELECT count(*) FROM mlm.affiliate) - count(*))::text FROM walk
UNION ALL SELECT 'depth_drift_from_root', count(*)::text FROM walk WHERE depth <> computed_depth
UNION ALL SELECT 'guard_reached_1024', count(*)::text FROM walk WHERE computed_depth = 1024
ORDER BY metric;

SELECT status, count(*) AS intents, max(paid_at) AS latest_paid_at
  FROM payments.purchase_intent GROUP BY status ORDER BY status;

COMMIT;
