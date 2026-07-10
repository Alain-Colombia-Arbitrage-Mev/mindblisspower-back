-- =============================================================================
-- Migration 39 — mlm.affiliate_closure (transitive-closure table)
-- =============================================================================
-- Motivo: producción dropeó el índice GiST de mlm.affiliate.path
-- (_meta/migration/02_postload.sql:291, paths legacy depth ~369 / ~4KB > límite
-- de página GiST) y nunca lo recreó. Toda consulta `path @>` (ancestros) /
-- `path <@` (descendientes) hace SEQ SCAN sobre ~121k filas. El peor caso es el
-- hot path de escritura: el trigger fn_apply_tree_event seq-scanea TODOS los
-- ancestros en CADA insert de tree_event.
--
-- Esta tabla de closure indexa las relaciones ancestro/descendiente. El cambio
-- es EQUIVALENTE: sólo reemplaza el MECANISMO que ENCUENTRA ancestros/
-- descendientes (de operadores ltree a joins sobre la closure). La detección de
-- pierna (leg) sigue siendo path-based e IDÉNTICA — la closure sólo sustituye
-- el FIND de filas, no el cálculo de PV/count/leg.
--
-- NO aplicar a producción desde este archivo sin revisión de ops.
-- =============================================================================

BEGIN;

-- 1. Tabla de closure. Incluye la self-row (distance 0) por nodo.
CREATE TABLE IF NOT EXISTS mlm.affiliate_closure (
  ancestor_id   bigint NOT NULL REFERENCES mlm.affiliate(id),
  descendant_id bigint NOT NULL REFERENCES mlm.affiliate(id),
  distance      int    NOT NULL,
  PRIMARY KEY (ancestor_id, descendant_id)
);

-- Dirección descendiente -> ancestros. La dirección ancestro -> descendientes
-- se apoya en la PK (ancestor_id, descendant_id).
CREATE INDEX IF NOT EXISTS affiliate_closure_desc_idx
  ON mlm.affiliate_closure (descendant_id, distance);

-- 2. Backfill one-time desde el árbol existente. NO usar `des.path <@ anc.path`:
--    sin el GiST (dropeado en prod) ese join es un nested-loop O(n²) sobre ~121k
--    = ~1.4e10 comparaciones = horas. En su lugar, CTE recursivo sobre ADJACENCY
--    (parent_id, joins por PK) — O(n·profundidad), segundos. Produce EL MISMO
--    conjunto: cada nodo emite su self-row (distance 0) y una fila por cada
--    ancestro subiendo la cadena parent_id (distance creciente).
INSERT INTO mlm.affiliate_closure (ancestor_id, descendant_id, distance)
WITH RECURSIVE walk AS (
  -- Base: self-row de cada afiliado (distance 0), arrastrando su parent_id.
  SELECT id AS descendant_id, id AS ancestor_id, 0 AS distance, parent_id
    FROM mlm.affiliate
  UNION ALL
  -- Paso: sube al parent — (parent, descendiente, distance+1) — hasta parent NULL.
  SELECT w.descendant_id, p.id, w.distance + 1, p.parent_id
    FROM walk w
    JOIN mlm.affiliate p ON p.id = w.parent_id
)
SELECT ancestor_id, descendant_id, distance FROM walk
ON CONFLICT (ancestor_id, descendant_id) DO NOTHING;

-- 3. Mantenimiento incremental: al insertar un afiliado N con parent P, N hereda
--    el conjunto de ancestros de P (incluido P) a distancia +1, más su self-row.
--    Nodos SIEMPRE se insertan bajo un parent ya existente (adjacency), así que
--    las filas de closure de P ya existen. Se ejecuta en la MISMA transacción
--    del insert (trigger AFTER INSERT, no diferido).
CREATE OR REPLACE FUNCTION mlm.fn_maintain_affiliate_closure() RETURNS trigger AS $$
BEGIN
  -- self-row (distance 0), siempre.
  INSERT INTO mlm.affiliate_closure (ancestor_id, descendant_id, distance)
  VALUES (NEW.id, NEW.id, 0)
  ON CONFLICT (ancestor_id, descendant_id) DO NOTHING;

  IF NEW.parent_id IS NOT NULL THEN
    -- Por cada (a, P, dist) en la closure (ancestros de P, incl. P mismo),
    -- N obtiene (a, N, dist+1).
    INSERT INTO mlm.affiliate_closure (ancestor_id, descendant_id, distance)
    SELECT c.ancestor_id, NEW.id, c.distance + 1
      FROM mlm.affiliate_closure c
     WHERE c.descendant_id = NEW.parent_id
    ON CONFLICT (ancestor_id, descendant_id) DO NOTHING;
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_maintain_affiliate_closure ON mlm.affiliate;
CREATE TRIGGER trg_maintain_affiliate_closure
  AFTER INSERT ON mlm.affiliate
  FOR EACH ROW EXECUTE FUNCTION mlm.fn_maintain_affiliate_closure();

