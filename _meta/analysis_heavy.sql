SET NOCOUNT ON;
USE viciongroup;

PRINT '===SECTION=== H1_mlm_log_schema';
SELECT c.name, TYPE_NAME(c.user_type_id) AS dt, c.max_length, c.precision, c.scale, c.is_nullable
FROM sys.columns c WHERE c.object_id = OBJECT_ID('logDetailVicionarioNetwork')
ORDER BY c.column_id;

PRINT '===SECTION=== H2_mlm_log_date_bounds';
-- Use MIN/MAX on id (clustered) to get range in chunks
SELECT MIN(creationTime) AS min_date, MAX(creationTime) AS max_date
FROM logDetailVicionarioNetwork WITH (NOLOCK)
WHERE idLogDetailVicionarioNetwork IN (1, 416965624);

PRINT '===SECTION=== H3_mlm_log_sample_dates_by_id_chunks';
-- Sample creationTime at 10 equidistant ID positions to estimate growth
SELECT x.chunk, x.creationTime FROM (
  SELECT 0 AS chunk, creationTime FROM logDetailVicionarioNetwork WITH (NOLOCK) WHERE idLogDetailVicionarioNetwork = 1
  UNION ALL SELECT 1, creationTime FROM logDetailVicionarioNetwork WITH (NOLOCK) WHERE idLogDetailVicionarioNetwork = 41696562
  UNION ALL SELECT 2, creationTime FROM logDetailVicionarioNetwork WITH (NOLOCK) WHERE idLogDetailVicionarioNetwork = 83393125
  UNION ALL SELECT 3, creationTime FROM logDetailVicionarioNetwork WITH (NOLOCK) WHERE idLogDetailVicionarioNetwork = 125089687
  UNION ALL SELECT 4, creationTime FROM logDetailVicionarioNetwork WITH (NOLOCK) WHERE idLogDetailVicionarioNetwork = 166786250
  UNION ALL SELECT 5, creationTime FROM logDetailVicionarioNetwork WITH (NOLOCK) WHERE idLogDetailVicionarioNetwork = 208482812
  UNION ALL SELECT 6, creationTime FROM logDetailVicionarioNetwork WITH (NOLOCK) WHERE idLogDetailVicionarioNetwork = 250179375
  UNION ALL SELECT 7, creationTime FROM logDetailVicionarioNetwork WITH (NOLOCK) WHERE idLogDetailVicionarioNetwork = 291875937
  UNION ALL SELECT 8, creationTime FROM logDetailVicionarioNetwork WITH (NOLOCK) WHERE idLogDetailVicionarioNetwork = 333572500
  UNION ALL SELECT 9, creationTime FROM logDetailVicionarioNetwork WITH (NOLOCK) WHERE idLogDetailVicionarioNetwork = 375269062
  UNION ALL SELECT 10, creationTime FROM logDetailVicionarioNetwork WITH (NOLOCK) WHERE idLogDetailVicionarioNetwork = 416965624
) x ORDER BY x.chunk;

PRINT '===SECTION=== H4_mlm_log_orphan_vicionario_sample';
-- Sample first 1M rows for orphan check
SELECT COUNT(*) AS orphans_in_first_1M
FROM logDetailVicionarioNetwork l WITH (NOLOCK)
WHERE l.idLogDetailVicionarioNetwork <= 1000000
AND l.idVicionario IS NOT NULL
AND NOT EXISTS (SELECT 1 FROM vicionario v WHERE v.idVicionario = l.idVicionario);

PRINT '===SECTION=== H5_movement_frozen_count';
SELECT COUNT(*) AS frozen_movs, SUM(CASE WHEN frozen=1 THEN 1 ELSE 0 END) AS frozen_true
FROM movement;

PRINT '===SECTION=== H6_movement_has_idMovRef';
SELECT COUNT(*) AS with_ref, COUNT(*) - SUM(CASE WHEN idMovRef IS NULL THEN 1 ELSE 0 END) AS non_null_ref
FROM movement;

PRINT '===SECTION=== H7_wallet_balance_check_sample';
-- Sample: verify ledger integrity on 10 random wallets by summing movement*factor
SELECT TOP 10 w.idWallet, w.idVicionario,
  SUM(m.import * c.factor) AS computed_balance,
  COUNT(*) AS move_count
FROM wallet w
JOIN movement m ON m.idWallet = w.idWallet
JOIN concept c ON c.idConcept = m.idConcept
GROUP BY w.idWallet, w.idVicionario
ORDER BY w.idWallet;

PRINT '===SECTION=== H8_triggers_source';
SELECT OBJECT_NAME(parent_id) AS table_name, name, OBJECT_DEFINITION(object_id) AS body
FROM sys.triggers
ORDER BY OBJECT_NAME(parent_id), name;

PRINT '===SECTION=== H9_vicionario_ancestors_sample';
-- Check length distribution of materialized path columns
SELECT
  MAX(LEN(vicionarioAncestors)) AS max_ancestors_len,
  AVG(LEN(vicionarioAncestors)) AS avg_ancestors_len,
  MAX(LEN(sponsorshipline)) AS max_sline_len,
  AVG(LEN(sponsorshipline)) AS avg_sline_len,
  MAX(LEN(directLeft)) AS max_dleft_len,
  MAX(LEN(directRight)) AS max_dright_len
FROM vicionario;

PRINT '===SECTION=== H10_vicionario_sample_text';
SELECT TOP 3 idVicionario, level, distanceSponsor,
  LEFT(vicionarioAncestors, 200) AS ancestors_preview,
  LEFT(sponsorshipline, 200) AS sline_preview,
  LEFT(directLeft, 100) AS dleft_preview
FROM vicionario
WHERE vicionarioAncestors IS NOT NULL AND LEN(vicionarioAncestors) > 50
ORDER BY LEN(vicionarioAncestors) DESC;

PRINT '===SECTION=== H11_logDetail_by_year_sample';
-- Approximate yearly distribution via id ranges mapped to creationTime
SELECT YEAR(creationTime) AS yr, COUNT_BIG(*) AS rows_approx
FROM logDetailVicionarioNetwork WITH (NOLOCK)
WHERE idLogDetailVicionarioNetwork <= 10000000
GROUP BY YEAR(creationTime);
