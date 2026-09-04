\set ON_ERROR_STOP on
\timing on

BEGIN;
SET LOCAL statement_timeout = '20min';
SET LOCAL lock_timeout = '5s';

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
       child.parent_id AS current_parent_id,
       child.position AS current_position,
       child.current_rank_id
  FROM _legacy_tree_map m
  JOIN mlm.affiliate child ON child.legacy_id_vicionario=m.legacy_id
  LEFT JOIN mlm.affiliate parent
    ON parent.legacy_id_vicionario=NULLIF(m.expected_parent_legacy_id,0);

CREATE UNIQUE INDEX ON _expected(affiliate_id);
CREATE UNIQUE INDEX ON _expected(legacy_id);
CREATE INDEX ON _expected(expected_parent_id,expected_position);
ANALYZE _expected;

CREATE TEMP TABLE _legacy_main AS
WITH RECURSIVE walk AS (
  SELECT e.* FROM _expected e WHERE e.legacy_id=1
  UNION ALL
  SELECT c.* FROM walk w JOIN _expected c ON c.expected_parent_id=w.affiliate_id
)
SELECT * FROM walk;

CREATE UNIQUE INDEX ON _legacy_main(affiliate_id);
ANALYZE _legacy_main;

DO $$
DECLARE
  v bigint;
BEGIN
  IF (SELECT count(*) FROM _legacy_tree_map) <> 121013 THEN
    RAISE EXCEPTION 'Unexpected legacy map row count';
  END IF;
  IF (SELECT count(*) FROM _expected) <> 121013 THEN
    RAISE EXCEPTION 'Legacy rows missing in RDS';
  END IF;
  IF (SELECT count(*) FROM _legacy_main) <> 102694 THEN
    RAISE EXCEPTION 'Unexpected infinity legacy subtree size';
  END IF;
  SELECT count(*) INTO v
    FROM _expected
   WHERE current_rank_id IS DISTINCT FROM expected_rank_id;
  IF v <> 0 THEN
    RAISE EXCEPTION 'Legacy rank drift: % rows', v;
  END IF;
  SELECT count(*) INTO v
    FROM _legacy_main wanted
    JOIN mlm.affiliate occupant
      ON occupant.parent_id=wanted.expected_parent_id
     AND occupant.position=wanted.expected_position
     AND occupant.id<>wanted.affiliate_id;
  IF v <> 0 THEN
    RAISE EXCEPTION 'Historical target slot conflicts: %', v;
  END IF;
END $$;

CREATE TEMP TABLE _final_edge AS
SELECT a.id,
       CASE WHEN m.affiliate_id IS NOT NULL THEN m.expected_parent_id ELSE a.parent_id END AS parent_id,
       CASE WHEN m.affiliate_id IS NOT NULL THEN m.expected_position ELSE a.position END AS position
  FROM mlm.affiliate a
  LEFT JOIN _legacy_main m ON m.affiliate_id=a.id;

CREATE UNIQUE INDEX ON _final_edge(id);
CREATE INDEX ON _final_edge(parent_id,position);

-- Conecta las siete raíces suspendidas residuales detrás de una cadena de
-- cuentas igualmente suspendidas. Así infinitysuccess queda como raíz única
-- sin convertir a un afiliado activo en upline artificial de esas ramas.
UPDATE _final_edge SET parent_id=541,   position='R' WHERE id=12340;  -- aritadariela25 -> 2023feliza
UPDATE _final_edge SET parent_id=538,   position='L' WHERE id=117110; -- yalibeth45 -> 2023adrianlimon
UPDATE _final_edge SET parent_id=557,   position='L' WHERE id=28501;  -- davidjunior32 -> 2024sergio
UPDATE _final_edge SET parent_id=557,   position='R' WHERE id=106994; -- shuri17 -> 2024sergio
UPDATE _final_edge SET parent_id=12340, position='L' WHERE id=33387;  -- elaine93 -> aritadariela25
UPDATE _final_edge SET parent_id=12340, position='R' WHERE id=9151;   -- andrev17 -> aritadariela25
UPDATE _final_edge SET parent_id=33387, position='L' WHERE id=1;      -- @Adri07 -> elaine93

