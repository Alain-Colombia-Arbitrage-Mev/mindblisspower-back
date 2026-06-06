SET NOCOUNT ON;
USE viciongroup;

PRINT '===SECTION=== 1_tree_basics';
SELECT COUNT(*) AS total_vicionarios FROM vicionario;
SELECT COUNT(*) AS total_persons FROM person;
SELECT COUNT(*) AS roots FROM vicionario WHERE idVicionarioParent IS NULL;
SELECT MAX(level) AS max_level, AVG(CAST(level AS FLOAT)) AS avg_level FROM vicionario;

PRINT '===SECTION=== 2_tree_integrity';
-- Parent orphans
SELECT COUNT(*) AS parent_orphans
FROM vicionario v
LEFT JOIN vicionario p ON v.idVicionarioParent = p.idVicionario
WHERE v.idVicionarioParent IS NOT NULL AND p.idVicionario IS NULL;

-- Self-reference
SELECT COUNT(*) AS self_parent FROM vicionario WHERE idVicionarioParent = idVicionario;
SELECT COUNT(*) AS self_left FROM vicionario WHERE idVicionarioLeft = idVicionario;
SELECT COUNT(*) AS self_right FROM vicionario WHERE idVicionarioRight = idVicionario;

-- Left child mismatch
SELECT COUNT(*) AS left_parent_mismatch
FROM vicionario p JOIN vicionario c ON p.idVicionarioLeft = c.idVicionario
WHERE c.idVicionarioParent <> p.idVicionario;

-- Right child mismatch
SELECT COUNT(*) AS right_parent_mismatch
FROM vicionario p JOIN vicionario c ON p.idVicionarioRight = c.idVicionario
WHERE c.idVicionarioParent <> p.idVicionario;

-- Left used twice (multiple parents claim same left child)
SELECT COUNT(*) AS left_used_twice FROM (
  SELECT idVicionarioLeft FROM vicionario WHERE idVicionarioLeft IS NOT NULL
  GROUP BY idVicionarioLeft HAVING COUNT(*) > 1
) x;

SELECT COUNT(*) AS right_used_twice FROM (
  SELECT idVicionarioRight FROM vicionario WHERE idVicionarioRight IS NOT NULL
  GROUP BY idVicionarioRight HAVING COUNT(*) > 1
) x;

-- Sponsor orphans
SELECT COUNT(*) AS sponsor_orphans
FROM vicionario v
WHERE v.idSponsor IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM vicionario s WHERE s.idVicionario = v.idSponsor
);

PRINT '===SECTION=== 3_tree_distribution';
-- Depth histogram
SELECT level, COUNT(*) AS nodes FROM vicionario GROUP BY level ORDER BY level;

-- Leg fill status
SELECT
  SUM(CASE WHEN idVicionarioLeft IS NOT NULL AND idVicionarioRight IS NOT NULL THEN 1 ELSE 0 END) AS both_legs,
  SUM(CASE WHEN idVicionarioLeft IS NOT NULL AND idVicionarioRight IS NULL THEN 1 ELSE 0 END) AS only_left,
  SUM(CASE WHEN idVicionarioLeft IS NULL AND idVicionarioRight IS NOT NULL THEN 1 ELSE 0 END) AS only_right,
  SUM(CASE WHEN idVicionarioLeft IS NULL AND idVicionarioRight IS NULL THEN 1 ELSE 0 END) AS leaves
FROM vicionario;

-- Direct referrals per sponsor (top 10)
SELECT TOP 10 idSponsor, COUNT(*) AS direct_count
FROM vicionario WHERE idSponsor IS NOT NULL
GROUP BY idSponsor ORDER BY COUNT(*) DESC;

-- Count of sponsors by referral buckets
SELECT
  SUM(CASE WHEN c = 0 THEN 1 ELSE 0 END) AS zero_directs,
  SUM(CASE WHEN c = 1 THEN 1 ELSE 0 END) AS one_direct,
  SUM(CASE WHEN c BETWEEN 2 AND 5 THEN 1 ELSE 0 END) AS two_to_five,
  SUM(CASE WHEN c BETWEEN 6 AND 20 THEN 1 ELSE 0 END) AS six_to_twenty,
  SUM(CASE WHEN c > 20 THEN 1 ELSE 0 END) AS over_twenty
FROM (
  SELECT v.idVicionario, COUNT(s.idVicionario) AS c
  FROM vicionario v
  LEFT JOIN vicionario s ON s.idSponsor = v.idVicionario
  GROUP BY v.idVicionario
) x;

