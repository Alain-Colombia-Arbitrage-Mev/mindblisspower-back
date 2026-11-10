-- PREPARED ONLY. One immutable administrative deposit address is reserved for
-- each verified Better Auth identity. These are public EVM addresses, not
-- private keys and not a custody implementation.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('administrative-wallets-meld-v1',0));

DO $preflight$
BEGIN
  IF pg_catalog.current_database()<>'mindbliss_curated_20261025' OR pg_catalog.pg_is_in_recovery() THEN
    RAISE EXCEPTION 'administrative_wallet_explicit_primary_review_required';
  END IF;
  IF pg_catalog.to_regclass('identity.administrative_wallet_pool') IS NOT NULL
    OR pg_catalog.to_regclass('identity.administrative_wallet_assignment') IS NOT NULL
    OR pg_catalog.to_regclass('payments.meld_onramp_attempt') IS NOT NULL
    OR pg_catalog.to_regclass('payments.meld_webhook_event') IS NOT NULL THEN
    RAISE EXCEPTION 'administrative_wallet_requires_fresh_review';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='mindbliss_auth_core_v1'
    AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolreplication AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'administrative_wallet_scoped_auth_role_required';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) acl
    WHERE n.nspname='public' AND acl.grantee=0 AND acl.privilege_type='CREATE')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
      WHERE e.extname='unaccent' AND n.nspname='public') THEN
    RAISE EXCEPTION 'administrative_wallet_trusted_unaccent_schema_required';
  END IF;
END $preflight$;

