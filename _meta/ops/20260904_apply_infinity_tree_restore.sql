-- Restaura la rama histórica principal del backup viciongroup260619.bak,
-- conserva rangos/sponsors/estados y recalcula exclusivamente read-models
-- desde mlm.tree_event (la fuente actual de Stripe/MindBliss).
-- Snapshot previo: database-mindlisspower-pre-tree-restore-20260904-1735
\set ON_ERROR_STOP on
\timing on

BEGIN;
SET LOCAL statement_timeout = '20min';
SET LOCAL lock_timeout = '15s';
SET LOCAL synchronous_commit = on;

SELECT pg_advisory_xact_lock(hashtextextended('ops:infinity-tree-restore:20260904',0));

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

-- Bloquea solo escrituras durante la reconstrucción. Las lecturas continúan
-- viendo la versión anterior hasta el COMMIT atómico.
LOCK TABLE mlm.affiliate IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE mlm.affiliate_closure IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE mlm.tree_event IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM mlm.tree_event WHERE external_ref='ops:infinity-tree-restore:20260904') THEN
    RAISE EXCEPTION 'Tree restore was already applied';
  END IF;
  IF (SELECT count(*) FROM _legacy_tree_map) <> 121013 THEN
    RAISE EXCEPTION 'Unexpected legacy map row count';
  END IF;
  IF (SELECT count(*) FROM mlm.affiliate WHERE legacy_id_vicionario IS NOT NULL) <> 121013 THEN
    RAISE EXCEPTION 'Unexpected RDS legacy affiliate count';
  END IF;
  IF EXISTS (
    SELECT 1 FROM mlm.affiliate
     WHERE left_pv_current<>left_pv_lifetime
        OR right_pv_current<>right_pv_lifetime
        OR left_carry<>0 OR right_carry<>0
  ) THEN
    RAISE EXCEPTION 'PV cycle/carry state changed; explicit reconciliation required';
  END IF;
END $$;

CREATE TEMP TABLE _expected AS
SELECT child.id AS affiliate_id,
       m.legacy_id,
       CASE WHEN m.expected_parent_legacy_id=0 THEN NULL ELSE parent.id END AS expected_parent_id,
       NULLIF(m.expected_position,'-')::mlm.tree_position AS expected_position,
       NULLIF(m.legacy_rank_id,0)::smallint AS expected_rank_id,
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
DECLARE v bigint;
BEGIN
  IF (SELECT count(*) FROM _expected) <> 121013 THEN
    RAISE EXCEPTION 'Legacy rows missing in RDS';
  END IF;
  IF (SELECT count(*) FROM _legacy_main) <> 102694 THEN
    RAISE EXCEPTION 'Unexpected historical infinity subtree size';
  END IF;
  SELECT count(*) INTO v FROM _expected WHERE current_rank_id IS DISTINCT FROM expected_rank_id;
  IF v<>0 THEN RAISE EXCEPTION 'Legacy rank drift: % rows',v; END IF;
  SELECT count(*) INTO v
    FROM _legacy_main wanted
    JOIN mlm.affiliate occupant
      ON occupant.parent_id=wanted.expected_parent_id
     AND occupant.position=wanted.expected_position
     AND occupant.id<>wanted.affiliate_id;
  IF v<>0 THEN RAISE EXCEPTION 'Historical target slot conflicts: %',v; END IF;
END $$;

CREATE TEMP TABLE _final_edge AS
SELECT a.id,
       CASE WHEN m.affiliate_id IS NOT NULL THEN m.expected_parent_id ELSE a.parent_id END AS parent_id,
       CASE WHEN m.affiliate_id IS NOT NULL THEN m.expected_position ELSE a.position END AS position
  FROM mlm.affiliate a
  LEFT JOIN _legacy_main m ON m.affiliate_id=a.id;

CREATE UNIQUE INDEX ON _final_edge(id);
CREATE INDEX ON _final_edge(parent_id,position);

-- Las siete raíces residuales están suspendidas. Se conectan únicamente bajo
-- cuentas suspendidas de la rama derecha para no crear un upline activo
-- artificial. @Adri07 conserva intacto su subárbol actual.
UPDATE _final_edge SET parent_id=541,   position='R' WHERE id=12340;
UPDATE _final_edge SET parent_id=538,   position='L' WHERE id=117110;
UPDATE _final_edge SET parent_id=557,   position='L' WHERE id=28501;
UPDATE _final_edge SET parent_id=557,   position='R' WHERE id=106994;
UPDATE _final_edge SET parent_id=12340, position='L' WHERE id=33387;
UPDATE _final_edge SET parent_id=12340, position='R' WHERE id=9151;
UPDATE _final_edge SET parent_id=33387, position='L' WHERE id=1;
ANALYZE _final_edge;

