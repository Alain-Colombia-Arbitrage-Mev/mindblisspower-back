-- =============================================================================
-- rehearsal_fixture.sql — Mini-árbol 2.0 FALSO para ensayar la migración
-- completa (00_rank_map_seed → 02_postload → 03_backfill → 04_reconcile)
-- sin el .bak real. Simula lo que pgloader dejaría en staging.*
--
-- Árbol de prueba (8 vicionarios):
--                  1 (Corona, id legacy rank 12)
--                 /  \
--           [L] 2     3 [R]        2: Diamante(8) · 3: Oro(3)
--              / \   / \
--             4   5 6   7          4: Bronce(1) · 6: Plata(2) · 5,7: sin rango
--            /
--           8                      8: sin rango
--
-- Incluye A PROPÓSITO:
--   - Volúmenes legacy ENORMES en staging.vicionario (deben ser IGNORADOS)
--   - 1 movimiento con fecha corrupta año 0002 (debe ir a cuarentena)
--   - 1 movimiento de $1.5M (debe quedar flageado en audit)
--   - Rangos en movimientos (idrank legacy → mapeo a 1-14)
-- =============================================================================

\set ON_ERROR_STOP 1

DROP SCHEMA IF EXISTS staging CASCADE;
CREATE SCHEMA staging;

-- Tipos: como los deja pgloader (datetime → timestamp SIN tz, bit → boolean)
CREATE TABLE staging.country (idcountry int, iso2 text, namees text, nameen text, codenumber text, regex text);
CREATE TABLE staging.asset (idasset int, name text, currentvaluedls numeric, lastupdatetime timestamp);
CREATE TABLE staging.concept (idconcept int, namees text, nameen text, factor smallint, active boolean);
CREATE TABLE staging.package (idpackage int, name text, amount numeric, idtype int, isactive boolean, timeupdated timestamp);
CREATE TABLE staging.person (
  idperson int, firstname text, lastname text, alias text, email text,
  idcountryphone int, phonenumber text, birthday date, idcountrybirthday int,
  idstatus int, idrole int, blacklist boolean, creationtime timestamp, timeupdated timestamp);
CREATE TABLE staging.vicionario (
  idvicionario int, idperson int, invitationlink text, idrank int, idstatus int,
  idvicionarioparent int, idvicionarioleft int, idvicionarioright int, idsponsor int,
  kycapproved boolean, timekycapproved timestamp, creationtime timestamp,
  -- volúmenes legacy: NO deben migrar (la prueba: valores absurdos)
  volumeleft bigint, volumeright bigint,
  totalpointsleft bigint, totalpointsright bigint,
  currentpointsleft bigint, currentpointsright bigint,
  carryleft numeric, carryright numeric);
CREATE TABLE staging.wallet (idwallet int, idvicionario int, idasset int, address text, timecreation timestamp);
CREATE TABLE staging.vicionariopackage (
  idvicionariopackage int, idvicionario int, idpackage int, idstatus int,
  idpaymentmethod int, paymentproofpublicurl text, transactionhash text,
  currentperioddate date, idperiodicity int, creationtime timestamp, updatetime timestamp);
CREATE TABLE staging.movement (
  idmovement int, idwallet int, idconcept int, import numeric,
  reference text, timecreation timestamp, datemovement date, dateavailable date,
  frozen boolean, idvicionariopackage int, idvicionariopackageorigin int, idrank int);
CREATE TABLE staging.vicionariomoneyaccount (
  idvicionariomoneyaccount int, idvicionario int, idbank int, idasset int,
  account text, clabe text, nameaccount text, address text, creationtime timestamp);
CREATE TABLE staging.withdrawalrequest (
  idwithdrawalrequest int, idvicionario int, idwallet int, importrequest numeric,
  idstatus int, idmovement int, comments text, remark text, idpersonupdate int,
  creationtime timestamp, updatetime timestamp);

-- Catálogos
INSERT INTO staging.country VALUES (1, 'CO', 'Colombia', 'Colombia', '57', NULL);
INSERT INTO staging.asset VALUES (1, 'USD', 1.0, '2026-01-01 00:00:00');
INSERT INTO staging.concept VALUES
  ( 1, 'Cargo por compra de paquete', 'Package purchase charge', -1, true),
  ( 3, 'ROI', 'ROI', 1, true),
  (11, 'Bono Binario', 'Binary bonus', 1, true),
  (12, 'Retiro', 'Withdrawal', -1, true),
  (15, 'Débito', 'Debit', -1, true),
  (16, 'Crédito', 'Credit', 1, true);
INSERT INTO staging.package VALUES
  (4, 'Pack 4', 100.00, 11001, true, '2026-01-01 00:00:00'),
  (9, 'Pack 9', 5000.00, 11001, true, '2026-01-01 00:00:00');

-- Personas 1-8
INSERT INTO staging.person VALUES
  (1, 'Ana',    'Root',   NULL, 'ana@test.co',    1, '3001', '1980-01-01', 1, 1, 2, false, '2020-02-01 10:00:00', NULL),
  (2, 'Beto',   'Izq',    NULL, 'beto@test.co',   1, '3002', '1985-02-02', 1, 1, 2, false, '2020-03-01 10:00:00', NULL),
  (3, 'Caro',   'Der',    NULL, 'caro@test.co',   1, '3003', '1990-03-03', 1, 1, 2, false, '2020-03-15 10:00:00', NULL),
  (4, 'Dario',  'IzqIzq', NULL, 'dario@test.co',  1, '3004', '1992-04-04', 1, 1, 2, false, '2021-01-10 10:00:00', NULL),
  (5, 'Elena',  'IzqDer', NULL, 'elena@test.co',  1, '3005', '1993-05-05', 1, 1, 2, false, '2021-02-11 10:00:00', NULL),
  (6, 'Fabio',  'DerIzq', NULL, 'fabio@test.co',  1, '3006', '1994-06-06', 1, 1, 2, false, '2021-03-12 10:00:00', NULL),
  (7, 'Gina',   'DerDer', NULL, 'gina@test.co',   1, '3007', '1995-07-07', 1, 1, 2, false, '2021-04-13 10:00:00', NULL),
  (8, 'Hugo',   'Nieto',  NULL, 'hugo@test.co',   1, '3008', '1996-08-08', 1, 1, 2, false, '2022-05-14 10:00:00', NULL);