ANALYZE _final_edge;

DO $$
DECLARE
  v bigint;
BEGIN
  SELECT count(*) INTO v FROM _final_edge WHERE parent_id IS NULL;
  IF v <> 1 OR NOT EXISTS (SELECT 1 FROM _final_edge WHERE id=50793 AND parent_id IS NULL) THEN
    RAISE EXCEPTION 'Projected tree must have infinitysuccess as its only root (roots=%)', v;
  END IF;
  SELECT count(*) INTO v
    FROM (SELECT parent_id,position FROM _final_edge WHERE parent_id IS NOT NULL GROUP BY parent_id,position HAVING count(*)>1) d;
  IF v <> 0 THEN
    RAISE EXCEPTION 'Projected duplicate binary slots: %', v;
  END IF;
  SELECT count(*) INTO v
    FROM _final_edge
   WHERE (parent_id IS NULL) <> (position IS NULL);
  IF v <> 0 THEN
    RAISE EXCEPTION 'Projected parent/position nullability drift: %', v;
  END IF;
END $$;

CREATE TEMP TABLE _new_path ON COMMIT DROP AS
WITH RECURSIVE tree AS (
  SELECT e.id,
         text2ltree(e.id::text) AS path,
         0 AS depth
    FROM _final_edge e
   WHERE e.parent_id IS NULL
  UNION ALL
  SELECT c.id,
         p.path || text2ltree(c.position::text || '_' || c.id::text),
         p.depth+1
    FROM tree p
    JOIN _final_edge c ON c.parent_id=p.id
   WHERE p.depth < 1024
)
SELECT * FROM tree;

CREATE UNIQUE INDEX ON _new_path(id);
ANALYZE _new_path;

DO $$
DECLARE
  v_total bigint;
  v_projected bigint;
BEGIN
  SELECT count(*) INTO v_total FROM mlm.affiliate;
  SELECT count(*) INTO v_projected FROM _new_path;
  IF v_projected <> v_total THEN
    RAISE EXCEPTION 'Projected path coverage %/% (cycle or orphan)', v_projected, v_total;
  END IF;
  IF (SELECT max(depth) FROM _new_path) > 1024 THEN
    RAISE EXCEPTION 'Projected tree exceeds depth guard';
  END IF;
END $$;

CREATE TEMP TABLE _new_closure (
  ancestor_id bigint NOT NULL,
  descendant_id bigint NOT NULL,
  distance integer NOT NULL,
  PRIMARY KEY(ancestor_id,descendant_id)
) ON COMMIT DROP;

INSERT INTO _new_closure(ancestor_id,descendant_id,distance)
WITH RECURSIVE walk AS (
  SELECT e.id AS descendant_id,
         e.id AS ancestor_id,
         0 AS distance,
         e.parent_id
    FROM _final_edge e
  UNION ALL
  SELECT w.descendant_id,
         p.id,
         w.distance+1,
         p.parent_id
    FROM walk w
    JOIN _final_edge p ON p.id=w.parent_id
   WHERE w.distance < 1024
)
SELECT ancestor_id,descendant_id,distance FROM walk;

CREATE INDEX ON _new_closure(descendant_id,distance);
ANALYZE _new_closure;

CREATE TEMP TABLE _new_counts ON COMMIT DROP AS
SELECT c.ancestor_id AS id,
       count(*) FILTER (WHERE substring(ltree2text(subpath(dp.path,ap.depth+1,1)) from 1 for 1)='L')::bigint AS left_count,
       count(*) FILTER (WHERE substring(ltree2text(subpath(dp.path,ap.depth+1,1)) from 1 for 1)='R')::bigint AS right_count
  FROM _new_closure c
  JOIN _new_path ap ON ap.id=c.ancestor_id
  JOIN _new_path dp ON dp.id=c.descendant_id
 WHERE c.distance>0
 GROUP BY c.ancestor_id;