CREATE TABLE identity.administrative_wallet_pool (
  ordinal smallint PRIMARY KEY CHECK (ordinal BETWEEN 1 AND 10000),
  address text NOT NULL UNIQUE CHECK (address ~ '^0x[0-9a-f]{40}$'),
  address_family text NOT NULL DEFAULT 'EVM' CHECK (address_family='EVM'),
  asset text NOT NULL DEFAULT 'USDT' CHECK (asset='USDT'),
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','disabled')),
  added_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identity.administrative_wallet_assignment (
  subject text PRIMARY KEY REFERENCES auth."user"(id) ON DELETE RESTRICT,
  person_id bigint NOT NULL UNIQUE REFERENCES mlm.person(id) ON DELETE RESTRICT,
  pool_ordinal smallint NOT NULL UNIQUE REFERENCES identity.administrative_wallet_pool(ordinal) ON DELETE RESTRICT,
  checkout_reference uuid NOT NULL UNIQUE DEFAULT pg_catalog.gen_random_uuid(),
  assigned_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO identity.administrative_wallet_pool(ordinal,address) VALUES
  (1,'0xf27949e891e0ad892d94729c8c065b8190a07d9a'),
  (2,'0x29f238864066116dbc0b379d4d17321d7e8a74ea'),
  (3,'0x0f0f9472c7e81b45e89ec811b32a0768995d1200'),
  (4,'0x1044fac5637d94ec721f98413fcb5a2605fea30e'),
  (5,'0x5f96e42d280ef01a7a617ee02503f5bda3016665'),
  (6,'0x29577ffe0e1dc2f68b422464353d089d6eb1c236'),
  (7,'0x7fdc78b10a585865e53a0480fa6f15bee370a841'),
  (8,'0x14cb11afe737b3ac02cafd7f611f8f9b9a12c587'),
  (9,'0x44650a9d3ff0ac5580cd38de0bf23bf6712d3412'),
  (10,'0xbaece88146170b03c7bf41d38eadb3305aae8da5'),
  (11,'0x3eaa7d8055425ca29babe29270f01b7e6841ea2e'),
  (12,'0x6f44f10ac1c27cb5f96e81b69b43a17493012cd5'),
  (13,'0x884e9acd04d30614be37fee6fcbbeacbb0f3509e'),
  (14,'0xc756e5726065c281693f347d38d672e09e6e9299'),
  (15,'0x4795080dc172963c7af3dbcec4df0c23572a4c4d'),
  (16,'0x34081d03161e061dade7b7d0672870feec1aee6e'),
  (17,'0x7cb9ea6e3f1c95ff60f01282d9152487200888ea'),
  (18,'0x7b2bb6b76dbe2569d669bce4c6c773324ff6d124'),
  (19,'0xca63688575e64464f55ba1d8a4e7480e0faf2300'),
  (20,'0x74054c757fa56bb5af59e3ecec3a6a014aa546c4'),
  (21,'0x6a668c47f61a198f23f4d16977430c8c64d43956'),
  (22,'0xa283a311fb17730b6ec27daf54373269725ae053'),
  (23,'0x83bf7c98c2f5a144c8eee9a9da77a06fcd674b78'),
  (24,'0xda7b334ff4cfc6f4a490ca816ec664f6a06954be'),
  (25,'0xbc99fa4d72e1629e1fbd437d2a2cd2f4823b4ec7'),
  (26,'0x0422d2086d07bc610c8067adeb8ac30b4af19ea8'),
  (27,'0x18675cfdd724e8f931e64bb57bdec59fdbe2e375'),
  (28,'0x072e05ae5400147b77b3e9e73747d06cd256881e');

CREATE FUNCTION identity.administrative_wallet_person(p_subject text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE v_person_id bigint;
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'administrative_wallet_identity_unavailable' USING ERRCODE='28000';
  END IF;
  SELECT p.id INTO v_person_id
  FROM auth."user" u
  JOIN identity.auth_binding b ON b.subject=u.id AND b.provider='better_auth'
  JOIN mlm.person p ON p.id=b.person_id AND p.user_id=u.id
  WHERE u.id=p_subject AND u.email_verified=true
    AND lower(btrim(u.email))=lower(btrim(p.email::text))
    AND p.public_id IS NOT NULL AND p.status::text IN ('pending','active')
    AND NOT COALESCE(p.blacklisted,false)
    AND NOT EXISTS (SELECT 1 FROM mlm.affiliate a WHERE a.person_id=p.id
      AND a.status::text IN ('suspended','banned','deleted'))
    AND NOT EXISTS (SELECT 1 FROM mlm.blacklist x
      WHERE (mlm.norm_email(p.email) IS NOT NULL AND x.email_norm=mlm.norm_email(p.email))
         OR (mlm.norm_phone10(p.phone_number) IS NOT NULL AND x.phone_last10=mlm.norm_phone10(p.phone_number))
         OR (mlm.norm_name(p.first_name || ' ' || p.last_name) IS NOT NULL
             AND x.name_norm=mlm.norm_name(p.first_name || ' ' || p.last_name)
             AND (x.birthdate IS NULL OR (p.birthday IS NOT NULL AND x.birthdate=p.birthday))));
  IF v_person_id IS NULL THEN
    RAISE EXCEPTION 'administrative_wallet_identity_unavailable' USING ERRCODE='28000';
  END IF;
  RETURN v_person_id;
END $function$;

CREATE FUNCTION identity.read_administrative_wallet(p_subject text)
RETURNS TABLE(status text,address text,address_family text,asset text,checkout_reference uuid,assigned_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_person_id bigint;
BEGIN
  v_person_id := identity.administrative_wallet_person(p_subject);
  RETURN QUERY
    SELECT 'assigned'::text,p.address,p.address_family,p.asset,a.checkout_reference,a.assigned_at
    FROM identity.administrative_wallet_assignment a
    JOIN identity.administrative_wallet_pool p ON p.ordinal=a.pool_ordinal
    WHERE a.subject=p_subject AND a.person_id=v_person_id;
  IF FOUND THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM identity.administrative_wallet_pool p
    WHERE p.status='available' AND NOT EXISTS (
      SELECT 1 FROM identity.administrative_wallet_assignment a WHERE a.pool_ordinal=p.ordinal)) THEN
    RETURN QUERY SELECT 'pending'::text,NULL::text,'EVM'::text,'USDT'::text,NULL::uuid,NULL::timestamptz;
  ELSE
    RETURN QUERY SELECT 'exhausted'::text,NULL::text,'EVM'::text,'USDT'::text,NULL::uuid,NULL::timestamptz;
  END IF;
END $function$;

CREATE FUNCTION identity.ensure_administrative_wallet(p_subject text)
RETURNS TABLE(status text,address text,address_family text,asset text,checkout_reference uuid,assigned_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_person_id bigint; v_ordinal smallint; v_inserted smallint;
BEGIN
  v_person_id := identity.administrative_wallet_person(p_subject);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('administrative-wallet:'||p_subject,0));
  RETURN QUERY
    SELECT 'assigned'::text,p.address,p.address_family,p.asset,a.checkout_reference,a.assigned_at
    FROM identity.administrative_wallet_assignment a
    JOIN identity.administrative_wallet_pool p ON p.ordinal=a.pool_ordinal
    WHERE a.subject=p_subject AND a.person_id=v_person_id;
  IF FOUND THEN RETURN; END IF;
  LOOP
    v_ordinal := NULL;
    v_inserted := NULL;
    SELECT p.ordinal INTO v_ordinal FROM identity.administrative_wallet_pool p
    WHERE p.status='available' AND NOT EXISTS (
      SELECT 1 FROM identity.administrative_wallet_assignment a WHERE a.pool_ordinal=p.ordinal)
    ORDER BY p.ordinal FOR UPDATE OF p SKIP LOCKED LIMIT 1;
    IF v_ordinal IS NULL THEN
      -- A concurrent allocator may currently hold every otherwise-free row.
      -- Report a retryable availability error instead of falsely declaring the
      -- finite pool exhausted; the next request will see the committed outcome.
      IF EXISTS (SELECT 1 FROM identity.administrative_wallet_pool p
        WHERE p.status='available' AND NOT EXISTS (
          SELECT 1 FROM identity.administrative_wallet_assignment a WHERE a.pool_ordinal=p.ordinal)) THEN
        RAISE EXCEPTION 'administrative_wallet_busy' USING ERRCODE='55P03';
      END IF;
      RETURN QUERY SELECT 'exhausted'::text,NULL::text,'EVM'::text,'USDT'::text,NULL::uuid,NULL::timestamptz;
      RETURN;
    END IF;
    INSERT INTO identity.administrative_wallet_assignment(subject,person_id,pool_ordinal)
    VALUES(p_subject,v_person_id,v_ordinal)
    ON CONFLICT(pool_ordinal) DO NOTHING RETURNING pool_ordinal INTO v_inserted;
    EXIT WHEN v_inserted IS NOT NULL;
    -- The unique constraint is the final authority. If another transaction
    -- committed this row after our snapshot, take a fresh snapshot and retry.
  END LOOP;
  RETURN QUERY
    SELECT 'assigned'::text,p.address,p.address_family,p.asset,a.checkout_reference,a.assigned_at
    FROM identity.administrative_wallet_assignment a
    JOIN identity.administrative_wallet_pool p ON p.ordinal=a.pool_ordinal
    WHERE a.subject=p_subject;
END $function$;

CREATE FUNCTION identity.administrative_wallet_inventory()
RETURNS TABLE(total integer,assigned integer,remaining integer,disabled integer)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $function$
  SELECT count(*)::int,
    count(a.subject)::int,
    count(*) FILTER (WHERE p.status='available' AND a.subject IS NULL)::int,
    count(*) FILTER (WHERE p.status='disabled')::int
  FROM identity.administrative_wallet_pool p
  LEFT JOIN identity.administrative_wallet_assignment a ON a.pool_ordinal=p.ordinal
$function$;

CREATE TABLE payments.meld_onramp_attempt (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  subject text NOT NULL REFERENCES auth."user"(id) ON DELETE RESTRICT,
  wallet_kind text NOT NULL CHECK (wallet_kind IN ('personal','administrative')),
  wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  source_currency text NOT NULL DEFAULT 'USD' CHECK (source_currency='USD'),
  destination_currency text NOT NULL DEFAULT 'USDT_POLYGON' CHECK (destination_currency='USDT_POLYGON'),
  service_provider text NOT NULL CHECK (service_provider ~ '^[A-Z0-9_]{2,40}$' AND service_provider NOT IN ('BINANCECONNECT','BINANCEPAY')),
  payment_method text NOT NULL CHECK (payment_method ~ '^[A-Z0-9_]{2,40}$'),
  source_amount numeric(18,2) NOT NULL CHECK (source_amount BETWEEN 50 AND 25000),
  quoted_destination_amount numeric(28,10) NOT NULL CHECK (quoted_destination_amount>0),
  quoted_provider_fee_usd numeric(18,2) NOT NULL CHECK (quoted_provider_fee_usd>=0),
  mindbliss_fee_bps smallint NOT NULL DEFAULT 100 CHECK (mindbliss_fee_bps=100),
  mindbliss_fee_usd numeric(18,2) GENERATED ALWAYS AS (round(source_amount*mindbliss_fee_bps/10000,2)) STORED,
  commission_status text NOT NULL DEFAULT 'estimated' CHECK (commission_status IN ('estimated','calculated','void')),
  status text NOT NULL DEFAULT 'quoted' CHECK (status IN ('quoted','opened','pending','transferring','complete','failed')),
  payment_transaction_id text UNIQUE CHECK (payment_transaction_id IS NULL OR length(payment_transaction_id) BETWEEN 1 AND 128),
  last_event_id text CHECK (last_event_id IS NULL OR length(last_event_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meld_onramp_attempt_subject_created_idx ON payments.meld_onramp_attempt(subject,created_at DESC);
CREATE INDEX meld_onramp_attempt_commission_idx ON payments.meld_onramp_attempt(commission_status,created_at DESC)
  WHERE commission_status='calculated';

CREATE FUNCTION payments.create_meld_onramp_attempt(
  p_subject text,p_wallet_kind text,p_wallet_address text,p_country_code text,p_service_provider text,
  p_payment_method text,p_source_amount numeric,p_destination_amount numeric,p_provider_fee_usd numeric)
RETURNS TABLE(id uuid,mindbliss_fee_usd numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  IF p_wallet_kind='personal' THEN
    IF NOT EXISTS (SELECT 1 FROM identity.wallet_binding b WHERE b.subject=p_subject AND b.address=lower(p_wallet_address)) THEN
      RAISE EXCEPTION 'meld_personal_wallet_not_linked' USING ERRCODE='28000';
    END IF;
  ELSIF p_wallet_kind='administrative' THEN
    IF NOT EXISTS (SELECT 1 FROM identity.administrative_wallet_assignment a
      JOIN identity.administrative_wallet_pool p ON p.ordinal=a.pool_ordinal
      WHERE a.subject=p_subject AND p.address=lower(p_wallet_address)) THEN
      RAISE EXCEPTION 'meld_administrative_wallet_not_assigned' USING ERRCODE='28000';
    END IF;
  ELSE
    RAISE EXCEPTION 'meld_wallet_kind_invalid' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
    INSERT INTO payments.meld_onramp_attempt(subject,wallet_kind,wallet_address,country_code,service_provider,
      payment_method,source_amount,quoted_destination_amount,quoted_provider_fee_usd)
    VALUES(p_subject,p_wallet_kind,lower(p_wallet_address),p_country_code,p_service_provider,
      p_payment_method,p_source_amount,p_destination_amount,p_provider_fee_usd)
    RETURNING meld_onramp_attempt.id,meld_onramp_attempt.mindbliss_fee_usd;
END $function$;

CREATE TABLE payments.meld_webhook_event (
  event_id text PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 128),
  event_type text NOT NULL CHECK (event_type IN ('TRANSACTION_CRYPTO_PENDING','TRANSACTION_CRYPTO_TRANSFERRING','TRANSACTION_CRYPTO_COMPLETE','TRANSACTION_CRYPTO_FAILED')),
  event_timestamp timestamptz NOT NULL,
  account_id text NOT NULL CHECK (length(account_id) BETWEEN 1 AND 128),
  profile_id text NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 128),
  event_version date NOT NULL,
  external_customer_id uuid,
  external_session_id uuid,
  payment_transaction_id text CHECK (payment_transaction_id IS NULL OR length(payment_transaction_id) BETWEEN 1 AND 128),
  payment_status text CHECK (payment_status IS NULL OR length(payment_status) BETWEEN 1 AND 64),
  transaction_type text CHECK (transaction_type IS NULL OR transaction_type IN ('CRYPTO_PURCHASE','CRYPTO_SELL','CRYPTO_TRANSFER')),
  matched_subject text REFERENCES auth."user"(id) ON DELETE RESTRICT,
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  signed_evidence jsonb NOT NULL CHECK (jsonb_typeof(signed_evidence)='object'),
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meld_webhook_event_subject_received_idx ON payments.meld_webhook_event(matched_subject,received_at DESC)
  WHERE matched_subject IS NOT NULL;
CREATE INDEX meld_webhook_event_transaction_idx ON payments.meld_webhook_event(payment_transaction_id)
  WHERE payment_transaction_id IS NOT NULL;

CREATE FUNCTION payments.capture_meld_webhook_event(
  p_event_id text,p_event_type text,p_event_timestamp timestamptz,p_account_id text,p_profile_id text,
  p_event_version date,p_external_customer_id uuid,p_external_session_id uuid,p_payment_transaction_id text,p_payment_status text,
  p_transaction_type text,p_body_sha256 text,p_signed_evidence jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_subject text; v_attempt_id uuid; v_inserted integer; v_existing_hash text;
BEGIN
  v_attempt_id := COALESCE(p_external_session_id,p_external_customer_id);
  SELECT a.subject INTO v_subject FROM payments.meld_onramp_attempt a WHERE a.id=v_attempt_id;
  IF v_subject IS NULL THEN
    SELECT a.subject INTO v_subject FROM identity.administrative_wallet_assignment a
      WHERE a.checkout_reference=p_external_customer_id;
  END IF;
  INSERT INTO payments.meld_webhook_event(event_id,event_type,event_timestamp,account_id,profile_id,event_version,
    external_customer_id,external_session_id,payment_transaction_id,payment_status,transaction_type,matched_subject,body_sha256,signed_evidence)
  VALUES(p_event_id,p_event_type,p_event_timestamp,p_account_id,p_profile_id,p_event_version,
    p_external_customer_id,p_external_session_id,p_payment_transaction_id,p_payment_status,p_transaction_type,v_subject,p_body_sha256,p_signed_evidence)
  ON CONFLICT(event_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted=ROW_COUNT;
  IF v_inserted=0 THEN
    SELECT body_sha256 INTO v_existing_hash FROM payments.meld_webhook_event WHERE event_id=p_event_id;
    IF v_existing_hash IS DISTINCT FROM p_body_sha256 THEN
      RAISE EXCEPTION 'meld_event_id_collision' USING ERRCODE='23505';
    END IF;
  END IF;
  IF v_inserted=1 AND v_attempt_id IS NOT NULL THEN
    UPDATE payments.meld_onramp_attempt SET
      -- Meld can retry or deliver events out of order. Once a charge reaches
      -- a terminal state, a delayed PENDING/TRANSFERRING event must not
      -- reopen it or change the commission result.
      status=CASE
        WHEN status IN ('complete','failed') THEN status
        WHEN p_event_type='TRANSACTION_CRYPTO_COMPLETE' THEN 'complete'
        WHEN p_event_type='TRANSACTION_CRYPTO_FAILED' THEN 'failed'
        WHEN p_event_type='TRANSACTION_CRYPTO_TRANSFERRING' THEN 'transferring'
        WHEN p_event_type='TRANSACTION_CRYPTO_PENDING' AND status IN ('quoted','opened') THEN 'pending'
        ELSE status END,
      commission_status=CASE
        WHEN commission_status IN ('calculated','void') THEN commission_status
        WHEN p_event_type='TRANSACTION_CRYPTO_COMPLETE' THEN 'calculated'
        WHEN p_event_type='TRANSACTION_CRYPTO_FAILED' THEN 'void'
        ELSE commission_status END,
      payment_transaction_id=COALESCE(payment_transaction_id,p_payment_transaction_id),
      last_event_id=p_event_id,updated_at=now()
    WHERE id=v_attempt_id;
  END IF;
  RETURN v_inserted=1;
END $function$;

CREATE FUNCTION payments.reject_meld_webhook_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN RAISE EXCEPTION 'meld_webhook_event_is_append_only' USING ERRCODE='23514'; END $function$;
CREATE TRIGGER meld_webhook_event_append_only BEFORE UPDATE OR DELETE ON payments.meld_webhook_event
  FOR EACH ROW EXECUTE FUNCTION payments.reject_meld_webhook_mutation();

REVOKE ALL ON identity.administrative_wallet_pool,identity.administrative_wallet_assignment,
  payments.meld_onramp_attempt,payments.meld_webhook_event FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.administrative_wallet_person(text),identity.read_administrative_wallet(text),
  identity.ensure_administrative_wallet(text),identity.administrative_wallet_inventory(),
  payments.create_meld_onramp_attempt(text,text,text,text,text,text,numeric,numeric,numeric),
  payments.capture_meld_webhook_event(text,text,timestamptz,text,text,date,uuid,uuid,text,text,text,text,jsonb),
  payments.reject_meld_webhook_mutation() FROM PUBLIC;
GRANT USAGE ON SCHEMA identity,payments TO mindbliss_auth_core_v1;
GRANT EXECUTE ON FUNCTION identity.read_administrative_wallet(text),identity.ensure_administrative_wallet(text),
  identity.administrative_wallet_inventory(),payments.create_meld_onramp_attempt(text,text,text,text,text,text,numeric,numeric,numeric),
  payments.capture_meld_webhook_event(text,text,timestamptz,text,text,date,uuid,uuid,text,text,text,text,jsonb)
  TO mindbliss_auth_core_v1;

DO $verify$
BEGIN
  IF (SELECT count(*) FROM identity.administrative_wallet_pool)<>28
    OR (SELECT count(DISTINCT lower(address)) FROM identity.administrative_wallet_pool)<>28
    OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','identity.administrative_wallet_pool','SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','identity.administrative_wallet_assignment','SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.meld_onramp_attempt','SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.meld_webhook_event','SELECT,INSERT,UPDATE,DELETE')
    OR NOT pg_catalog.has_schema_privilege('mindbliss_auth_core_v1','identity','USAGE')
    OR NOT pg_catalog.has_schema_privilege('mindbliss_auth_core_v1','payments','USAGE')
    OR NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1','identity.ensure_administrative_wallet(text)','EXECUTE')
    OR NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.create_meld_onramp_attempt(text,text,text,text,text,text,numeric,numeric,numeric)','EXECUTE')
    OR NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1','payments.capture_meld_webhook_event(text,text,timestamptz,text,text,date,uuid,uuid,text,text,text,text,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'administrative_wallet_exact_runtime_grants_required';
  END IF;
END $verify$;
COMMIT;
