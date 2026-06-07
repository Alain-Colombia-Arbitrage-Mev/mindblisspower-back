-- =============================================================================
-- 06_demo_y_detached.sql — Post-migración:
--   A) Coloca los 2 vicionarios detached (legacy 393, 12277) vía spill BFS
--      bajo el padre que reclamaban (primer slot libre más superficial,
--      preferencia pierna izquierda). Decisión operativa 2026-06-06.
--   B) Árbol demo para guardcolombia@gmail.com: isla propia de 15 nodos
--      (Oro + 2 Plata + 4 Bronce + 8 sin rango) con datos claramente mock.
-- Idempotente: se puede re-ejecutar.
-- =============================================================================
\set ON_ERROR_STOP on
BEGIN;

-- ---------------------------------------------------------------------------
-- A) Detached → spill BFS bajo el padre reclamado
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  rec record;
  v_slot record;
BEGIN
  FOR rec IN
    SELECT a.id AS aff_id, a.legacy_id_vicionario AS legacy_id,
           mp.id AS claimed_parent
      FROM mlm.affiliate a
      JOIN staging.vicionario v ON v.idvicionario = a.legacy_id_vicionario
      JOIN mlm.affiliate mp ON mp.legacy_id_vicionario = v.idvicionarioparent
     WHERE a.parent_id IS NULL
       AND a.legacy_id_vicionario IN (393, 12277)
  LOOP
    -- BFS: primer afiliado del subárbol del padre reclamado con un lado libre
    WITH RECURSIVE bfs AS (
      SELECT mp.id, mp.depth, 0 AS lvl, ARRAY[0] AS ord
        FROM mlm.affiliate mp WHERE mp.id = rec.claimed_parent
      UNION ALL
      SELECT c.id, c.depth, bfs.lvl + 1,
             bfs.ord || CASE WHEN c.position = 'L' THEN 0 ELSE 1 END
        FROM mlm.affiliate c
        JOIN bfs ON c.parent_id = bfs.id
       WHERE bfs.lvl < 60
    )
    SELECT b.id AS parent_id,
           CASE WHEN NOT EXISTS (SELECT 1 FROM mlm.affiliate x WHERE x.parent_id = b.id AND x.position = 'L')
                THEN 'L'::mlm.tree_position ELSE 'R'::mlm.tree_position END AS side
      INTO v_slot
      FROM bfs b
     WHERE EXISTS (SELECT 1) AND (
           NOT EXISTS (SELECT 1 FROM mlm.affiliate x WHERE x.parent_id = b.id AND x.position = 'L')
        OR NOT EXISTS (SELECT 1 FROM mlm.affiliate x WHERE x.parent_id = b.id AND x.position = 'R'))
     ORDER BY b.lvl, b.ord
     LIMIT 1;

    IF v_slot.parent_id IS NULL THEN
      RAISE WARNING 'legacy %: sin slot libre en 60 niveles (no debería pasar)', rec.legacy_id;
    ELSE
      UPDATE mlm.affiliate
         SET parent_id = v_slot.parent_id, position = v_slot.side
       WHERE id = rec.aff_id;
      -- path/depth del nodo recolocado (sus hijos no existen: era detached)
      UPDATE mlm.affiliate a
         SET path = p.path || text2ltree(a.position::text || '_' || a.id::text),
             depth = p.depth + 1
        FROM mlm.affiliate p
       WHERE a.id = rec.aff_id AND p.id = a.parent_id;
      RAISE NOTICE 'legacy % colocado: parent aff %, lado % (spill BFS)', rec.legacy_id, v_slot.parent_id, v_slot.side;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- B) Árbol demo guardcolombia (isla independiente, no toca data real)
-- ---------------------------------------------------------------------------
-- Limpieza previa de la isla demo (re-ejecutable)
DELETE FROM mlm.affiliate WHERE person_id IN (SELECT id FROM mlm.person WHERE email LIKE '%@mindblisspower.demo' OR email = 'guardcolombia@gmail.com');
DELETE FROM mlm.person    WHERE email LIKE '%@mindblisspower.demo' OR email = 'guardcolombia@gmail.com';

WITH demo_people AS (
  INSERT INTO mlm.person (first_name, last_name, email, phone_number, status, kyc_status)
  VALUES
    ('Guard',    'Colombia',   'guardcolombia@gmail.com',      '+573001112233', 'active', 'approved'),
    ('Andrea',   'Demo',       'demo+l1@mindblisspower.demo',  '+573000000001', 'active', 'approved'),
    ('Carlos',   'Demo',       'demo+r1@mindblisspower.demo',  '+573000000002', 'active', 'approved'),
    ('Luisa',    'Demo',       'demo+ll2@mindblisspower.demo', '+573000000003', 'active', 'approved'),
    ('Mateo',    'Demo',       'demo+lr2@mindblisspower.demo', '+573000000004', 'active', 'approved'),
    ('Valentina','Demo',       'demo+rl2@mindblisspower.demo', '+573000000005', 'active', 'approved'),
    ('Santiago', 'Demo',       'demo+rr2@mindblisspower.demo', '+573000000006', 'active', 'approved'),
    ('Camila',   'Demo',       'demo+n7@mindblisspower.demo',  '+573000000007', 'active', 'not_started'),
    ('Julián',   'Demo',       'demo+n8@mindblisspower.demo',  '+573000000008', 'active', 'not_started'),
    ('Isabella', 'Demo',       'demo+n9@mindblisspower.demo',  '+573000000009', 'active', 'not_started'),
    ('Tomás',    'Demo',       'demo+n10@mindblisspower.demo', '+573000000010', 'active', 'not_started'),
    ('Mariana',  'Demo',       'demo+n11@mindblisspower.demo', '+573000000011', 'active', 'not_started'),
    ('Samuel',   'Demo',       'demo+n12@mindblisspower.demo', '+573000000012', 'active', 'not_started'),
    ('Gabriela', 'Demo',       'demo+n13@mindblisspower.demo', '+573000000013', 'active', 'not_started'),
    ('Daniel',   'Demo',       'demo+n14@mindblisspower.demo', '+573000000014', 'active', 'not_started')
  RETURNING id, email
)
SELECT 1; -- personas creadas; afiliados abajo por niveles para resolver parent_id

