-- Explicit provider-minimum policy for personal Mexico/MXN/SPEI only.
-- Amount and source currency are immutable request metadata, never a USD quote,
-- settlement confirmation, real credit or commission. Administrative USD50 stays.
BEGIN;
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personal-mxn-spei-provider-minimum-v1',0));
DO $preflight$
BEGIN
 IF pg_catalog.current_database()<>'mindbliss_curated_20261025' OR pg_catalog.pg_is_in_recovery()
  OR pg_catalog.to_regprocedure('payments.create_reown_funding_intent(text,text,text,numeric,uuid,text)') IS NULL
  OR pg_catalog.to_regprocedure('payments.read_wallet_funding_status(text,text,uuid)') IS NULL
  OR NOT EXISTS(SELECT 1 FROM mlm.package WHERE id=17 AND name='Pack 20 USD' AND amount_usd=20 AND pv=20 AND type='11001' AND is_active) THEN
  RAISE EXCEPTION 'personal_mxn_prerequisites_required';
 END IF;
 IF pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.create_reown_funding_intent(text,text,text,numeric,uuid,text)'::regprocedure))<>'33b432cdf10dc218b677aff33a822d59'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.read_wallet_funding_history(text,text)'::regprocedure))<>'5c309edec2eeee463b0cdad5b7154888'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.read_wallet_funding_status(text,text,uuid)'::regprocedure))<>'bff05b66c08830887ca1d3a0d144c71a'
  OR pg_catalog.to_regprocedure('payments.create_reown_funding_intent(text,text,text,numeric,uuid,text,text)') IS NOT NULL
  OR pg_catalog.to_regprocedure('payments.read_wallet_funding_history_v2(text,text)') IS NOT NULL
  OR pg_catalog.to_regprocedure('payments.read_wallet_funding_status_v2(text,text,uuid)') IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='payments.reown_funding_intent'::regclass
    AND conname='reown_funding_intent_requested_amount_check' AND convalidated
    AND pg_catalog.pg_get_constraintdef(oid)='CHECK (((requested_amount >= (20)::numeric) AND (requested_amount <= (25000)::numeric)))')
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='payments.reown_funding_intent'::regclass
    AND conname='reown_funding_intent_source_currency_check' AND convalidated
    AND pg_catalog.pg_get_constraintdef(oid)='CHECK ((source_currency = ''USD''::text))') THEN
  RAISE EXCEPTION 'personal_mxn_requires_fresh_review';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='payments.meld_sandbox_funding_attempt'::regclass
    AND conname='meld_sandbox_funding_attempt_requested_amount_check' AND convalidated
    AND pg_catalog.pg_get_constraintdef(oid)='CHECK (((requested_amount >= (50)::numeric) AND (requested_amount <= (25000)::numeric)))')
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.reown_funding_intent','SELECT,INSERT,UPDATE,DELETE')
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.meld_sandbox_funding_attempt','SELECT,INSERT,UPDATE,DELETE') THEN
  RAISE EXCEPTION 'personal_mxn_runtime_isolation_required';
 END IF;
END $preflight$;
ALTER TABLE payments.reown_funding_intent DROP CONSTRAINT reown_funding_intent_source_currency_check;
ALTER TABLE payments.reown_funding_intent ADD CONSTRAINT reown_funding_intent_source_currency_check CHECK(source_currency IN ('USD','MXN'));
ALTER TABLE payments.reown_funding_intent DROP CONSTRAINT reown_funding_intent_requested_amount_check;
ALTER TABLE payments.reown_funding_intent ADD CONSTRAINT reown_funding_intent_requested_amount_check
 CHECK((source_currency='USD' AND requested_amount BETWEEN 20 AND 25000)
  OR (source_currency='MXN' AND country_code='MX' AND payment_method IS NOT DISTINCT FROM 'SPEI'
    AND requested_amount BETWEEN 0.01 AND 1000000000));

CREATE FUNCTION payments.create_reown_funding_intent(
  p_subject text,p_address text,p_country text,p_amount numeric,p_request_id uuid,p_payment_method text,p_source_currency text)
