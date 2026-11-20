-- Lift App checkout coverage to the current approved Wallet catalogue.
-- Source: Wallet c4a29a9 app/src/modules/payments/wallet-production-coverage-data.json.
-- Canonical Wallet snapshot SHA256 (LF): 3f45100cfb3de9bf793edbb80825801282829db6a94c12326a973daa8f221aaf
-- Legacy App writes and historical rows preserve their original rules.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-meld-funding-135',0));

DO $preflight$
DECLARE v_route regprocedure;
BEGIN
 v_route:=pg_catalog.to_regprocedure('payments.app_meld_funding_route_allowed(text,text,numeric,text,text,text)');
 IF pg_catalog.current_database()<>'mindbliss_curated_20261025'
  OR pg_catalog.pg_is_in_recovery()
  OR pg_catalog.to_regclass('payments.app_meld_funding_attempt') IS NULL
  OR v_route IS NULL
  OR pg_catalog.pg_get_functiondef(v_route) NOT LIKE '%VIETQR%'
  OR pg_catalog.to_regprocedure('payments.reserve_app_meld_funding(text,text,uuid,text,text,text,numeric,text,text,text,text)') IS NULL
  OR pg_catalog.to_regprocedure('payments.read_app_meld_funding_v2(text,uuid)') IS NULL
  OR pg_catalog.to_regprocedure('payments.read_app_meld_funding_v3(text,uuid)') IS NOT NULL
  OR pg_catalog.to_regprocedure('payments.app_meld_funding_wallet_route_allowed(text,text,numeric,text,text,text)') IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
   WHERE c.conrelid='payments.app_meld_funding_attempt'::regclass AND c.conname='app_meld_funding_approved_market_check'
    AND c.convalidated AND EXISTS(SELECT 1 FROM pg_catalog.pg_depend d
     WHERE d.classid='pg_catalog.pg_constraint'::regclass AND d.objid=c.oid
      AND d.refclassid='pg_catalog.pg_proc'::regclass AND d.refobjid=v_route))
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c
   WHERE c.conrelid='payments.app_meld_funding_attempt'::regclass AND c.conname='app_meld_funding_attempt_chain_id_check'
    AND c.convalidated AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%42161%137%') THEN
  RAISE EXCEPTION 'app_meld_wallet_parity_requires_134'; END IF;
END $preflight$;