CREATE TEMP TABLE _moved_before ON COMMIT DROP AS
SELECT a.id,a.legacy_id_vicionario,a.parent_id,a.position,a.sponsor_id,
       a.path::text AS path,a.depth,a.current_rank_id,a.status::text AS status,
       a.left_count,a.right_count,a.left_pv_lifetime,a.right_pv_lifetime,
       a.left_pv_current,a.right_pv_current,a.left_carry,a.right_carry
  FROM mlm.affiliate a
  JOIN _final_edge f USING(id)
 WHERE a.parent_id IS DISTINCT FROM f.parent_id
    OR a.position IS DISTINCT FROM f.position;

DO $$
DECLARE v bigint;
BEGIN
  IF (SELECT count(*) FROM _moved_before)<>75 THEN
    RAISE EXCEPTION 'Expected exactly 75 edge changes, got %',(SELECT count(*) FROM _moved_before);
  END IF;
  SELECT count(*) INTO v FROM _final_edge WHERE parent_id IS NULL;
  IF v<>1 OR NOT EXISTS(SELECT 1 FROM _final_edge WHERE id=50793 AND parent_id IS NULL) THEN
    RAISE EXCEPTION 'infinitysuccess is not the only projected root (roots=%)',v;
  END IF;
  SELECT count(*) INTO v
    FROM (SELECT parent_id,position FROM _final_edge WHERE parent_id IS NOT NULL GROUP BY parent_id,position HAVING count(*)>1) d;
  IF v<>0 THEN RAISE EXCEPTION 'Projected duplicate slots: %',v; END IF;
  IF EXISTS(SELECT 1 FROM _final_edge WHERE (parent_id IS NULL)<>(position IS NULL)) THEN
    RAISE EXCEPTION 'Projected parent/position nullability drift';
  END IF;
END $$;

CREATE TEMP TABLE _new_path ON COMMIT DROP AS
WITH RECURSIVE tree AS (
  SELECT e.id,text2ltree(e.id::text) AS path,0 AS depth
    FROM _final_edge e WHERE e.parent_id IS NULL
  UNION ALL
  -- Una sola raíz + la restricción UNIQUE(parent_id, position) hacen que la
  -- secuencia L/R identifique unívocamente cada nodo. La codificación compacta
  -- evita superar el límite de clave del índice B-tree en profundidades >300.
  SELECT c.id,p.path || text2ltree(c.position::text),p.depth+1
    FROM tree p JOIN _final_edge c ON c.parent_id=p.id
   WHERE p.depth<1024
)
SELECT * FROM tree;

CREATE UNIQUE INDEX ON _new_path(id);
ANALYZE _new_path;

-- Prueba exactamente la misma clase de índice que existe en producción antes
-- de escribir una sola ruta real. Cualquier ruta demasiado grande aborta aquí.
CREATE TEMP TABLE _path_index_probe(path ltree NOT NULL) ON COMMIT DROP;
INSERT INTO _path_index_probe(path) SELECT path FROM _new_path;
CREATE INDEX _path_index_probe_btree ON _path_index_probe(path);
DROP TABLE _path_index_probe;

DO $$
BEGIN
  IF (SELECT count(*) FROM _new_path)<>(SELECT count(*) FROM mlm.affiliate) THEN
    RAISE EXCEPTION 'Projected path coverage incomplete (cycle or orphan)';
  END IF;
  IF (SELECT max(depth) FROM _new_path)>1024 THEN
    RAISE EXCEPTION 'Projected depth exceeds guard';
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
  SELECT e.id AS descendant_id,e.id AS ancestor_id,0 AS distance,e.parent_id
    FROM _final_edge e
  UNION ALL
  SELECT w.descendant_id,p.id,w.distance+1,p.parent_id
    FROM walk w JOIN _final_edge p ON p.id=w.parent_id
   WHERE w.distance<1024
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
         WHERE substring(ltree2text(subpath(dp.path,ap.depth+1,1)) from 1 for 1)='L'),0)::numeric(20,2) AS left_pv,
       COALESCE(sum(te.pv_delta_left+te.pv_delta_right) FILTER (
         WHERE substring(ltree2text(subpath(dp.path,ap.depth+1,1)) from 1 for 1)='R'),0)::numeric(20,2) AS right_pv
  FROM _new_closure c
  JOIN _new_path ap ON ap.id=c.ancestor_id
  JOIN _new_path dp ON dp.id=c.descendant_id
  JOIN mlm.tree_event te ON te.affiliate_id=c.descendant_id
 WHERE c.distance>0
 GROUP BY c.ancestor_id;
