\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE _legacy_tree_map (
  legacy_id integer PRIMARY KEY,
  expected_parent_legacy_id integer NOT NULL,
  expected_position text NOT NULL,
  legacy_rank_id smallint NOT NULL,
  legacy_affiliate_status integer NOT NULL,
  legacy_person_status integer NOT NULL,
  legacy_blacklisted integer NOT NULL
) ON COMMIT DROP;

\copy _legacy_tree_map FROM '/var/tmp/mindbliss-tree-rebuild-20260904/legacy_tree_map.tsv' WITH (FORMAT text)

ANALYZE _legacy_tree_map;

CREATE TEMP TABLE _expected AS
SELECT child.id AS affiliate_id,
       m.legacy_id,
       CASE WHEN m.expected_parent_legacy_id = 0 THEN NULL ELSE parent.id END AS expected_parent_id,
       NULLIF(m.expected_position, '-')::mlm.tree_position AS expected_position,
       NULLIF(m.legacy_rank_id, 0)::smallint AS expected_rank_id,
       a.parent_id AS current_parent_id,
       a.position AS current_position,
       a.current_rank_id,
       a.status AS current_affiliate_status,
       p.status AS current_person_status,
       p.blacklisted AS current_blacklisted
  FROM _legacy_tree_map m
  JOIN mlm.affiliate child ON child.legacy_id_vicionario = m.legacy_id
  JOIN mlm.affiliate a ON a.id = child.id
  JOIN mlm.person p ON p.id = a.person_id
  LEFT JOIN mlm.affiliate parent
    ON parent.legacy_id_vicionario = NULLIF(m.expected_parent_legacy_id, 0);

CREATE UNIQUE INDEX ON _expected(affiliate_id);
CREATE UNIQUE INDEX ON _expected(legacy_id);
CREATE INDEX ON _expected(expected_parent_id, expected_position);
ANALYZE _expected;

CREATE TEMP TABLE _legacy_main AS
WITH RECURSIVE walk AS (
  SELECT e.*
    FROM _expected e
   WHERE e.legacy_id = 1
  UNION ALL
  SELECT c.*
    FROM walk w
    JOIN _expected c ON c.expected_parent_id = w.affiliate_id
)
SELECT * FROM walk;

CREATE UNIQUE INDEX ON _legacy_main(affiliate_id);
ANALYZE _legacy_main;

SELECT 'map_rows' AS metric, count(*)::text AS value FROM _legacy_tree_map
UNION ALL SELECT 'rds_legacy_rows', count(*)::text FROM _expected
UNION ALL SELECT 'legacy_rows_missing_in_rds', (SELECT count(*) FROM _legacy_tree_map m LEFT JOIN _expected e USING (legacy_id) WHERE e.legacy_id IS NULL)::text
UNION ALL SELECT 'legacy_exact_edge_matches', count(*) FILTER (WHERE current_parent_id IS NOT DISTINCT FROM expected_parent_id AND current_position IS NOT DISTINCT FROM expected_position)::text FROM _expected
UNION ALL SELECT 'legacy_edge_mismatches', count(*) FILTER (WHERE current_parent_id IS DISTINCT FROM expected_parent_id OR current_position IS DISTINCT FROM expected_position)::text FROM _expected
UNION ALL SELECT 'legacy_rank_mismatches', count(*) FILTER (WHERE current_rank_id IS DISTINCT FROM expected_rank_id)::text FROM _expected
UNION ALL SELECT 'legacy_expected_roots', count(*) FILTER (WHERE expected_parent_id IS NULL)::text FROM _expected
UNION ALL SELECT 'legacy_main_rows', count(*)::text FROM _legacy_main
UNION ALL SELECT 'legacy_main_edge_mismatches', count(*) FILTER (WHERE current_parent_id IS DISTINCT FROM expected_parent_id OR current_position IS DISTINCT FROM expected_position)::text FROM _legacy_main
UNION ALL SELECT 'new_rows', count(*)::text FROM mlm.affiliate WHERE legacy_id_vicionario IS NULL;

