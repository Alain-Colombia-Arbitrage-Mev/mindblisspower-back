SET NOCOUNT ON;
USE viciongroup;

PRINT '===SECTION=== M1_rank_ladder';
SELECT idRank, nameES, points, accumulatedPoints, bonus, idPreviousRank
FROM rank ORDER BY ISNULL(accumulatedPoints, 0), idRank;

PRINT '===SECTION=== M2_package_pricing';
SELECT * FROM package ORDER BY 1;

PRINT '===SECTION=== M3_total_money_in_vs_out_by_concept';
SELECT c.idConcept, c.nameES, c.factor,
  COUNT(*) AS ops,
  SUM(m.import) AS total_import,
  SUM(m.import * c.factor) AS net_signed
FROM movement m JOIN concept c ON m.idConcept = c.idConcept
GROUP BY c.idConcept, c.nameES, c.factor
ORDER BY SUM(m.import) DESC;

PRINT '===SECTION=== M4_rank_distribution';
SELECT v.idRank, r.nameES, COUNT(*) AS vicionarios
FROM vicionario v LEFT JOIN rank r ON v.idRank = r.idRank
GROUP BY v.idRank, r.nameES
ORDER BY COUNT(*) DESC;

PRINT '===SECTION=== M5_carry_distribution';
SELECT
  COUNT(*) AS total_with_carry,
  AVG(CAST(carryLeft + carryRight AS BIGINT)) AS avg_total_carry,
  MAX(carryLeft + carryRight) AS max_carry,
  SUM(carryLeft) AS total_carry_left,
  SUM(carryRight) AS total_carry_right
FROM vicionario WHERE carryLeft + carryRight > 0;

PRINT '===SECTION=== M6_binary_balance_signal';
-- For each node with both legs, ratio of lesser/stronger
SELECT
  COUNT(*) AS nodes_with_volume_both_legs,
  AVG(CAST(
    CASE WHEN volumeLeft >= volumeRight
      THEN volumeRight * 100.0 / NULLIF(volumeLeft,0)
      ELSE volumeLeft * 100.0 / NULLIF(volumeRight,0)
    END AS FLOAT)) AS avg_lesser_pct_of_stronger
FROM vicionario WHERE volumeLeft > 0 AND volumeRight > 0;

PRINT '===SECTION=== M7_sponsor_vs_placement_divergence';
-- How often sponsor != placement parent (indicates spillover)
SELECT
  COUNT(*) AS placed_nodes,
  SUM(CASE WHEN idSponsor = idVicionarioParent THEN 1 ELSE 0 END) AS sponsor_eq_parent,
  SUM(CASE WHEN idSponsor <> idVicionarioParent THEN 1 ELSE 0 END) AS spillover_nodes,
  AVG(CAST(distanceSponsor AS FLOAT)) AS avg_distance_sponsor,
  MAX(distanceSponsor) AS max_distance_sponsor
FROM vicionario WHERE idVicionarioParent IS NOT NULL;

PRINT '===SECTION=== M8_points_history_sample';
-- Logic of how binary points are calculated per event
SELECT TOP 5 *
FROM logVicionarioPointsHistory
ORDER BY idLogVicionarioPointsHistory DESC;

PRINT '===SECTION=== M9_leadership_bonus_records';
SELECT TOP 10 idVicionario, idRank, points, bonus, creationTime, idLeftDirect, idRightDirect
FROM vicionarioLeadershipBonusRecord
ORDER BY creationTime DESC;

PRINT '===SECTION=== M10_top_earners';
-- Total credits received per vicionario
SELECT TOP 15 m.idVicionario, COUNT(*) AS ops, SUM(m.import * c.factor) AS net_earnings
FROM movement m
JOIN concept c ON m.idConcept = c.idConcept
WHERE m.idVicionario IS NOT NULL
GROUP BY m.idVicionario
ORDER BY SUM(m.import * c.factor) DESC;

PRINT '===SECTION=== M11_subtree_size_via_ancestors';
-- Sample: how big is the subtree under root vicionario 1?
SELECT TOP 1 idVicionario, level, LEN(vicionarioAncestors) AS path_len, distanceSponsor
FROM vicionario WHERE idVicionario = 1;

-- Approximate subtree size of top sponsors via path enumeration
SELECT TOP 10 root_id, COUNT(*) AS subtree_size
FROM (
  SELECT 1 AS root_id, idVicionario FROM vicionario WHERE vicionarioAncestors LIKE '1/%' OR idVicionario = 1
  UNION ALL
  SELECT 3, idVicionario FROM vicionario WHERE vicionarioAncestors LIKE '%/3/%' OR vicionarioAncestors LIKE '3/%' OR idVicionario = 3
) x GROUP BY root_id ORDER BY 2 DESC;