CREATE UNIQUE INDEX ON _new_pv(id);
ANALYZE _new_pv;

CREATE TEMP TABLE _before_totals ON COMMIT DROP AS
SELECT count(*)::bigint AS event_rows,
       COALESCE(sum(pv_delta_left+pv_delta_right),0)::numeric(20,2) AS event_pv
  FROM mlm.tree_event;

-- Escritura atómica de los 75 enlaces y de los paths derivados.
UPDATE mlm.affiliate a
   SET parent_id=f.parent_id,
       position=f.position,
       updated_at=now()
  FROM _final_edge f
 WHERE a.id=f.id
   AND (a.parent_id IS DISTINCT FROM f.parent_id OR a.position IS DISTINCT FROM f.position);

UPDATE mlm.affiliate a
   SET path=np.path,
       depth=np.depth,
       left_count=COALESCE(nc.left_count,0),
       right_count=COALESCE(nc.right_count,0),
       left_pv_lifetime=COALESCE(pv.left_pv,0),
       right_pv_lifetime=COALESCE(pv.right_pv,0),
       left_pv_current=COALESCE(pv.left_pv,0),
       right_pv_current=COALESCE(pv.right_pv,0)
  FROM _new_path np
  LEFT JOIN _new_counts nc ON nc.id=np.id
  LEFT JOIN _new_pv pv ON pv.id=np.id
 WHERE a.id=np.id;

-- Reconciliación diferencial: evita borrar y recrear 7+ millones de filas.
DELETE FROM mlm.affiliate_closure c
 WHERE NOT EXISTS (
   SELECT 1 FROM _new_closure n
    WHERE n.ancestor_id=c.ancestor_id AND n.descendant_id=c.descendant_id
 );

INSERT INTO mlm.affiliate_closure(ancestor_id,descendant_id,distance)
SELECT n.ancestor_id,n.descendant_id,n.distance
  FROM _new_closure n
  LEFT JOIN mlm.affiliate_closure c
    ON c.ancestor_id=n.ancestor_id AND c.descendant_id=n.descendant_id
 WHERE c.ancestor_id IS NULL;

UPDATE mlm.affiliate_closure c
   SET distance=n.distance
  FROM _new_closure n
 WHERE c.ancestor_id=n.ancestor_id
   AND c.descendant_id=n.descendant_id
   AND c.distance<>n.distance;

DO $$
DECLARE v bigint;
DECLARE v_pv numeric(20,2);
BEGIN
  IF (SELECT count(*) FROM mlm.affiliate WHERE parent_id IS NULL)<>1
     OR NOT EXISTS(SELECT 1 FROM mlm.affiliate WHERE id=50793 AND parent_id IS NULL AND position IS NULL AND depth=0) THEN
    RAISE EXCEPTION 'Final root validation failed';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM mlm.affiliate l JOIN mlm.affiliate r ON r.parent_id=l.id AND r.position='R'
     WHERE l.id=50793 AND r.legacy_id_vicionario=3
  ) OR NOT EXISTS(
    SELECT 1 FROM mlm.affiliate l JOIN mlm.affiliate c ON c.parent_id=l.id AND c.position='L'
     WHERE l.id=50793 AND c.legacy_id_vicionario=2
  ) THEN
    RAISE EXCEPTION 'Initial infinity branch validation failed';
  END IF;
  SELECT count(*) INTO v
    FROM mlm.affiliate a JOIN _new_path n USING(id)
   WHERE a.path IS DISTINCT FROM n.path OR a.depth IS DISTINCT FROM n.depth;
  IF v<>0 THEN RAISE EXCEPTION 'Path/depth drift after apply: %',v; END IF;
  IF (SELECT count(*) FROM mlm.affiliate_closure)<>(SELECT count(*) FROM _new_closure) THEN
    RAISE EXCEPTION 'Closure row count drift';
  END IF;
  SELECT count(*) INTO v
    FROM mlm.affiliate_closure c
    FULL JOIN _new_closure n USING(ancestor_id,descendant_id)
   WHERE c.ancestor_id IS NULL OR n.ancestor_id IS NULL OR c.distance<>n.distance;
  IF v<>0 THEN RAISE EXCEPTION 'Closure content drift: %',v; END IF;
  SELECT count(*) INTO v
    FROM mlm.affiliate a
    JOIN _new_path np USING(id)
    LEFT JOIN _new_counts nc USING(id)
    LEFT JOIN _new_pv pv USING(id)
   WHERE a.left_count<>COALESCE(nc.left_count,0)
      OR a.right_count<>COALESCE(nc.right_count,0)
      OR a.left_pv_lifetime<>COALESCE(pv.left_pv,0)
      OR a.right_pv_lifetime<>COALESCE(pv.right_pv,0)
      OR a.left_pv_current<>COALESCE(pv.left_pv,0)
      OR a.right_pv_current<>COALESCE(pv.right_pv,0);
  IF v<>0 THEN RAISE EXCEPTION 'Aggregate drift after apply: %',v; END IF;
  SELECT COALESCE(sum(pv_delta_left+pv_delta_right),0) INTO v_pv FROM mlm.tree_event;
  IF v_pv<>(SELECT event_pv FROM _before_totals)
     OR (SELECT count(*) FROM mlm.tree_event)<>(SELECT event_rows FROM _before_totals) THEN
    RAISE EXCEPTION 'Tree event volume changed during restore';
  END IF;
  SELECT count(*) INTO v FROM _expected e JOIN mlm.affiliate a ON a.id=e.affiliate_id WHERE a.current_rank_id IS DISTINCT FROM e.expected_rank_id;
  IF v<>0 THEN RAISE EXCEPTION 'Ranks changed during restore: %',v; END IF;
  IF EXISTS(SELECT 1 FROM mlm.affiliate WHERE left_carry<>0 OR right_carry<>0) THEN
    RAISE EXCEPTION 'Carry changed during restore';
  END IF;