RETURNS TABLE(id uuid,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_existing payments.reown_funding_intent%ROWTYPE;
BEGIN
  BEGIN
    PERFORM identity.administrative_wallet_person(p_subject);
  EXCEPTION WHEN SQLSTATE '28000' THEN
    RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000';
  END;
  IF p_address IS NULL OR p_address !~ '^0x[0-9a-f]{40}$'
    OR p_country IS NULL OR p_country !~ '^[A-Z]{2}$' OR p_request_id IS NULL
    OR p_payment_method IS NULL OR p_payment_method !~ '^[A-Z0-9_]{2,40}$'
    OR p_source_currency IS NULL OR p_source_currency NOT IN ('USD','MXN')
    OR p_amount IS NULL OR p_amount<>round(p_amount,2)
    OR (p_source_currency='USD' AND NOT(p_amount BETWEEN 20 AND 25000))
    OR (p_source_currency='MXN' AND (p_country<>'MX' OR p_payment_method<>'SPEI' OR NOT(p_amount BETWEEN 0.01 AND 1000000000))) THEN
    RAISE EXCEPTION 'wallet_funding_invalid_request' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM identity.wallet_binding b WHERE b.subject=p_subject AND b.address=p_address) THEN
    RAISE EXCEPTION 'wallet_funding_wallet_not_linked' USING ERRCODE='28000';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('reown-funding:'||p_subject,0));
  SELECT r.* INTO v_existing FROM payments.reown_funding_intent r WHERE r.id=p_request_id;
  IF FOUND THEN
    IF v_existing.subject<>p_subject OR v_existing.wallet_address<>p_address
      OR v_existing.country_code<>p_country OR v_existing.requested_amount<>p_amount
      OR v_existing.payment_method IS DISTINCT FROM p_payment_method OR v_existing.source_currency IS DISTINCT FROM p_source_currency THEN
      RAISE EXCEPTION 'wallet_funding_request_already_used' USING ERRCODE='22023';
    END IF;
    RETURN QUERY SELECT v_existing.id,v_existing.created_at;
    RETURN;
  END IF;
  IF (SELECT count(*) FROM payments.reown_funding_intent r
    WHERE r.subject=p_subject AND r.created_at>now()-interval '10 minutes')>=10 THEN
    RAISE EXCEPTION 'wallet_funding_rate_limited' USING ERRCODE='54000';
  END IF;
  RETURN QUERY INSERT INTO payments.reown_funding_intent(id,subject,wallet_address,country_code,requested_amount,payment_method,source_currency)
    VALUES(p_request_id,p_subject,p_address,p_country,p_amount,p_payment_method,p_source_currency)
    RETURNING reown_funding_intent.id,reown_funding_intent.created_at;
END $function$;

-- Warm USD-only API containers retain their exact six-argument capability.
-- Delegation checks source currency on replay: an MXN ID cannot be relabelled USD.
CREATE OR REPLACE FUNCTION payments.create_reown_funding_intent(
 p_subject text,p_address text,p_country text,p_amount numeric,p_request_id uuid,p_payment_method text)