CREATE UNIQUE INDEX ON _new_counts(id);
ANALYZE _new_counts;

CREATE TEMP TABLE _new_pv ON COMMIT DROP AS
SELECT c.ancestor_id AS id,
       COALESCE(sum(te.pv_delta_left+te.pv_delta_right) FILTER (
         WHERE substring(ltree2text(subpath(dp.path,ap.depth+1,1)) from 1 for 1)='L'
       ),0)::numeric(20,2) AS left_pv,
       COALESCE(sum(te.pv_delta_left+te.pv_delta_right) FILTER (
         WHERE substring(ltree2text(subpath(dp.path,ap.depth+1,1)) from 1 for 1)='R'
       ),0)::numeric(20,2) AS right_pv
  FROM _new_closure c
  JOIN _new_path ap ON ap.id=c.ancestor_id
  JOIN _new_path dp ON dp.id=c.descendant_id
  JOIN mlm.tree_event te ON te.affiliate_id=c.descendant_id
 WHERE c.distance>0
 GROUP BY c.ancestor_id;

CREATE UNIQUE INDEX ON _new_pv(id);
ANALYZE _new_pv;

SELECT 'projected_affiliates' AS metric,count(*)::text AS value FROM _new_path
UNION ALL SELECT 'projected_roots',count(*)::text FROM _final_edge WHERE parent_id IS NULL
UNION ALL SELECT 'projected_max_depth',max(depth)::text FROM _new_path
UNION ALL SELECT 'projected_closure_rows',count(*)::text FROM _new_closure
UNION ALL SELECT 'changed_edges',count(*)::text FROM _final_edge f JOIN mlm.affiliate a USING(id) WHERE a.parent_id IS DISTINCT FROM f.parent_id OR a.position IS DISTINCT FROM f.position
UNION ALL SELECT 'changed_paths',count(*)::text FROM _new_path n JOIN mlm.affiliate a USING(id) WHERE a.path IS DISTINCT FROM n.path OR a.depth IS DISTINCT FROM n.depth
UNION ALL SELECT 'closure_rows_to_delete',count(*)::text FROM mlm.affiliate_closure c LEFT JOIN _new_closure n USING(ancestor_id,descendant_id) WHERE n.ancestor_id IS NULL
UNION ALL SELECT 'closure_rows_to_insert',count(*)::text FROM _new_closure n LEFT JOIN mlm.affiliate_closure c USING(ancestor_id,descendant_id) WHERE c.ancestor_id IS NULL
UNION ALL SELECT 'closure_distances_to_update',count(*)::text FROM _new_closure n JOIN mlm.affiliate_closure c USING(ancestor_id,descendant_id) WHERE c.distance<>n.distance
UNION ALL SELECT 'tree_event_rows',count(*)::text FROM mlm.tree_event
UNION ALL SELECT 'tree_event_pv',COALESCE(sum(pv_delta_left+pv_delta_right),0)::text FROM mlm.tree_event
UNION ALL SELECT 'rank_mismatches',count(*)::text FROM _expected WHERE current_rank_id IS DISTINCT FROM expected_rank_id;

SELECT 'infinity_projection' AS section,
       a.id,
       a.invitation_link,
       f.parent_id,
       f.position,
       np.depth,
       COALESCE(nc.left_count,0) AS left_count,
       COALESCE(nc.right_count,0) AS right_count,
       COALESCE(pv.left_pv,0) AS left_pv,
       COALESCE(pv.right_pv,0) AS right_pv
  FROM mlm.affiliate a
  JOIN _final_edge f USING(id)
  JOIN _new_path np USING(id)
  LEFT JOIN _new_counts nc USING(id)
  LEFT JOIN _new_pv pv USING(id)
 WHERE a.legacy_id_vicionario IN (1,2,3,4,5,6,7,8,15,16,37)
 ORDER BY a.legacy_id_vicionario;

ROLLBACK;