-- Vicionarios: árbol + rangos + VOLÚMENES ABSURDOS que deben ignorarse
INSERT INTO staging.vicionario
  (idvicionario, idperson, invitationlink, idrank, idstatus,
   idvicionarioparent, idvicionarioleft, idvicionarioright, idsponsor,
   kycapproved, timekycapproved, creationtime,
   volumeleft, volumeright, totalpointsleft, totalpointsright,
   currentpointsleft, currentpointsright, carryleft, carryright) VALUES
  (1, 1, 'inv-1', 12, 1, NULL, 2, 3, NULL, true, '2020-02-02 09:00:00', '2020-02-01 10:00:00',
   88888888, 77777777, 125895215, 118643795, 2913625, 115035550, 50000.55, 60000.66),
  (2, 2, 'inv-2',  8, 1, 1, 4, 5, 1, true, '2020-03-02 09:00:00', '2020-03-01 10:00:00',
   5555555, 4444444, 9999999, 8888888, 111111, 222222, 1234.56, 7890.12),
  (3, 3, 'inv-3',  3, 1, 1, 6, 7, 1, true, '2020-03-16 09:00:00', '2020-03-15 10:00:00',
   333333, 222222, 444444, 555555, 66666, 77777, 0, 999.99),
  (4, 4, 'inv-4',  1, 1, 2, 8, NULL, 1, false, NULL, '2021-01-10 10:00:00',
   111111, 0, 222222, 0, 11111, 0, 500.00, 0),
  (5, 5, 'inv-5', NULL, 1, 2, NULL, NULL, 2, false, NULL, '2021-02-11 10:00:00',
   0, 99999, 0, 88888, 0, 7777, 0, 0),
  (6, 6, 'inv-6',  2, 1, 3, NULL, NULL, 3, true, '2021-03-13 09:00:00', '2021-03-12 10:00:00',
   44444, 33333, 55555, 44444, 3333, 2222, 100.10, 200.20),
  (7, 7, 'inv-7', NULL, 1, 3, NULL, NULL, 3, false, NULL, '2021-04-13 10:00:00',
   0, 0, 12345, 54321, 0, 0, 0, 0),
  (8, 8, 'inv-8', NULL, 1, 4, NULL, NULL, 2, false, NULL, '2022-05-14 10:00:00',
   0, 0, 0, 0, 0, 0, 0, 0);

-- Wallets 1:1
INSERT INTO staging.wallet
SELECT idvicionario, idvicionario, 1, 'addr-' || idvicionario::text, creationtime
  FROM staging.vicionario;

-- Packs activos
INSERT INTO staging.vicionariopackage VALUES
  (1, 1, 9, 1, 1, NULL, NULL, '2025-01-15', 1, '2025-01-15 12:00:00', '2025-06-15 12:00:00'),
  (2, 2, 4, 1, 1, NULL, NULL, '2025-02-20', 1, '2025-02-20 12:00:00', NULL),
  (3, 4, 4, 2, 1, NULL, NULL, NULL,         1, '2025-03-25 12:00:00', NULL);

-- Movimientos: incluye 1 corrupto (año 0002 → cuarentena) y 1 mega ($1.5M → flag)
INSERT INTO staging.movement VALUES
  (1, 1,  1,     100.00, 'compra pack', '2025-03-10 08:00:00', '2025-03-10', NULL, false, 1, NULL, NULL),
  (2, 2,  3,      50.00, 'roi',         '2025-04-05 08:00:00', '2025-04-05', '2025-05-05', false, NULL, NULL, NULL),
  (3, 3, 11,      20.00, 'binario',     '2025-05-02 08:00:00', '2025-05-02', NULL, false, NULL, NULL, 3),
  (4, 1, 16, 1500000.00, 'mega credito','2025-06-15 08:00:00', '2025-06-15', NULL, false, NULL, NULL, NULL),
  (5, 4, 12,      30.00, 'retiro',      '2025-07-08 08:00:00', '2025-07-08', NULL, false, NULL, NULL, NULL),
  (6, 5,  3,      10.00, 'roi corrupto','2025-08-01 08:00:00', '0002-03-26', NULL, false, NULL, NULL, NULL),
  (7, 6, 15,      25.00, 'debito',      '2025-09-09 08:00:00', '2025-09-09', NULL, false, NULL, NULL, NULL);

INSERT INTO staging.vicionariomoneyaccount VALUES
  (1, 1, 7, NULL, '12345678', 'CLABE001', 'Ana Root', NULL, '2024-01-01 09:00:00');

INSERT INTO staging.withdrawalrequest VALUES
  (1, 4, 4, 30.00, 3, 5, 'retiro de prueba', NULL, 1, '2025-07-08 09:00:00', '2025-07-09 09:00:00');

\echo '=== Fixture staging.* listo: 8 vicionarios, 7 movimientos (1 corrupto, 1 mega) ==='