SELECT 'expected_slot_conflict' AS issue,
       wanted.legacy_id AS wanted_legacy_id,
       wanted.affiliate_id AS wanted_affiliate_id,
       wanted.expected_parent_id,
       wanted.expected_position,
       occupant.id AS occupant_affiliate_id,
       occupant.legacy_id_vicionario AS occupant_legacy_id,
       occupant.invitation_link AS occupant_handle
  FROM _expected wanted
  JOIN mlm.affiliate occupant
    ON occupant.parent_id = wanted.expected_parent_id
   AND occupant.position = wanted.expected_position
   AND occupant.id <> wanted.affiliate_id
 ORDER BY wanted.legacy_id
 LIMIT 100;

SELECT 'conflict_totals' AS metric,
       count(*) AS total,
       count(*) FILTER (WHERE occupant.legacy_id_vicionario IS NULL) AS new_occupants,
       count(*) FILTER (WHERE wanted.affiliate_id IN (SELECT affiliate_id FROM _legacy_main)) AS main_tree_slots
  FROM _expected wanted
  JOIN mlm.affiliate occupant
    ON occupant.parent_id = wanted.expected_parent_id
   AND occupant.position = wanted.expected_position
   AND occupant.id <> wanted.affiliate_id;

CREATE TEMP TABLE _final_edge AS
SELECT a.id,
       CASE WHEN m.affiliate_id IS NOT NULL THEN m.expected_parent_id ELSE a.parent_id END AS parent_id,
       CASE WHEN m.affiliate_id IS NOT NULL THEN m.expected_position ELSE a.position END AS position
  FROM mlm.affiliate a
  LEFT JOIN _legacy_main m ON m.affiliate_id = a.id;

CREATE UNIQUE INDEX ON _final_edge(id);
CREATE INDEX ON _final_edge(parent_id, position);
ANALYZE _final_edge;

CREATE TEMP TABLE _final_infinity_subtree AS
WITH RECURSIVE walk AS (
  SELECT f.id, 0 AS depth
    FROM _final_edge f
    JOIN mlm.affiliate a ON a.id = f.id
   WHERE a.legacy_id_vicionario = 1
  UNION ALL
  SELECT c.id, w.depth + 1
    FROM walk w
    JOIN _final_edge c ON c.parent_id = w.id
   WHERE w.depth < 1024
)
SELECT * FROM walk;

CREATE UNIQUE INDEX ON _final_infinity_subtree(id);
ANALYZE _final_infinity_subtree;

CREATE TEMP TABLE _final_company_subtree AS
WITH RECURSIVE walk AS (
  SELECT f.id, 0 AS depth
    FROM _final_edge f
   WHERE f.id = 117475
  UNION ALL
  SELECT c.id, w.depth + 1
    FROM walk w
    JOIN _final_edge c ON c.parent_id = w.id
   WHERE w.depth < 1024
)
SELECT * FROM walk;

CREATE UNIQUE INDEX ON _final_company_subtree(id);
ANALYZE _final_company_subtree;

SELECT 'final_projection_roots' AS metric, count(*)::text AS value FROM _final_edge WHERE parent_id IS NULL
UNION ALL SELECT 'final_projection_duplicate_slots', count(*)::text FROM (SELECT parent_id,position FROM _final_edge WHERE parent_id IS NOT NULL GROUP BY parent_id,position HAVING count(*) > 1) d
UNION ALL SELECT 'final_infinity_subtree_rows', count(*)::text FROM _final_infinity_subtree
UNION ALL SELECT 'final_infinity_legacy_rows', count(*)::text FROM _final_infinity_subtree s JOIN mlm.affiliate a ON a.id=s.id WHERE a.legacy_id_vicionario IS NOT NULL
UNION ALL SELECT 'final_infinity_new_rows', count(*)::text FROM _final_infinity_subtree s JOIN mlm.affiliate a ON a.id=s.id WHERE a.legacy_id_vicionario IS NULL
UNION ALL SELECT 'final_infinity_visible_active', count(*)::text FROM _final_infinity_subtree s JOIN mlm.affiliate a ON a.id=s.id JOIN mlm.person p ON p.id=a.person_id WHERE a.status='active' AND p.status='active' AND NOT p.blacklisted
UNION ALL SELECT 'outside_infinity_visible_active', count(*)::text FROM mlm.affiliate a JOIN mlm.person p ON p.id=a.person_id LEFT JOIN _final_infinity_subtree s ON s.id=a.id WHERE s.id IS NULL AND a.status='active' AND p.status='active' AND NOT p.blacklisted
UNION ALL SELECT 'final_infinity_max_depth', max(depth)::text FROM _final_infinity_subtree
UNION ALL SELECT 'main_changes_currently_roots', count(*) FILTER (WHERE current_parent_id IS NULL)::text FROM _legacy_main WHERE current_parent_id IS DISTINCT FROM expected_parent_id OR current_position IS DISTINCT FROM expected_position
UNION ALL SELECT 'main_changes_wrong_parent', count(*) FILTER (WHERE current_parent_id IS NOT NULL)::text FROM _legacy_main WHERE current_parent_id IS DISTINCT FROM expected_parent_id OR current_position IS DISTINCT FROM expected_position;