-- Tree volumes distribution
SELECT
  MIN(volumeLeft + volumeRight) AS min_vol,
  MAX(volumeLeft + volumeRight) AS max_vol,
  AVG(CAST(volumeLeft + volumeRight AS BIGINT)) AS avg_vol,
  SUM(CASE WHEN volumeLeft = 0 AND volumeRight = 0 THEN 1 ELSE 0 END) AS zero_vol_nodes
FROM vicionario;

-- Left/right imbalance
SELECT
  SUM(CASE WHEN volumeLeft > 0 AND volumeRight > 0 THEN 1 ELSE 0 END) AS both_active,
  SUM(CASE WHEN volumeLeft > 0 AND volumeRight = 0 THEN 1 ELSE 0 END) AS only_left_vol,
  SUM(CASE WHEN volumeLeft = 0 AND volumeRight > 0 THEN 1 ELSE 0 END) AS only_right_vol,
  SUM(CASE WHEN volumeLeft = 0 AND volumeRight = 0 THEN 1 ELSE 0 END) AS inactive
FROM vicionario;

PRINT '===SECTION=== 4_movement_schema';
SELECT
  c.name AS col_name, TYPE_NAME(c.user_type_id) AS data_type,
  c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity
FROM sys.columns c
WHERE c.object_id = OBJECT_ID('movement')
ORDER BY c.column_id;

PRINT '===SECTION=== 5_wallet_schema';
SELECT
  c.name AS col_name, TYPE_NAME(c.user_type_id) AS data_type,
  c.max_length, c.precision, c.scale, c.is_nullable
FROM sys.columns c
WHERE c.object_id = OBJECT_ID('wallet')
ORDER BY c.column_id;

PRINT '===SECTION=== 6_concept_list';
SELECT TOP 100 * FROM concept ORDER BY 1;

PRINT '===SECTION=== 7_movement_by_concept';
SELECT TOP 50 m.idConcept, COUNT(*) AS ops
FROM movement m
GROUP BY m.idConcept
ORDER BY COUNT(*) DESC;

PRINT '===SECTION=== 8_movement_bounds';
SELECT MIN(idmovement) AS min_id, MAX(idmovement) AS max_id, COUNT(*) AS total FROM movement;

PRINT '===SECTION=== 9_antipattern_varchar_max';
SELECT t.name AS table_name, c.name AS col_name, TYPE_NAME(c.user_type_id) AS dt
FROM sys.columns c JOIN sys.tables t ON c.object_id = t.object_id
WHERE c.max_length = -1 AND TYPE_NAME(c.user_type_id) IN ('varchar','nvarchar','varbinary')
ORDER BY t.name, c.column_id;

PRINT '===SECTION=== 10_antipattern_float_money';
SELECT t.name AS table_name, c.name AS col_name, TYPE_NAME(c.user_type_id) AS dt
FROM sys.columns c JOIN sys.tables t ON c.object_id = t.object_id
WHERE TYPE_NAME(c.user_type_id) IN ('float','real')
ORDER BY t.name, c.column_id;

PRINT '===SECTION=== 11_antipattern_sql_variant';
SELECT t.name AS table_name, c.name AS col_name
FROM sys.columns c JOIN sys.tables t ON c.object_id = t.object_id
WHERE TYPE_NAME(c.user_type_id) = 'sql_variant';

PRINT '===SECTION=== 12_tables_no_pk';
SELECT t.name AS table_name
FROM sys.tables t
WHERE NOT EXISTS (SELECT 1 FROM sys.indexes i WHERE i.object_id = t.object_id AND i.is_primary_key = 1);

PRINT '===SECTION=== 13_audit_columns_coverage';
WITH cov AS (
  SELECT t.object_id,
    MAX(CASE WHEN LOWER(c.name) LIKE '%creationtime%' THEN 1 ELSE 0 END) AS h_creation,
    MAX(CASE WHEN LOWER(c.name) LIKE '%timeupdate%' OR LOWER(c.name) LIKE '%updatetime%' THEN 1 ELSE 0 END) AS h_update,
    MAX(CASE WHEN LOWER(c.name) LIKE '%deleted%' OR LOWER(c.name) LIKE '%idstatus%' THEN 1 ELSE 0 END) AS h_deleted
  FROM sys.tables t LEFT JOIN sys.columns c ON c.object_id = t.object_id
  GROUP BY t.object_id
)
SELECT SUM(h_creation) AS has_creation, SUM(h_update) AS has_update,
  SUM(h_deleted) AS has_deleted_or_status, COUNT(*) AS total_tables FROM cov;

PRINT '===SECTION=== 14_mlm_log_range';
SELECT
  MIN(idLogDetailVicionarioNetwork) AS min_id,
  MAX(idLogDetailVicionarioNetwork) AS max_id,
  COUNT_BIG(*) AS total_rows
FROM logDetailVicionarioNetwork WITH (NOLOCK);