RETURNS TABLE(id uuid,created_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT * FROM payments.create_reown_funding_intent(p_subject,p_address,p_country,p_amount,p_request_id,p_payment_method,'USD');
$function$;

-- Old readers must not show MXN requests as USD during an API rollout.
CREATE OR REPLACE FUNCTION payments.read_wallet_funding_history(p_subject text,p_kind text)
RETURNS TABLE(id uuid,wallet_kind text,environment text,provider text,status text,wallet_address text,
  country_code text,requested_amount numeric,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  BEGIN
    PERFORM identity.administrative_wallet_person(p_subject);
  EXCEPTION WHEN SQLSTATE '28000' THEN
    RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000';
  END;
  IF p_kind='personal' THEN
    RETURN QUERY SELECT r.id,r.wallet_kind,r.environment,r.provider,r.status,r.wallet_address,
      r.country_code,r.requested_amount,r.created_at FROM payments.reown_funding_intent r
      WHERE r.subject=p_subject AND r.source_currency='USD' ORDER BY r.created_at DESC,r.id DESC LIMIT 20;
  ELSIF p_kind='administrative' THEN
    RETURN QUERY SELECT r.id,r.wallet_kind,r.environment,r.provider,r.status,r.wallet_address,
      r.country_code,r.requested_amount,r.created_at FROM payments.meld_sandbox_funding_attempt r
      WHERE r.subject=p_subject AND r.source_currency='USD' ORDER BY r.created_at DESC,r.id DESC LIMIT 20;
  ELSE
    RAISE EXCEPTION 'wallet_funding_invalid_kind' USING ERRCODE='22023';
  END IF;
END $function$;

CREATE OR REPLACE FUNCTION payments.read_wallet_funding_status(p_subject text,p_kind text,p_reference uuid)
RETURNS TABLE(id uuid,wallet_kind text,environment text,provider text,status text,wallet_address text,
  country_code text,requested_amount numeric,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  BEGIN
    PERFORM identity.administrative_wallet_person(p_subject);
  EXCEPTION WHEN SQLSTATE '28000' THEN
    RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000';
  END;
  IF p_reference IS NULL THEN
    RAISE EXCEPTION 'wallet_funding_invalid_reference' USING ERRCODE='22023';
  END IF;
  IF p_kind='personal' THEN
    RETURN QUERY SELECT r.id,r.wallet_kind,r.environment,r.provider,r.status,r.wallet_address,
      r.country_code,r.requested_amount,r.created_at FROM payments.reown_funding_intent r
      WHERE r.subject=p_subject AND r.id=p_reference AND r.source_currency='USD';
  ELSIF p_kind='administrative' THEN
    RETURN QUERY SELECT r.id,r.wallet_kind,r.environment,r.provider,r.status,r.wallet_address,
      r.country_code,r.requested_amount,r.created_at FROM payments.meld_sandbox_funding_attempt r
      WHERE r.subject=p_subject AND r.id=p_reference AND r.source_currency='USD';
  ELSE
    RAISE EXCEPTION 'wallet_funding_invalid_kind' USING ERRCODE='22023';
  END IF;
END $function$;

-- Currency-aware readers expose only the selected owner's exact wallet.
CREATE FUNCTION payments.read_wallet_funding_history_v2(p_subject text,p_kind text)
RETURNS TABLE(id uuid,wallet_kind text,environment text,provider text,status text,wallet_address text,
  country_code text,requested_amount numeric,created_at timestamptz,source_currency text,payment_method text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  BEGIN
    PERFORM identity.administrative_wallet_person(p_subject);
  EXCEPTION WHEN SQLSTATE '28000' THEN
    RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000';
  END;
  IF p_kind='personal' THEN
    RETURN QUERY SELECT r.id,r.wallet_kind,r.environment,r.provider,r.status,r.wallet_address,
      r.country_code,r.requested_amount,r.created_at,r.source_currency,r.payment_method FROM payments.reown_funding_intent r
      WHERE r.subject=p_subject ORDER BY r.created_at DESC,r.id DESC LIMIT 20;
  ELSIF p_kind='administrative' THEN
    RETURN QUERY SELECT r.id,r.wallet_kind,r.environment,r.provider,r.status,r.wallet_address,
      r.country_code,r.requested_amount,r.created_at,r.source_currency,r.payment_method FROM payments.meld_sandbox_funding_attempt r
      WHERE r.subject=p_subject ORDER BY r.created_at DESC,r.id DESC LIMIT 20;
  ELSE
    RAISE EXCEPTION 'wallet_funding_invalid_kind' USING ERRCODE='22023';
  END IF;
END $function$;

CREATE FUNCTION payments.read_wallet_funding_status_v2(p_subject text,p_kind text,p_reference uuid)
RETURNS TABLE(id uuid,wallet_kind text,environment text,provider text,status text,wallet_address text,
  country_code text,requested_amount numeric,created_at timestamptz,source_currency text,payment_method text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  BEGIN
    PERFORM identity.administrative_wallet_person(p_subject);
  EXCEPTION WHEN SQLSTATE '28000' THEN
    RAISE EXCEPTION 'wallet_funding_forbidden' USING ERRCODE='28000';
  END;
  IF p_reference IS NULL THEN
    RAISE EXCEPTION 'wallet_funding_invalid_reference' USING ERRCODE='22023';
  END IF;
  IF p_kind='personal' THEN
    RETURN QUERY SELECT r.id,r.wallet_kind,r.environment,r.provider,r.status,r.wallet_address,
      r.country_code,r.requested_amount,r.created_at,r.source_currency,r.payment_method FROM payments.reown_funding_intent r
      WHERE r.subject=p_subject AND r.id=p_reference;
  ELSIF p_kind='administrative' THEN
    RETURN QUERY SELECT r.id,r.wallet_kind,r.environment,r.provider,r.status,r.wallet_address,
      r.country_code,r.requested_amount,r.created_at,r.source_currency,r.payment_method FROM payments.meld_sandbox_funding_attempt r
      WHERE r.subject=p_subject AND r.id=p_reference;
  ELSE
    RAISE EXCEPTION 'wallet_funding_invalid_kind' USING ERRCODE='22023';
  END IF;
END $function$;

REVOKE ALL ON FUNCTION payments.create_reown_funding_intent(text,text,text,numeric,uuid,text,text),
 payments.read_wallet_funding_history_v2(text,text),payments.read_wallet_funding_status_v2(text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION payments.create_reown_funding_intent(text,text,text,numeric,uuid,text,text),
 payments.read_wallet_funding_history_v2(text,text),payments.read_wallet_funding_status_v2(text,text,uuid) TO mindbliss_auth_core_v1;
DO $verify$
BEGIN
 IF (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.oid IN(
    'payments.create_reown_funding_intent(text,text,text,numeric,uuid,text,text)'::regprocedure,
    'payments.read_wallet_funding_history_v2(text,text)'::regprocedure,
    'payments.read_wallet_funding_status_v2(text,text,uuid)'::regprocedure)
   AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog']::text[])=3
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
   WHERE p.oid IN('payments.create_reown_funding_intent(text,text,text,numeric,uuid,text,text)'::regprocedure,
    'payments.read_wallet_funding_history_v2(text,text)'::regprocedure,'payments.read_wallet_funding_status_v2(text,text,uuid)'::regprocedure) AND a.grantee=0)
  AND pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.create_reown_funding_intent(text,text,text,numeric,uuid,text,text)','EXECUTE')
  AND pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.create_reown_funding_intent(text,text,text,numeric,uuid,text)','EXECUTE')
  AND NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.create_reown_funding_intent(text,text,text,numeric,uuid)','EXECUTE')
  AND pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.read_wallet_funding_history_v2(text,text)','EXECUTE')
  AND pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.read_wallet_funding_status_v2(text,text,uuid)','EXECUTE')
  AND NOT pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.reown_funding_intent','SELECT,INSERT,UPDATE,DELETE')
  AND NOT pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.meld_sandbox_funding_attempt','SELECT,INSERT,UPDATE,DELETE') THEN
  RETURN;
 END IF;
 RAISE EXCEPTION 'personal_mxn_postcheck_failed';
END $verify$;
COMMIT;
