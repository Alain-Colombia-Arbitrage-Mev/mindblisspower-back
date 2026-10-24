-- The planner may evaluate a path expression before the closure join filters it.
-- Guard subpath itself with CASE; a WHERE ... AND ... guard is not sufficient.
-- Only replaces a reconciliation view. Does not update positions or balances.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE VIEW mlm.v_tree_pv_truth AS
SELECT a.id, a.left_pv_lifetime AS materialized_left,
       a.right_pv_lifetime AS materialized_right,
       (SELECT COALESCE(SUM(te.pv_delta_left + te.pv_delta_right), 0)
          FROM mlm.tree_event te
          JOIN mlm.affiliate desc_a ON desc_a.id = te.affiliate_id
          JOIN mlm.affiliate_closure c
            ON c.ancestor_id = a.id AND c.descendant_id = desc_a.id AND c.distance > 0
         WHERE CASE WHEN nlevel(desc_a.path) > a.depth + 1
           THEN substring(ltree2text(subpath(desc_a.path, a.depth + 1, 1)) from 1 for 1) END = 'L'
       ) AS computed_left,
       (SELECT COALESCE(SUM(te.pv_delta_left + te.pv_delta_right), 0)
          FROM mlm.tree_event te
          JOIN mlm.affiliate desc_a ON desc_a.id = te.affiliate_id
          JOIN mlm.affiliate_closure c
            ON c.ancestor_id = a.id AND c.descendant_id = desc_a.id AND c.distance > 0
         WHERE CASE WHEN nlevel(desc_a.path) > a.depth + 1
           THEN substring(ltree2text(subpath(desc_a.path, a.depth + 1, 1)) from 1 for 1) END = 'R'
       ) AS computed_right
FROM mlm.affiliate a;
COMMIT;
