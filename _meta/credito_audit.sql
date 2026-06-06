SET NOCOUNT ON;
USE viciongroup;

PRINT '===SECTION=== C0_concept_15_16_summary';
SELECT c.idConcept, c.nameES, c.factor,
  COUNT(*) AS ops,
  SUM(m.import) AS total_import,
  MIN(m.dateMovement) AS first_date,
  MAX(m.dateMovement) AS last_date,
  COUNT(DISTINCT m.idPerson) AS distinct_creators,
  COUNT(DISTINCT m.idVicionario) AS distinct_vicionarios
FROM movement m JOIN concept c ON c.idConcept = m.idConcept
WHERE m.idConcept IN (15, 16)
GROUP BY c.idConcept, c.nameES, c.factor
ORDER BY c.idConcept;

PRINT '===SECTION=== C1_credito_top_creators';
-- Quien INSERTA los movements de credito (idPerson = creador del movimiento)
SELECT TOP 20
  m.idPerson AS creator_person,
  p.username AS creator_username,
  COUNT(*) AS ops,
  SUM(m.import) AS total_import,
  MIN(m.dateMovement) AS first_date,
  MAX(m.dateMovement) AS last_date
FROM movement m
LEFT JOIN person p ON p.idPerson = m.idPerson
WHERE m.idConcept = 16
GROUP BY m.idPerson, p.username
ORDER BY SUM(m.import) DESC;

PRINT '===SECTION=== C2_credito_top_recipients';
-- Quien recibe los creditos (idVicionario)
SELECT TOP 20
  m.idVicionario,
  COUNT(*) AS ops,
  SUM(m.import) AS total_received,
  MIN(m.dateMovement) AS first_date,
  MAX(m.dateMovement) AS last_date
FROM movement m
WHERE m.idConcept = 16 AND m.idVicionario IS NOT NULL
GROUP BY m.idVicionario
ORDER BY SUM(m.import) DESC;

PRINT '===SECTION=== C3_reference_text_topcount';
-- El texto del campo reference: que estan escribiendo ahi
SELECT TOP 30
  CASE WHEN m.reference IS NULL OR LEN(m.reference)=0 THEN '<NULL/empty>'
       ELSE LEFT(m.reference, 200) END AS ref_preview,
  COUNT(*) AS ops,
  SUM(m.import) AS total_import
FROM movement m
WHERE m.idConcept = 16
GROUP BY CASE WHEN m.reference IS NULL OR LEN(m.reference)=0 THEN '<NULL/empty>'
              ELSE LEFT(m.reference, 200) END
ORDER BY COUNT(*) DESC;

PRINT '===SECTION=== C4_reference_text_topvalue';
-- Por monto (puede ser distinto a por count)
SELECT TOP 20
  CASE WHEN m.reference IS NULL OR LEN(m.reference)=0 THEN '<NULL/empty>'
       ELSE LEFT(m.reference, 200) END AS ref_preview,
  COUNT(*) AS ops,
  SUM(m.import) AS total_import
FROM movement m
WHERE m.idConcept = 16
GROUP BY CASE WHEN m.reference IS NULL OR LEN(m.reference)=0 THEN '<NULL/empty>'
              ELSE LEFT(m.reference, 200) END
ORDER BY SUM(m.import) DESC;

PRINT '===SECTION=== C5_credito_via_movref_chain';
-- idMovRef enlaza un movement con otro (reverso, link). Cuantos creditos lo usan
SELECT
  COUNT(*) AS total_credito,
  SUM(CASE WHEN idMovRef IS NOT NULL THEN 1 ELSE 0 END) AS with_movref,
  SUM(CASE WHEN idMovRef IS NULL     THEN 1 ELSE 0 END) AS without_movref,
  SUM(CASE WHEN idVicionarioPackage IS NOT NULL THEN 1 ELSE 0 END) AS with_pkg,
  SUM(CASE WHEN idVicionarioPackageOrigin IS NOT NULL THEN 1 ELSE 0 END) AS with_pkg_origin
FROM movement WHERE idConcept = 16;

PRINT '===SECTION=== C6_credito_what_concept_does_movref_point_to';
-- Si idMovRef apunta a otro movement, que concepto era ese movement origen?
SELECT TOP 20
  ref.idConcept AS source_concept,
  cref.nameES AS source_concept_name,
  COUNT(*) AS ops,
  SUM(m.import) AS total_credito