END $$;

INSERT INTO mlm.tree_event(external_ref,kind,affiliate_id,payload,occurred_at)
SELECT 'ops:infinity-tree-restore:20260904',
       'position_move',
       50793,
       jsonb_build_object(
         'reason','Restore original legacy binary structure with infinitysuccess as unique root',
         'snapshot','database-mindlisspower-pre-tree-restore-20260904-1735',
         'legacy_map_sha256','3107c9efa01964c9d7dd44c8493eabddf8f52b5bcc663e8d16b7a36ddae0bae8',
         'changed_edges',(SELECT count(*) FROM _moved_before),
         'affiliate_count',(SELECT count(*) FROM mlm.affiliate),
         'closure_rows',(SELECT count(*) FROM mlm.affiliate_closure),
         'event_pv_preserved',(SELECT event_pv FROM _before_totals),
         'volume_source','mlm.tree_event (MindBliss/Stripe); no legacy volume imported'
       ),
       now();

INSERT INTO audit.activity_log(actor_user_id,entity_type,entity_id,action,before_data,after_data)
SELECT NULL,
       'mlm.affiliate',
       '50793',
       'ops_restore_infinity_legacy_tree',
       jsonb_build_object(
         'snapshot','database-mindlisspower-pre-tree-restore-20260904-1735',
         'legacy_map_sha256','3107c9efa01964c9d7dd44c8493eabddf8f52b5bcc663e8d16b7a36ddae0bae8',
         'event_rows',b.event_rows,
         'event_pv',b.event_pv,
         'moved_edges',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM _moved_before m)
       ),
       jsonb_build_object(
         'root_affiliate_id',50793,
         'root_legacy_id',1,
         'root_handle','infinitysuccess',
         'left_legacy_id',2,
         'right_legacy_id',3,
         'affiliate_count',(SELECT count(*) FROM mlm.affiliate),
         'closure_rows',(SELECT count(*) FROM mlm.affiliate_closure),
         'max_depth',(SELECT max(depth) FROM mlm.affiliate),
         'event_pv_preserved',b.event_pv,
         'ranks_changed',0,
         'legacy_volume_imported',false
       )
  FROM _before_totals b;

SELECT 'root' AS metric,a.id::text AS value
  FROM mlm.affiliate a WHERE a.parent_id IS NULL
UNION ALL SELECT 'affiliate_count',count(*)::text FROM mlm.affiliate
UNION ALL SELECT 'closure_rows',count(*)::text FROM mlm.affiliate_closure
UNION ALL SELECT 'max_depth',max(depth)::text FROM mlm.affiliate
UNION ALL SELECT 'event_pv_preserved',COALESCE(sum(pv_delta_left+pv_delta_right),0)::text FROM mlm.tree_event
UNION ALL SELECT 'changed_edges',count(*)::text FROM _moved_before;

COMMIT;