-- 4. fn_apply_tree_event: UN SOLO cambio — reemplazar el CTE `ancestors` que
--    hacía `WHERE a.path @> v_path AND a.id <> NEW.affiliate_id` (seq scan) por
--    un join sobre la closure. TODO lo demás queda IDÉNTICO: se sigue leyendo
--    v_path del nodo, se sigue ordenando por depth ASC FOR UPDATE, se sigue
--    calculando la pierna con subpath(v_path, anc.depth + 1, 1) y el mismo
--    UPDATE de L/R/PV/count. La detección de pierna sigue siendo path-based.
CREATE OR REPLACE FUNCTION mlm.fn_apply_tree_event() RETURNS trigger AS $$
DECLARE
  v_path ltree;
  v_position mlm.tree_position;
BEGIN
  SELECT path INTO v_path FROM mlm.affiliate WHERE id = NEW.affiliate_id FOR UPDATE;

  -- Walk ancestors. For each ancestor A, determine which leg of A this affiliate sits in
  -- (compare A's child label in NEW path). Add pv_delta to that leg.
  WITH ancestors AS (
    SELECT a.id, a.path, a.depth
      FROM mlm.affiliate a
      JOIN mlm.affiliate_closure c ON c.ancestor_id = a.id
     WHERE c.descendant_id = NEW.affiliate_id AND c.distance > 0
     ORDER BY a.depth ASC
     FOR UPDATE OF a
  ), legged AS (
    SELECT
      anc.id,
      -- the label at depth+1 in v_path is the leg under anc
      CASE WHEN substring(ltree2text(subpath(v_path, anc.depth + 1, 1)) from 1 for 1) = 'L' THEN 'L'::mlm.tree_position
           ELSE 'R'::mlm.tree_position END AS leg
    FROM ancestors anc
  )
  UPDATE mlm.affiliate a
     SET left_pv_lifetime  = a.left_pv_lifetime  + CASE WHEN l.leg = 'L' THEN NEW.pv_delta_left  + NEW.pv_delta_right ELSE 0 END,
         right_pv_lifetime = a.right_pv_lifetime + CASE WHEN l.leg = 'R' THEN NEW.pv_delta_left  + NEW.pv_delta_right ELSE 0 END,
         left_pv_current   = a.left_pv_current   + CASE WHEN l.leg = 'L' THEN NEW.pv_delta_left  + NEW.pv_delta_right ELSE 0 END,
         right_pv_current  = a.right_pv_current  + CASE WHEN l.leg = 'R' THEN NEW.pv_delta_left  + NEW.pv_delta_right ELSE 0 END,
         left_count        = a.left_count        + CASE WHEN NEW.kind = 'enrollment' AND l.leg = 'L' THEN 1 ELSE 0 END,
         right_count       = a.right_count       + CASE WHEN NEW.kind = 'enrollment' AND l.leg = 'R' THEN 1 ELSE 0 END,
         updated_at        = now()
    FROM legged l
   WHERE a.id = l.id;

  UPDATE mlm.tree_event SET applied_at = now() WHERE id = NEW.id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- 5. v_tree_pv_truth: reemplazar `desc_a.path <@ a.path AND desc_a.id <> a.id`
--    por el join sobre la closure (distance > 0). La detección de pierna sigue
--    siendo path-based e idéntica.
CREATE OR REPLACE VIEW mlm.v_tree_pv_truth AS
SELECT a.id, a.left_pv_lifetime AS materialized_left,
       a.right_pv_lifetime AS materialized_right,
       (SELECT COALESCE(SUM(te.pv_delta_left + te.pv_delta_right), 0)
          FROM mlm.tree_event te
          JOIN mlm.affiliate desc_a ON desc_a.id = te.affiliate_id
          JOIN mlm.affiliate_closure c
            ON c.ancestor_id = a.id AND c.descendant_id = desc_a.id AND c.distance > 0
         WHERE substring(ltree2text(subpath(desc_a.path, a.depth + 1, 1)) from 1 for 1) = 'L'
       ) AS computed_left,
       (SELECT COALESCE(SUM(te.pv_delta_left + te.pv_delta_right), 0)
          FROM mlm.tree_event te
          JOIN mlm.affiliate desc_a ON desc_a.id = te.affiliate_id
          JOIN mlm.affiliate_closure c
            ON c.ancestor_id = a.id AND c.descendant_id = desc_a.id AND c.distance > 0
         WHERE substring(ltree2text(subpath(desc_a.path, a.depth + 1, 1)) from 1 for 1) = 'R'
       ) AS computed_right
  FROM mlm.affiliate a;

COMMIT;