FROM movement m
JOIN movement ref ON ref.idMovement = m.idMovRef
JOIN concept cref ON cref.idConcept = ref.idConcept
WHERE m.idConcept = 16
GROUP BY ref.idConcept, cref.nameES
ORDER BY COUNT(*) DESC;

PRINT '===SECTION=== C7_pairing_credito_vs_debito_same_day_same_user';
-- Hay correspondencia 1:1 entre credito y debito por usuario/fecha?
SELECT
  COUNT(*) AS distinct_user_day_pairs,
  SUM(CASE WHEN c16_total = c15_total THEN 1 ELSE 0 END) AS exact_matches,
  SUM(CASE WHEN c15_total = 0 THEN 1 ELSE 0 END) AS only_credito_no_debito,
  SUM(CASE WHEN c16_total = 0 THEN 1 ELSE 0 END) AS only_debito_no_credito
FROM (
  SELECT m.idVicionario, m.dateMovement,
    SUM(CASE WHEN m.idConcept=16 THEN m.import ELSE 0 END) AS c16_total,
    SUM(CASE WHEN m.idConcept=15 THEN m.import ELSE 0 END) AS c15_total
  FROM movement m
  WHERE m.idConcept IN (15,16) AND m.idVicionario IS NOT NULL
  GROUP BY m.idVicionario, m.dateMovement
) x;

PRINT '===SECTION=== C8_credito_size_distribution';
-- Distribucion de montos: son chicos rutinarios o pocos pero grandes?
SELECT
  CASE
    WHEN import < 10        THEN 'a_<10'
    WHEN import < 100       THEN 'b_10-100'
    WHEN import < 1000      THEN 'c_100-1k'
    WHEN import < 10000     THEN 'd_1k-10k'
    WHEN import < 100000    THEN 'e_10k-100k'
    WHEN import < 1000000   THEN 'f_100k-1M'
    ELSE                         'g_>=1M'
  END AS bucket,
  COUNT(*) AS ops,
  SUM(import) AS total_import,
  MIN(import) AS min_amt,
  MAX(import) AS max_amt
FROM movement WHERE idConcept = 16
GROUP BY CASE
    WHEN import < 10        THEN 'a_<10'
    WHEN import < 100       THEN 'b_10-100'
    WHEN import < 1000      THEN 'c_100-1k'
    WHEN import < 10000     THEN 'd_1k-10k'
    WHEN import < 100000    THEN 'e_10k-100k'
    WHEN import < 1000000   THEN 'f_100k-1M'
    ELSE                         'g_>=1M'
  END
ORDER BY bucket;

PRINT '===SECTION=== C9_credito_by_month';
-- Crece, decrece, es estacional?
SELECT
  YEAR(dateMovement)*100 + MONTH(dateMovement) AS yyyymm,
  COUNT(*) AS ops,
  SUM(import) AS total_import,
  COUNT(DISTINCT idVicionario) AS distinct_users
FROM movement WHERE idConcept = 16
GROUP BY YEAR(dateMovement)*100 + MONTH(dateMovement)
ORDER BY 1;

PRINT '===SECTION=== C10_credito_creator_role_breakdown';
-- Que rol tienen los creadores (admin? usuario normal?)
SELECT TOP 20
  r.nameES AS creator_role,
  COUNT(*) AS ops,
  SUM(m.import) AS total_import,
  COUNT(DISTINCT m.idPerson) AS distinct_creators
FROM movement m
JOIN person p ON p.idPerson = m.idPerson
LEFT JOIN role r ON r.idRole = p.idRole
WHERE m.idConcept = 16
GROUP BY r.nameES
ORDER BY SUM(m.import) DESC;

PRINT '===SECTION=== C11_sample_credito_full_rows';
-- 10 movements completos para inspeccion ojo humano
SELECT TOP 10
  idMovement, dateMovement, timeCreation,
  idVicionario, idVicionarioPackage, idVicionarioPackageOrigin, idMovRef,
  idPerson, idWallet, import,
  LEFT(ISNULL(reference,''), 300) AS reference_preview
FROM movement
WHERE idConcept = 16
ORDER BY import DESC;

PRINT '===SECTION=== C12_credito_vs_other_outflow_concepts';
-- Comparar concept 16 vs otros conceptos +1 grandes
SELECT c.idConcept, c.nameES, c.factor,
  COUNT(*) AS ops, SUM(m.import) AS total
FROM movement m JOIN concept c ON c.idConcept = m.idConcept
WHERE c.factor = 1
GROUP BY c.idConcept, c.nameES, c.factor
ORDER BY SUM(m.import) DESC;