CREATE FUNCTION payments.app_meld_funding_wallet_route_allowed(
 p_country text,p_currency text,p_amount numeric,p_method text,p_provider text,p_asset text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $function$
 SELECT EXISTS (
  SELECT 1 FROM (VALUES
   ('AD','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('AE','AED','ONRAMPMONEY','LOCAL_BANK_TRANSFER','USDT_POLYGON',50.00,371000.00,2),
   ('AR','ARS','ONRAMPMONEY','LOCAL_BANK_TRANSFER','USDT_POLYGON',25000.00,6600000.00,2),
   ('AT','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('AT','EUR','ONRAMPMONEY','OPEN_BANKING','USDT_POLYGON',10.00,100000.00,2),
   ('AT','EUR','ONRAMPMONEY','SEPA','USDT_POLYGON',10.00,100000.00,2),
   ('AU','AUD','BANXA','LOCAL_BANK_TRANSFER','USDT_POLYGON',20.00,5000.00,2),
   ('AU','AUD','BANXA','PAYID','USDT_POLYGON',20.00,1500.00,2),
   ('AX','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('BE','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('BE','EUR','ONRAMPMONEY','OPEN_BANKING','USDT_POLYGON',10.00,100000.00,2),
   ('BE','EUR','ONRAMPMONEY','SEPA','USDT_POLYGON',10.00,100000.00,2),
   ('BG','EUR','ONRAMPMONEY','OPEN_BANKING','USDT_POLYGON',10.00,100000.00,2),
   ('BG','EUR','ONRAMPMONEY','SEPA','USDT_POLYGON',10.00,100000.00,2),
   ('BJ','XOF','ONRAMPMONEY','MOBILE_MONEY','USDT_POLYGON',10000,1500000,0),
   ('BL','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('BR','BRL','ALCHEMYPAY','PIX','USDC_ARBITRUM',50.00,20000.00,2),
   ('BR','BRL','MERCURYO','CREDIT_DEBIT_CARD','USDC_ARBITRUM',155.65,93387.41,2),
   ('BW','BWP','ONRAMPMONEY','MOBILE_MONEY','USDT_POLYGON',150.00,1000000.00,2),
   ('CC','AUD','BANXA','LOCAL_BANK_TRANSFER','USDT_POLYGON',20.00,5000.00,2),
   ('CC','AUD','BANXA','PAYID','USDT_POLYGON',20.00,1500.00,2),
   ('CG','XAF','ONRAMPMONEY','LOCAL_BANK_TRANSFER','USDT_POLYGON',7400,1000000,0),
   ('CL','CLP','BANXA','KHIPU','USDT_POLYGON',30000,6000000,0),
   ('CM','XAF','ONRAMPMONEY','MOBILE_MONEY','USDT_POLYGON',7400,1000000,0),
   ('CO','COP','ONRAMPMONEY','LOCAL_BANK_TRANSFER','USDC_POLYGON',42300.00,59900000.00,2),
   ('CO','COP','ONRAMPMONEY','PSE','USDC_POLYGON',42300.00,59900000.00,2),
   ('CX','AUD','BANXA','LOCAL_BANK_TRANSFER','USDT_POLYGON',20.00,5000.00,2),
   ('CX','AUD','BANXA','PAYID','USDT_POLYGON',20.00,1500.00,2),
   ('CY','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('CY','EUR','ONRAMPMONEY','OPEN_BANKING','USDT_POLYGON',10.00,100000.00,2),
   ('CY','EUR','ONRAMPMONEY','SEPA','USDT_POLYGON',10.00,100000.00,2),
   ('CZ','EUR','ONRAMPMONEY','OPEN_BANKING','USDT_POLYGON',10.00,100000.00,2),
   ('CZ','EUR','ONRAMPMONEY','SEPA','USDT_POLYGON',10.00,100000.00,2),
   ('DE','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('DE','EUR','ONRAMPMONEY','OPEN_BANKING','USDT_POLYGON',10.00,100000.00,2),
   ('DE','EUR','ONRAMPMONEY','SEPA','USDT_POLYGON',10.00,100000.00,2),
   ('EE','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('EE','EUR','ONRAMPMONEY','OPEN_BANKING','USDT_POLYGON',10.00,100000.00,2),
   ('EE','EUR','ONRAMPMONEY','SEPA','USDT_POLYGON',10.00,100000.00,2),
   ('ES','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('ES','EUR','ONRAMPMONEY','OPEN_BANKING','USDT_POLYGON',10.00,100000.00,2),
   ('ES','EUR','ONRAMPMONEY','SEPA','USDT_POLYGON',10.00,100000.00,2),
   ('FI','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('FI','EUR','ONRAMPMONEY','OPEN_BANKING','USDT_POLYGON',10.00,100000.00,2),
   ('FI','EUR','ONRAMPMONEY','SEPA','USDT_POLYGON',10.00,100000.00,2),
   ('FR','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('FR','EUR','ONRAMPMONEY','OPEN_BANKING','USDT_POLYGON',10.00,100000.00,2),
   ('FR','EUR','ONRAMPMONEY','SEPA','USDT_POLYGON',10.00,100000.00,2),
   ('GA','XAF','ONRAMPMONEY','LOCAL_BANK_TRANSFER','USDT_POLYGON',7400,1000000,0),
   ('GF','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('GP','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('GR','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('GR','EUR','ONRAMPMONEY','OPEN_BANKING','USDT_POLYGON',10.00,100000.00,2),
   ('GR','EUR','ONRAMPMONEY','SEPA','USDT_POLYGON',10.00,100000.00,2),
   ('HM','AUD','BANXA','LOCAL_BANK_TRANSFER','USDT_POLYGON',20.00,5000.00,2),
   ('HM','AUD','BANXA','PAYID','USDT_POLYGON',20.00,1500.00,2),
   ('HR','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('HR','EUR','ONRAMPMONEY','OPEN_BANKING','USDT_POLYGON',10.00,100000.00,2),
   ('HR','EUR','ONRAMPMONEY','SEPA','USDT_POLYGON',10.00,100000.00,2),
   ('HU','EUR','ONRAMPMONEY','OPEN_BANKING','USDT_POLYGON',10.00,100000.00,2),
   ('HU','EUR','ONRAMPMONEY','SEPA','USDT_POLYGON',10.00,100000.00,2),
   ('ID','IDR','ONRAMPMONEY','LOCAL_BANK_TRANSFER','USDT_POLYGON',120000.00,99000000.00,2),
   ('IE','EUR','ONRAMPMONEY','OPEN_BANKING','USDT_POLYGON',10.00,100000.00,2),
   ('IE','EUR','ONRAMPMONEY','SEPA','USDT_POLYGON',10.00,100000.00,2),
   ('IN','INR','ONMETA','IMPS','USDT_POLYGON',50.00,100000.00,2),
   ('IN','INR','ONMETA','UPI','USDT_POLYGON',50.00,100000.00,2),
   ('IN','INR','ONRAMPMONEY','IMPS','USDT_POLYGON',100.00,500000.00,2),
   ('IN','INR','ONRAMPMONEY','UPI','USDT_POLYGON',100.00,500000.00,2),
   ('IS','EUR','ONRAMPMONEY','OPEN_BANKING','USDT_POLYGON',10.00,100000.00,2),
   ('IS','EUR','ONRAMPMONEY','SEPA','USDT_POLYGON',10.00,100000.00,2),
   ('IT','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('IT','EUR','ONRAMPMONEY','OPEN_BANKING','USDT_POLYGON',10.00,100000.00,2),
   ('IT','EUR','ONRAMPMONEY','SEPA','USDT_POLYGON',10.00,100000.00,2),
   ('KE','KES','ONRAMPMONEY','MPESA','USDT_POLYGON',1850.00,700000.00,2),
   ('KI','AUD','BANXA','LOCAL_BANK_TRANSFER','USDT_POLYGON',20.00,5000.00,2),
   ('KI','AUD','BANXA','PAYID','USDT_POLYGON',20.00,1500.00,2),
   ('LI','EUR','ONRAMPMONEY','OPEN_BANKING','USDT_POLYGON',10.00,100000.00,2),
   ('LI','EUR','ONRAMPMONEY','SEPA','USDT_POLYGON',10.00,100000.00,2),
   ('LT','EUR','ONRAMPMONEY','OPEN_BANKING','USDT_POLYGON',10.00,100000.00,2),
   ('LT','EUR','ONRAMPMONEY','SEPA','USDT_POLYGON',10.00,100000.00,2),
   ('LU','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('LU','EUR','ONRAMPMONEY','OPEN_BANKING','USDT_POLYGON',10.00,100000.00,2),
   ('LU','EUR','ONRAMPMONEY','SEPA','USDT_POLYGON',10.00,100000.00,2),
   ('LV','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('LV','EUR','ONRAMPMONEY','OPEN_BANKING','USDT_POLYGON',10.00,100000.00,2),
   ('LV','EUR','ONRAMPMONEY','SEPA','USDT_POLYGON',10.00,100000.00,2),
   ('MC','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('ME','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('MF','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('MQ','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('MT','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('MT','EUR','ONRAMPMONEY','OPEN_BANKING','USDT_POLYGON',10.00,100000.00,2),
   ('MT','EUR','ONRAMPMONEY','SEPA','USDT_POLYGON',10.00,100000.00,2),
   ('MW','MWK','ONRAMPMONEY','MOBILE_MONEY','USDT_POLYGON',2000.00,40000000.00,2),
   ('MX','MXN','ONRAMPMONEY','SPEI','USDC_POLYGON',200.00,500000.00,2),
   ('MY','MYR','ONRAMPMONEY','LOCAL_BANK_TRANSFER','USDT_POLYGON',75.00,6000.00,2),
   ('NL','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('NL','EUR','ONRAMPMONEY','OPEN_BANKING','USDT_POLYGON',10.00,100000.00,2),
   ('NL','EUR','ONRAMPMONEY','SEPA','USDT_POLYGON',10.00,100000.00,2),
   ('NR','AUD','BANXA','LOCAL_BANK_TRANSFER','USDT_POLYGON',20.00,5000.00,2),
   ('NR','AUD','BANXA','PAYID','USDT_POLYGON',20.00,1500.00,2),
   ('PE','PEN','ONRAMPMONEY','LOCAL_BANK_TRANSFER','USDT_POLYGON',19.00,4500000.00,2),
   ('PM','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('PT','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('PT','EUR','ONRAMPMONEY','OPEN_BANKING','USDT_POLYGON',10.00,100000.00,2),
   ('PT','EUR','ONRAMPMONEY','SEPA','USDT_POLYGON',10.00,100000.00,2),
   ('RE','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('RO','EUR','ONRAMPMONEY','OPEN_BANKING','USDT_POLYGON',10.00,100000.00,2),
   ('RO','EUR','ONRAMPMONEY','SEPA','USDT_POLYGON',10.00,100000.00,2),
   ('SE','EUR','ONRAMPMONEY','OPEN_BANKING','USDT_POLYGON',10.00,100000.00,2),
   ('SE','EUR','ONRAMPMONEY','SEPA','USDT_POLYGON',10.00,100000.00,2),
   ('SE','SEK','BANXA','KLARNA','USDT_POLYGON',125.00,50000.00,2),
   ('SI','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('SI','EUR','ONRAMPMONEY','OPEN_BANKING','USDT_POLYGON',10.00,100000.00,2),
   ('SI','EUR','ONRAMPMONEY','SEPA','USDT_POLYGON',10.00,100000.00,2),
   ('SK','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('SK','EUR','ONRAMPMONEY','OPEN_BANKING','USDT_POLYGON',10.00,100000.00,2),
   ('SK','EUR','ONRAMPMONEY','SEPA','USDT_POLYGON',10.00,100000.00,2),
   ('SM','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('TF','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('TV','AUD','BANXA','LOCAL_BANK_TRANSFER','USDT_POLYGON',20.00,5000.00,2),
   ('TV','AUD','BANXA','PAYID','USDT_POLYGON',20.00,1500.00,2),
   ('TZ','TZS','ONRAMPMONEY','MOBILE_MONEY','USDT_POLYGON',2500.00,10000000.00,2),
   ('UG','UGX','ONRAMPMONEY','MOBILE_MONEY','USDT_POLYGON',15000,250000000,0),
   ('VA','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('VN','VND','BANXA','VIETQR','USDT_POLYGON',200000,25000000,0),
   ('VN','VND','ONRAMPMONEY','VIETQR','USDT_POLYGON',55000,450000000,0),
   ('XK','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('YT','EUR','BANXA','SEPA','USDT_POLYGON',10.00,30000.00,2),
   ('ZA','ZAR','BANXA','LOCAL_BANK_TRANSFER','USDT_POLYGON',200.00,79000.00,2),
   ('US','USD','ONRAMPMONEY','ACH','USDC_POLYGON',50.00,25000.00,2),
   ('US','USD','ONRAMPMONEY','LOCAL_BANK_TRANSFER','USDC_POLYGON',50.00,25000.00,2),
   ('US','USD','RAMPNOW','CREDIT_DEBIT_CARD','USDC_POLYGON',50.00,10000.00,2),
   ('US','USD','RAMPNOW','CREDIT_DEBIT_CARD','USDC_ARBITRUM',50.00,10000.00,2),
   ('US','USD','RAMPNOW','CREDIT_DEBIT_CARD','USDC',50.00,10000.00,2),
   ('US','USD','RAMPNOW','APPLE_PAY','USDC_POLYGON',50.00,10000.00,2),
   ('US','USD','RAMPNOW','APPLE_PAY','USDC_ARBITRUM',50.00,10000.00,2),
   ('US','USD','RAMPNOW','APPLE_PAY','USDC',50.00,10000.00,2),
   ('US','USD','RAMPNOW','GOOGLE_PAY','USDC_POLYGON',50.00,10000.00,2),
   ('US','USD','RAMPNOW','GOOGLE_PAY','USDC_ARBITRUM',50.00,10000.00,2),
   ('US','USD','RAMPNOW','GOOGLE_PAY','USDC',50.00,10000.00,2),
   ('US','USD','RAMPNOW','ACH','USDC_POLYGON',50.00,10000.00,2),
   ('US','USD','RAMPNOW','ACH','USDC_ARBITRUM',50.00,10000.00,2),
   ('US','USD','RAMPNOW','ACH','USDC',50.00,10000.00,2),
   ('US','USD','RAMPNOW','LOCAL_BANK_TRANSFER','USDC_POLYGON',50.00,10000.00,2),
   ('US','USD','RAMPNOW','LOCAL_BANK_TRANSFER','USDC_ARBITRUM',50.00,10000.00,2),
   ('US','USD','RAMPNOW','LOCAL_BANK_TRANSFER','USDC',50.00,10000.00,2),
   ('MX','MXN','MERCURYO','CREDIT_DEBIT_CARD','USDC_POLYGON',520.03,312013.70,2),
   ('MX','USD','MERCURYO','CREDIT_DEBIT_CARD','USDC_POLYGON',50.00,16821.71,2)
  ) AS approved(country,currency,provider,method,asset,min_amount,max_amount,minor_units)
  WHERE p_country=approved.country AND p_currency=approved.currency AND p_provider=approved.provider
   AND p_method=approved.method AND p_asset=approved.asset AND p_amount BETWEEN approved.min_amount AND approved.max_amount
   AND p_amount=pg_catalog.round(p_amount,approved.minor_units));
$function$;

ALTER TABLE payments.app_meld_funding_attempt
 DROP CONSTRAINT app_meld_funding_approved_market_check,
 DROP CONSTRAINT app_meld_funding_attempt_chain_id_check,
 ADD CONSTRAINT app_meld_funding_approved_market_check CHECK(
  payments.app_meld_funding_route_allowed(country_code,source_currency,requested_amount,payment_method,service_provider,destination_currency)
  OR payments.app_meld_funding_wallet_route_allowed(country_code,source_currency,requested_amount,payment_method,service_provider,destination_currency)),
 ADD CONSTRAINT app_meld_funding_attempt_chain_id_check CHECK(
  destination_currency IN('USDT_POLYGON','USDC_POLYGON','USDC_ARBITRUM','USDC')
  AND chain_id=CASE destination_currency WHEN 'USDC_ARBITRUM' THEN 42161 WHEN 'USDC' THEN 1 ELSE 137 END);

CREATE FUNCTION payments.reserve_app_meld_funding_v3(
 p_subject text,p_native_session text,p_id uuid,p_wallet text,p_country text,p_currency text,p_amount numeric,
 p_method text,p_provider text,p_account text,p_asset text)
RETURNS TABLE(id uuid,created_at timestamptz,wallet_address text,customer_reference uuid,created boolean,status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
DECLARE r payments.app_meld_funding_attempt%ROWTYPE; v_customer uuid; v_digest text;
BEGIN
 BEGIN PERFORM identity.require_administrative_native_session(p_subject,p_native_session);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000'; END;
 IF p_id IS NULL OR p_wallet IS NULL OR p_wallet!~'^0x[0-9a-f]{40}$'
  OR p_wallet='0x0000000000000000000000000000000000000000'
  OR p_account IS NULL OR p_account!~'^[A-Za-z0-9_-]{1,128}$'
  OR p_amount IS NULL OR p_amount::text IN('NaN','Infinity','-Infinity') OR p_amount<>pg_catalog.round(p_amount,2)
  OR NOT payments.app_meld_funding_wallet_route_allowed(p_country,p_currency,p_amount,p_method,p_provider,p_asset) THEN
  RAISE EXCEPTION 'wallet_funding_invalid_request' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM identity.wallet_binding b WHERE b.subject=p_subject AND b.address=p_wallet) THEN
  RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000'; END IF;
 v_digest:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
  'mindbliss-app-meld-customer-v1:'||p_subject||':'||p_wallet,'UTF8')),'hex');
 v_customer:=(substr(v_digest,1,8)||'-'||substr(v_digest,9,4)||'-8'||substr(v_digest,14,3)||
  '-a'||substr(v_digest,18,3)||'-'||substr(v_digest,21,12))::uuid;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-meld-funding-owner:'||p_subject,0));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app-meld-funding-attempt:'||p_id::text,0));
 SELECT a.* INTO r FROM payments.app_meld_funding_attempt a WHERE a.id=p_id;
 IF FOUND THEN
  IF (r.subject,r.native_session_id,r.wallet_address,r.customer_reference,r.country_code,r.source_currency,
    r.requested_amount,r.payment_method,r.service_provider,r.account_id,r.destination_currency)
   IS DISTINCT FROM (p_subject,p_native_session,p_wallet,v_customer,p_country,p_currency,p_amount,p_method,p_provider,p_account,p_asset) THEN
   RAISE EXCEPTION 'wallet_funding_request_already_used' USING ERRCODE='23505'; END IF;
  RETURN QUERY SELECT r.id,r.created_at,r.wallet_address,r.customer_reference,false,r.status;
  RETURN;
 END IF;
 IF (SELECT count(*) FROM payments.app_meld_funding_attempt a
  WHERE a.subject=p_subject AND a.created_at>clock_timestamp()-interval '10 minutes')>=10 THEN
  RAISE EXCEPTION 'wallet_funding_rate_limited' USING ERRCODE='54000'; END IF;
 RETURN QUERY INSERT INTO payments.app_meld_funding_attempt AS a
  (id,subject,native_session_id,wallet_address,customer_reference,country_code,source_currency,requested_amount,payment_method,
   service_provider,account_id,destination_currency,chain_id)
 VALUES(p_id,p_subject,p_native_session,p_wallet,v_customer,p_country,p_currency,p_amount,p_method,p_provider,p_account,p_asset,CASE p_asset WHEN 'USDC_ARBITRUM' THEN 42161 WHEN 'USDC' THEN 1 ELSE 137 END)
 RETURNING a.id,a.created_at,a.wallet_address,a.customer_reference,true,a.status;
END $function$;

-- Versioned readers let the previous App binaries keep their compatible history.

CREATE OR REPLACE FUNCTION payments.read_app_meld_funding(p_subject text,p_id uuid)
RETURNS SETOF payments.app_meld_funding_attempt
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
BEGIN
 BEGIN PERFORM identity.administrative_wallet_person(p_subject);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000'; END;
 RETURN QUERY SELECT a.* FROM payments.app_meld_funding_attempt a
  WHERE a.subject=p_subject AND a.chain_id=137 AND a.country_code IN('MX','US','CO') AND payments.app_meld_funding_route_allowed(
   a.country_code,a.source_currency,a.requested_amount,a.payment_method,a.service_provider,a.destination_currency) AND (p_id IS NULL OR a.id=p_id)
  ORDER BY a.created_at DESC,a.id DESC LIMIT 20;
END $function$;

CREATE OR REPLACE FUNCTION payments.read_app_meld_funding_v2(p_subject text,p_id uuid)
RETURNS SETOF payments.app_meld_funding_attempt
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
BEGIN
 BEGIN PERFORM identity.administrative_wallet_person(p_subject);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000'; END;
 RETURN QUERY SELECT a.* FROM payments.app_meld_funding_attempt a
  WHERE a.subject=p_subject AND payments.app_meld_funding_route_allowed(
   a.country_code,a.source_currency,a.requested_amount,a.payment_method,a.service_provider,a.destination_currency) AND (p_id IS NULL OR a.id=p_id)
  ORDER BY a.created_at DESC,a.id DESC LIMIT 20;
END $function$;

CREATE FUNCTION payments.read_app_meld_funding_v3(p_subject text,p_id uuid)
RETURNS SETOF payments.app_meld_funding_attempt
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' SET statement_timeout='8s' AS $function$
BEGIN
 BEGIN PERFORM identity.administrative_wallet_person(p_subject);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000'; END;
 RETURN QUERY SELECT a.* FROM payments.app_meld_funding_attempt a
  WHERE a.subject=p_subject AND (p_id IS NULL OR a.id=p_id)
  ORDER BY a.created_at DESC,a.id DESC LIMIT 20;
END $function$;

DO $permissions$
DECLARE v_signature text; v_owner name; v_role text;
BEGIN
 SELECT pg_catalog.pg_get_userbyid(proowner) INTO v_owner FROM pg_catalog.pg_proc
  WHERE oid='payments.reserve_app_meld_funding(text,text,uuid,text,text,text,numeric,text,text,text,text)'::regprocedure;
 FOREACH v_signature IN ARRAY ARRAY[
  'payments.app_meld_funding_wallet_route_allowed(text,text,numeric,text,text,text)',
  'payments.reserve_app_meld_funding_v3(text,text,uuid,text,text,text,numeric,text,text,text,text)',
  'payments.read_app_meld_funding_v3(text,uuid)'
 ] LOOP
  EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO %I',v_signature,v_owner);
  FOR v_role IN
   SELECT DISTINCT CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(acl.grantee)) END
   FROM pg_catalog.pg_proc p, LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
   WHERE p.oid=v_signature::regprocedure AND acl.grantee<>p.proowner
  LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||v_signature||' FROM '||v_role; END LOOP;
 END LOOP;
 GRANT EXECUTE ON FUNCTION payments.reserve_app_meld_funding_v3(text,text,uuid,text,text,text,numeric,text,text,text,text),
  payments.read_app_meld_funding_v3(text,uuid) TO mindbliss_auth_core_v1;
 IF NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1',
   'payments.reserve_app_meld_funding_v3(text,text,uuid,text,text,text,numeric,text,text,text,text)','EXECUTE')
  OR NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.read_app_meld_funding_v3(text,uuid)','EXECUTE')
  OR NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.read_app_meld_funding_v2(text,uuid)','EXECUTE')
  OR NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.read_app_meld_funding(text,uuid)','EXECUTE')
  OR pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.app_meld_funding_wallet_route_allowed(text,text,numeric,text,text,text)','EXECUTE')
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.app_meld_funding_attempt','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  OR NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid='payments.app_meld_funding_attempt'::regclass) THEN
  RAISE EXCEPTION 'app_meld_wallet_parity_permissions_changed'; END IF;
END $permissions$;
COMMIT;