SELECT 'company_free_slot' AS section,
       s.depth,
       a.id AS parent_id,
       a.legacy_id_vicionario AS parent_legacy_id,
       a.invitation_link AS parent_handle,
       side.position AS free_position
  FROM _final_company_subtree s
  JOIN mlm.affiliate a ON a.id=s.id
 CROSS JOIN (VALUES ('L'::mlm.tree_position),('R'::mlm.tree_position)) side(position)
  LEFT JOIN _final_edge child
    ON child.parent_id=s.id
   AND child.position=side.position
 WHERE child.id IS NULL
 ORDER BY s.depth,a.id,side.position
 LIMIT 20;

WITH RECURSIVE blocked_chain AS (
  SELECT f.id,
         1 AS depth,
         (a.status <> 'active' OR p.status <> 'active' OR p.blacklisted) AS all_blocked
    FROM _final_edge f
    JOIN mlm.affiliate a ON a.id=f.id
    JOIN mlm.person p ON p.id=a.person_id
   WHERE f.parent_id=(SELECT affiliate_id FROM _expected WHERE legacy_id=1)
     AND f.position='R'
  UNION ALL
  SELECT c.id,
         b.depth+1,
         b.all_blocked AND (a.status <> 'active' OR p.status <> 'active' OR p.blacklisted)
    FROM blocked_chain b
    JOIN _final_edge c ON c.parent_id=b.id
    JOIN mlm.affiliate a ON a.id=c.id
    JOIN mlm.person p ON p.id=a.person_id
   WHERE b.depth < 1024
)
SELECT 'blocked_chain_free_slot' AS section,
       b.depth,
       a.id AS parent_id,
       a.legacy_id_vicionario AS parent_legacy_id,
       a.invitation_link AS parent_handle,
       side.position AS free_position
  FROM blocked_chain b
  JOIN mlm.affiliate a ON a.id=b.id
 CROSS JOIN (VALUES ('L'::mlm.tree_position),('R'::mlm.tree_position)) side(position)
  LEFT JOIN _final_edge child
    ON child.parent_id=b.id
   AND child.position=side.position
 WHERE b.all_blocked
   AND child.id IS NULL
 ORDER BY b.depth,a.id,side.position
 LIMIT 20;

SELECT 'projected_root' AS section,
       a.id,
       a.legacy_id_vicionario,
       a.invitation_link,
       a.status,
       p.status AS person_status,
       p.blacklisted
  FROM _final_edge f
  JOIN mlm.affiliate a ON a.id=f.id
  JOIN mlm.person p ON p.id=a.person_id
 WHERE f.parent_id IS NULL
 ORDER BY a.legacy_id_vicionario NULLS LAST, a.id;

SELECT 'initial_branch' AS section,
       e.legacy_id,
       a.invitation_link,
       e.expected_parent_id,
       e.expected_position,
       e.current_parent_id,
       e.current_position,
       e.current_affiliate_status,
       e.current_person_status,
       e.current_blacklisted,
       e.expected_rank_id,
       e.current_rank_id
  FROM _expected e
  JOIN mlm.affiliate a ON a.id = e.affiliate_id
 WHERE e.legacy_id IN (1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,37,51,55)
 ORDER BY e.legacy_id;

ROLLBACK;