-- Nivel 0: raíz demo (Oro)
INSERT INTO mlm.affiliate (person_id, parent_id, position, sponsor_id, path, depth, current_rank_id, status)
SELECT p.id, NULL, NULL, NULL, text2ltree('demo_' || p.id::text), 0,
       (SELECT id FROM mlm.rank WHERE code = 'GOLD'), 'active'
  FROM mlm.person p WHERE p.email = 'guardcolombia@gmail.com';

-- Nivel 1: 2 directos (Plata)
INSERT INTO mlm.affiliate (person_id, parent_id, position, sponsor_id, path, depth, current_rank_id, status)
SELECT p.id, root.id,
       CASE p.email WHEN 'demo+l1@mindblisspower.demo' THEN 'L' ELSE 'R' END::mlm.tree_position,
       root.id,
       root.path || text2ltree(CASE p.email WHEN 'demo+l1@mindblisspower.demo' THEN 'L' ELSE 'R' END || '_' || p.id::text),
       1, (SELECT id FROM mlm.rank WHERE code = 'SILVER'), 'active'
  FROM mlm.person p
  JOIN mlm.affiliate root ON root.person_id = (SELECT id FROM mlm.person WHERE email = 'guardcolombia@gmail.com')
 WHERE p.email IN ('demo+l1@mindblisspower.demo', 'demo+r1@mindblisspower.demo');

-- Nivel 2: 4 nietos (Bronce)
INSERT INTO mlm.affiliate (person_id, parent_id, position, sponsor_id, path, depth, current_rank_id, status)
SELECT p.id, par.id, side.pos, par.id,
       par.path || text2ltree(side.pos::text || '_' || p.id::text),
       2, (SELECT id FROM mlm.rank WHERE code = 'BRONZE'), 'active'
  FROM (VALUES
    ('demo+ll2@mindblisspower.demo', 'demo+l1@mindblisspower.demo', 'L'),
    ('demo+lr2@mindblisspower.demo', 'demo+l1@mindblisspower.demo', 'R'),
    ('demo+rl2@mindblisspower.demo', 'demo+r1@mindblisspower.demo', 'L'),
    ('demo+rr2@mindblisspower.demo', 'demo+r1@mindblisspower.demo', 'R')
  ) AS m(child_email, parent_email, pos_)
  JOIN mlm.person p ON p.email = m.child_email
  JOIN mlm.person pp ON pp.email = m.parent_email
  JOIN mlm.affiliate par ON par.person_id = pp.id
  CROSS JOIN LATERAL (SELECT m.pos_::mlm.tree_position AS pos) side;

-- Nivel 3: 8 bisnietos (sin rango)
INSERT INTO mlm.affiliate (person_id, parent_id, position, sponsor_id, path, depth, current_rank_id, status)
SELECT p.id, par.id, side.pos, par.id,
       par.path || text2ltree(side.pos::text || '_' || p.id::text),
       3, NULL, 'active'
  FROM (VALUES
    ('demo+n7@mindblisspower.demo',  'demo+ll2@mindblisspower.demo', 'L'),
    ('demo+n8@mindblisspower.demo',  'demo+ll2@mindblisspower.demo', 'R'),
    ('demo+n9@mindblisspower.demo',  'demo+lr2@mindblisspower.demo', 'L'),
    ('demo+n10@mindblisspower.demo', 'demo+lr2@mindblisspower.demo', 'R'),
    ('demo+n11@mindblisspower.demo', 'demo+rl2@mindblisspower.demo', 'L'),
    ('demo+n12@mindblisspower.demo', 'demo+rl2@mindblisspower.demo', 'R'),
    ('demo+n13@mindblisspower.demo', 'demo+rr2@mindblisspower.demo', 'L'),
    ('demo+n14@mindblisspower.demo', 'demo+rr2@mindblisspower.demo', 'R')
  ) AS m(child_email, parent_email, pos_)
  JOIN mlm.person p ON p.email = m.child_email
  JOIN mlm.person pp ON pp.email = m.parent_email
  JOIN mlm.affiliate par ON par.person_id = pp.id
  CROSS JOIN LATERAL (SELECT m.pos_::mlm.tree_position AS pos) side;

-- Verificación
SELECT 'demo island: ' || count(*) || ' afiliados (esperado 15)' FROM mlm.affiliate a
  JOIN mlm.person p ON p.id = a.person_id
 WHERE p.email = 'guardcolombia@gmail.com' OR p.email LIKE '%@mindblisspower.demo';

SELECT 'detached restantes: ' || count(*) FROM mlm.affiliate
 WHERE parent_id IS NULL AND legacy_id_vicionario IN (393, 12277);

COMMIT;
