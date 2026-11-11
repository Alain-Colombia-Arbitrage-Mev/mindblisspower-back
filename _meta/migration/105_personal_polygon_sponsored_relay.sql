-- PREPARED LOCALLY: Polygon native USDT0 authorization through a dedicated
-- server-owned AA relayer. Direct EVM receipt/verifier contracts remain intact.
-- Authorization signatures have NO onchain expiry. Only a cryptographically
-- bounded Safe UserOperation may expire; that never revokes native user auth.
BEGIN;
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personal-polygon-sponsored-relay-v1',0));
DO $preflight$
BEGIN
 IF pg_catalog.current_database()<>'mindbliss_curated_20261025' OR pg_catalog.pg_is_in_recovery()
  OR pg_catalog.to_regclass('payments.personal_company_payment') IS NULL
  OR pg_catalog.to_regclass('payments.personal_company_payment_event') IS NULL
  OR pg_catalog.to_regclass('identity.solana_wallet_binding') IS NULL
  OR pg_catalog.to_regprocedure('pg_catalog.sha256(bytea)') IS NULL THEN
  RAISE EXCEPTION 'polygon_relay_prerequisites_required'; END IF;
 IF pg_catalog.to_regclass('payments.personal_transfer_request') IS NOT NULL
  OR pg_catalog.to_regclass('payments.personal_polygon_relay') IS NOT NULL
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.prepare_personal_company_payment_v3(text,text,text,uuid,integer)'::regprocedure))<>'655b1dc08cc2ccd354bac7fe7d07abba'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.guard_personal_company_payment()'::regprocedure))<>'88247529f627ea098673b99cd23a9929'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.capture_personal_company_payment_event()'::regprocedure))<>'fe7ecd7d9321bfed23cd56016aed6f46'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.record_personal_company_payment_event(text,uuid,uuid,uuid,text,text,text)'::regprocedure))<>'7d4fedc8221a5602060fc194effa0c46'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('identity.guard_solana_wallet_binding()'::regprocedure))<>'8905ae3aa455291d10c1b0d0da796096' THEN
  RAISE EXCEPTION 'polygon_relay_requires_fresh_review'; END IF;
 IF NOT pg_catalog.pg_has_role((SELECT relowner FROM pg_catalog.pg_class WHERE oid='payments.personal_company_payment'::regclass),'USAGE')
  OR pg_catalog.has_table_privilege('mindbliss_auth_core_v1','payments.personal_company_payment','SELECT,INSERT,UPDATE,DELETE') THEN
  RAISE EXCEPTION 'polygon_relay_runtime_isolation_required'; END IF;
END $preflight$;

CREATE TABLE payments.personal_transfer_request (
 id uuid PRIMARY KEY,
 subject text NOT NULL REFERENCES auth."user"(id) ON DELETE RESTRICT,
 source_kind text NOT NULL CHECK(source_kind IN('evm_direct','polygon_native_meta','solana_sponsored')),
 chain_namespace text NOT NULL CHECK(chain_namespace IN('eip155','solana')),
 chain_reference text NOT NULL,
 wallet_address text COLLATE "C" NOT NULL,
 token_address text COLLATE "C" NOT NULL,
 recipient_address text COLLATE "C" NOT NULL,
 amount_atomic text NOT NULL CHECK(CASE WHEN amount_atomic ~ '^[1-9][0-9]{0,77}$'
  THEN amount_atomic::numeric<=115792089237316195423570985008687907853269984665640564039457584007913129639935 ELSE false END),
 status text NOT NULL CHECK(status IN('prepared','authorized','broadcasting','ambiguous','submitted','confirmed','failed','expired','reconciliation_required')),
 expires_at timestamptz NOT NULL,
 abandoned_at timestamptz,
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((source_kind IN('evm_direct','polygon_native_meta') AND chain_namespace='eip155' AND chain_reference IN('1','137')
   AND wallet_address ~ '^0x[0-9a-f]{40}$' AND recipient_address='0x0a600b03ef5f8e7f3e182b83440c6d292033db0e'
   AND ((chain_reference='1' AND token_address='0xdac17f958d2ee523a2206206994597c13d831ec7')
    OR (chain_reference='137' AND token_address='0xc2132d05d31c914a87c6611c10748aeb04b58e8f'))
   AND (source_kind<>'polygon_native_meta' OR chain_reference='137'))
  OR (source_kind='solana_sponsored' AND chain_namespace='solana' AND chain_reference='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
   AND wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' AND token_address='Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
   AND recipient_address='8U6UD6UmRkYvpubEUg3GG9LBobH5J2c9871mryh1TA5k'))
);
CREATE INDEX personal_transfer_subject_created_idx ON payments.personal_transfer_request(subject,created_at DESC);
CREATE INDEX personal_transfer_subject_pending_idx ON payments.personal_transfer_request(subject,status,expires_at);
ALTER TABLE payments.personal_transfer_request ENABLE ROW LEVEL SECURITY;

CREATE TABLE payments.personal_polygon_relay (
 id uuid PRIMARY KEY CHECK(id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 subject text NOT NULL REFERENCES auth."user"(id) ON DELETE RESTRICT,
 wallet_address text NOT NULL CHECK(wallet_address ~ '^0x[0-9a-f]{40}$' AND wallet_address<>'0x0a600b03ef5f8e7f3e182b83440c6d292033db0e'),
 amount_atomic text NOT NULL CHECK(CASE WHEN amount_atomic ~ '^[1-9][0-9]{0,77}$'
  THEN amount_atomic::numeric<=115792089237316195423570985008687907853269984665640564039457584007913129639935 ELSE false END),
 execution_mode text NOT NULL DEFAULT 'polygon_native_meta_aa' CHECK(execution_mode='polygon_native_meta_aa'),
 chain_id integer NOT NULL DEFAULT 137 CHECK(chain_id=137),
 token_address text NOT NULL DEFAULT '0xc2132d05d31c914a87c6611c10748aeb04b58e8f' CHECK(token_address='0xc2132d05d31c914a87c6611c10748aeb04b58e8f'),
 token_decimals smallint NOT NULL DEFAULT 6 CHECK(token_decimals=6),
 recipient_address text NOT NULL DEFAULT '0x0a600b03ef5f8e7f3e182b83440c6d292033db0e' CHECK(recipient_address='0x0a600b03ef5f8e7f3e182b83440c6d292033db0e'),
 authorization_nonce text NOT NULL CHECK(CASE WHEN authorization_nonce ~ '^(0|[1-9][0-9]{0,77})$'
  THEN authorization_nonce::numeric<=115792089237316195423570985008687907853269984665640564039457584007913129639935 ELSE false END),
 authorization_digest text NOT NULL CHECK(authorization_digest ~ '^0x[0-9a-f]{64}$'),
 domain_separator text NOT NULL CHECK(domain_separator ~ '^0x[0-9a-f]{64}$'),
 implementation_address text NOT NULL CHECK(implementation_address='0x90040487a6c9f949c4f07cadcfb0f3b8eeab4229'),
 relayer_address text NOT NULL CHECK(relayer_address ~ '^0x[0-9a-f]{40}$' AND relayer_address<>'0x0000000000000000000000000000000000000000'),
 entry_point text NOT NULL CHECK(entry_point='0x0000000071727de22e5e9d8baf0edac6f37da032'),
 max_fee_wei text NOT NULL CHECK(CASE WHEN max_fee_wei ~ '^[1-9][0-9]{0,18}$' THEN max_fee_wei::numeric<=1000000000000000000 ELSE false END),
 owner_daily_cap_wei text NOT NULL CHECK(CASE WHEN owner_daily_cap_wei ~ '^[1-9][0-9]{0,18}$' THEN owner_daily_cap_wei::numeric<=2000000000000000000 ELSE false END),
 global_daily_cap_wei text NOT NULL CHECK(CASE WHEN global_daily_cap_wei ~ '^[1-9][0-9]{0,19}$' THEN global_daily_cap_wei::numeric<=10000000000000000000 ELSE false END),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 authorized_at timestamptz,
 authorization_ciphertext text,
 authorization_key_id text,
 status text NOT NULL DEFAULT 'prepared' CHECK(status IN('prepared','authorized','broadcasting','ambiguous','submitted','confirmed','failed','expired','reconciliation_required')),
 attempt_id uuid,
 user_operation_hash text CHECK(user_operation_hash IS NULL OR user_operation_hash ~ '^0x[0-9a-f]{64}$'),
 transaction_hash text CHECK(transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-f]{64}$'),
 block_number text CHECK(block_number IS NULL OR block_number ~ '^[1-9][0-9]{0,19}$'),
 block_hash text CHECK(block_hash IS NULL OR block_hash ~ '^0x[0-9a-f]{64}$'),
 confirmations integer NOT NULL DEFAULT 0 CHECK(confirmations>=0),
 submitted_at timestamptz,
 confirmed_at timestamptz,
 failed_at timestamptz,
 failure_reason text CHECK(failure_reason IS NULL OR failure_reason IN('user_operation_reverted','preparation_expired','preparation_abandoned','authorization_nonce_changed')),
 actual_gas_cost_wei text CHECK(actual_gas_cost_wei IS NULL OR actual_gas_cost_wei ~ '^(0|[1-9][0-9]{0,18})$'),
 observed_native_nonce text CHECK(observed_native_nonce IS NULL OR CASE WHEN observed_native_nonce ~ '^(0|[1-9][0-9]{0,77})$'
  THEN observed_native_nonce::numeric<=115792089237316195423570985008687907853269984665640564039457584007913129639935 ELSE false END),
 authorization_invalidated_at timestamptz,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '5 minutes'),
 CHECK(max_fee_wei::numeric<=owner_daily_cap_wei::numeric AND owner_daily_cap_wei::numeric<=global_daily_cap_wei::numeric),
 CHECK((authorized_at IS NULL AND authorization_ciphertext IS NULL AND authorization_key_id IS NULL)
  OR (authorized_at IS NOT NULL AND authorization_ciphertext IS NOT NULL AND authorization_key_id IS NOT NULL
    AND length(authorization_ciphertext) BETWEEN 64 AND 16384
    AND authorization_ciphertext ~ '^[a-z0-9_-]{1,16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$'
    AND authorization_key_id ~ '^[a-z0-9_-]{1,16}$' AND split_part(authorization_ciphertext,'.',1)=authorization_key_id)),
 CHECK((status IN('prepared','expired') AND authorized_at IS NULL AND attempt_id IS NULL AND user_operation_hash IS NULL AND transaction_hash IS NULL)
  OR (status='authorized' AND authorized_at IS NOT NULL AND attempt_id IS NULL AND user_operation_hash IS NULL AND transaction_hash IS NULL)
  OR (status IN('broadcasting','ambiguous','submitted','confirmed','failed') AND authorized_at IS NOT NULL AND attempt_id IS NOT NULL
    AND (status='broadcasting' OR user_operation_hash IS NOT NULL))
  OR (status='reconciliation_required' AND failure_reason='authorization_nonce_changed' AND authorized_at IS NOT NULL)),
 CHECK((status='confirmed' AND confirmed_at IS NOT NULL AND failed_at IS NULL AND failure_reason IS NULL)
  OR (status='failed' AND failed_at IS NOT NULL AND confirmed_at IS NULL AND failure_reason IS NOT NULL AND failure_reason='user_operation_reverted')
  OR (status='expired' AND failure_reason IS NOT NULL AND failure_reason IN('preparation_expired','preparation_abandoned') AND confirmed_at IS NULL AND failed_at IS NULL)
  OR (status='reconciliation_required' AND failure_reason IS NOT NULL AND failure_reason='authorization_nonce_changed' AND confirmed_at IS NULL AND failed_at IS NULL)
  OR (status IN('prepared','authorized','broadcasting','ambiguous','submitted') AND confirmed_at IS NULL AND failed_at IS NULL AND failure_reason IS NULL)),
 CHECK((status IN('confirmed','failed') AND transaction_hash IS NOT NULL AND block_number IS NOT NULL AND block_hash IS NOT NULL
    AND confirmations>=12 AND actual_gas_cost_wei IS NOT NULL AND actual_gas_cost_wei::numeric<=max_fee_wei::numeric)
  OR (status='reconciliation_required' AND failure_reason='authorization_nonce_changed' AND block_number IS NOT NULL AND block_hash IS NOT NULL AND confirmations>=12
    AND observed_native_nonce IS NOT NULL AND observed_native_nonce::numeric<>authorization_nonce::numeric AND authorization_invalidated_at IS NOT NULL)
  OR (status NOT IN('confirmed','failed','reconciliation_required') AND block_number IS NULL AND block_hash IS NULL AND confirmations=0 AND actual_gas_cost_wei IS NULL)),
 CHECK(failure_reason IS DISTINCT FROM 'authorization_nonce_changed' OR
  (observed_native_nonce IS NOT NULL AND observed_native_nonce::numeric<>authorization_nonce::numeric AND authorization_invalidated_at IS NOT NULL)),
 CHECK(transaction_hash IS NULL OR user_operation_hash IS NOT NULL)
);
CREATE INDEX personal_polygon_relay_subject_created_idx ON payments.personal_polygon_relay(subject,created_at DESC);
CREATE INDEX personal_polygon_relay_transaction_idx ON payments.personal_polygon_relay(transaction_hash) WHERE transaction_hash IS NOT NULL;
ALTER TABLE payments.personal_polygon_relay ENABLE ROW LEVEL SECURITY;

CREATE TABLE payments.personal_polygon_native_authorization (
 chain_id integer NOT NULL CHECK(chain_id=137),token_address text NOT NULL CHECK(token_address='0xc2132d05d31c914a87c6611c10748aeb04b58e8f'),
 wallet_address text NOT NULL CHECK(wallet_address ~ '^0x[0-9a-f]{40}$'),authorization_nonce text NOT NULL,
 payment_id uuid NOT NULL UNIQUE REFERENCES payments.personal_polygon_relay(id) ON DELETE RESTRICT,
 subject text NOT NULL REFERENCES auth."user"(id) ON DELETE RESTRICT,authorization_digest text NOT NULL CHECK(authorization_digest ~ '^0x[0-9a-f]{64}$'),
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(chain_id,token_address,wallet_address,authorization_nonce)
);
CREATE INDEX personal_polygon_native_auth_subject_idx ON payments.personal_polygon_native_authorization(subject);
ALTER TABLE payments.personal_polygon_native_authorization ENABLE ROW LEVEL SECURITY;

CREATE TABLE payments.personal_polygon_relay_attempt (
 id uuid PRIMARY KEY CHECK(id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 payment_id uuid NOT NULL REFERENCES payments.personal_polygon_relay(id) ON DELETE RESTRICT,
 subject text NOT NULL REFERENCES auth."user"(id) ON DELETE RESTRICT,
 chain_id integer NOT NULL CHECK(chain_id=137),entry_point text NOT NULL CHECK(entry_point='0x0000000071727de22e5e9d8baf0edac6f37da032'),
 relayer_address text NOT NULL CHECK(relayer_address ~ '^0x[0-9a-f]{40}$'),
 entry_point_nonce text NOT NULL CHECK(CASE WHEN entry_point_nonce ~ '^(0|[1-9][0-9]{0,77})$'
  THEN entry_point_nonce::numeric<=115792089237316195423570985008687907853269984665640564039457584007913129639935 ELSE false END),
 state text NOT NULL DEFAULT 'building' CHECK(state IN('building','persisted','ambiguous','submitted','confirmed','failed','released','expired')),
 lease_token uuid NOT NULL,lease_expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(lease_expires_at>created_at)
);
CREATE UNIQUE INDEX personal_polygon_relay_nonce_active_idx ON payments.personal_polygon_relay_attempt(chain_id,entry_point,relayer_address,entry_point_nonce) WHERE state NOT IN('released','expired');
CREATE INDEX personal_polygon_relay_attempt_payment_idx ON payments.personal_polygon_relay_attempt(payment_id,created_at DESC);
CREATE INDEX personal_polygon_relay_attempt_subject_idx ON payments.personal_polygon_relay_attempt(subject,created_at DESC);
ALTER TABLE payments.personal_polygon_relay_attempt ENABLE ROW LEVEL SECURITY;
CREATE TABLE payments.personal_polygon_relay_account (
 chain_id integer NOT NULL CHECK(chain_id=137),entry_point text NOT NULL CHECK(entry_point='0x0000000071727de22e5e9d8baf0edac6f37da032'),
 relayer_address text NOT NULL CHECK(relayer_address ~ '^0x[0-9a-f]{40}$'),
 active_attempt_id uuid UNIQUE REFERENCES payments.personal_polygon_relay_attempt(id) ON DELETE RESTRICT,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(chain_id,entry_point,relayer_address)
);
ALTER TABLE payments.personal_polygon_relay_account ENABLE ROW LEVEL SECURITY;
CREATE TABLE payments.personal_polygon_relay_operation (
 attempt_id uuid PRIMARY KEY REFERENCES payments.personal_polygon_relay_attempt(id) ON DELETE RESTRICT,
 payment_id uuid NOT NULL REFERENCES payments.personal_polygon_relay(id) ON DELETE RESTRICT,
 user_operation_hash text NOT NULL UNIQUE CHECK(user_operation_hash ~ '^0x[0-9a-f]{64}$'),
 operation_ciphertext text NOT NULL CHECK(length(operation_ciphertext) BETWEEN 64 AND 45000
  AND operation_ciphertext ~ '^[a-z0-9_-]{1,16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$'),
 operation_key_id text NOT NULL CHECK(operation_key_id ~ '^[a-z0-9_-]{1,16}$' AND split_part(operation_ciphertext,'.',1)=operation_key_id),
 quoted_max_fee_wei text NOT NULL CHECK(quoted_max_fee_wei ~ '^[1-9][0-9]{0,18}$' AND quoted_max_fee_wei::numeric<=1000000000000000000),
 operation_valid_after bigint NOT NULL CHECK(operation_valid_after>=0 AND operation_valid_after<281474976710656),
 operation_valid_until bigint NOT NULL CHECK(operation_valid_until>0 AND operation_valid_until<281474976710656),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),CHECK(operation_valid_until>operation_valid_after)
);
CREATE INDEX personal_polygon_relay_operation_payment_idx ON payments.personal_polygon_relay_operation(payment_id);
ALTER TABLE payments.personal_polygon_relay_operation ENABLE ROW LEVEL SECURITY;
CREATE TABLE payments.personal_polygon_sponsor_reservation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),payment_id uuid NOT NULL REFERENCES payments.personal_polygon_relay(id) ON DELETE RESTRICT,
 subject text NOT NULL REFERENCES auth."user"(id) ON DELETE RESTRICT,
 attempt_id uuid UNIQUE REFERENCES payments.personal_polygon_relay_attempt(id) ON DELETE RESTRICT,
 unit text NOT NULL DEFAULT 'POL_WEI' CHECK(unit='POL_WEI'),max_fee_wei text NOT NULL CHECK(max_fee_wei ~ '^[1-9][0-9]{0,18}$' AND max_fee_wei::numeric<=1000000000000000000),
 state text NOT NULL DEFAULT 'held' CHECK(state IN('held','spent','released')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),closed_at timestamptz,
 CHECK((state='held' AND closed_at IS NULL) OR (state<>'held' AND closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX personal_polygon_reservation_unsigned_idx ON payments.personal_polygon_sponsor_reservation(payment_id) WHERE attempt_id IS NULL AND state='held';
CREATE INDEX personal_polygon_reservation_subject_idx ON payments.personal_polygon_sponsor_reservation(subject,state,closed_at);
CREATE INDEX personal_polygon_reservation_state_idx ON payments.personal_polygon_sponsor_reservation(state,closed_at);
ALTER TABLE payments.personal_polygon_sponsor_reservation ENABLE ROW LEVEL SECURITY;
CREATE TABLE payments.personal_polygon_operation_expiry (
 attempt_id uuid PRIMARY KEY REFERENCES payments.personal_polygon_relay_attempt(id) ON DELETE RESTRICT,
 payment_id uuid NOT NULL REFERENCES payments.personal_polygon_relay(id) ON DELETE RESTRICT,
 user_operation_hash text NOT NULL CHECK(user_operation_hash ~ '^0x[0-9a-f]{64}$'),
 block_number text NOT NULL CHECK(block_number ~ '^[1-9][0-9]{0,19}$'),block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 canonical_timestamp bigint NOT NULL CHECK(canonical_timestamp>0),observed_aa_nonce text NOT NULL,
 observed_native_nonce text NOT NULL,
 confirmations integer NOT NULL CHECK(confirmations>=12),checked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX personal_polygon_operation_expiry_payment_idx ON payments.personal_polygon_operation_expiry(payment_id);
ALTER TABLE payments.personal_polygon_operation_expiry ENABLE ROW LEVEL SECURITY;
CREATE TABLE payments.personal_polygon_relay_event (
 event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 payment_id uuid NOT NULL REFERENCES payments.personal_polygon_relay(id) ON DELETE RESTRICT,
 subject text NOT NULL REFERENCES auth."user"(id) ON DELETE RESTRICT,
 attempt_id uuid REFERENCES payments.personal_polygon_relay_attempt(id) ON DELETE RESTRICT,
 source text NOT NULL DEFAULT 'canonical' CHECK(source IN('canonical','client_reported')),
 event text NOT NULL CHECK(event IN('prepared','authorized','broadcasting','ambiguous','submitted','confirmed','failed','expired','reconciliation_required',
  'operation_persisted','operation_expired','attempt_released','attempt_failed','lease_reclaimed','transaction_observed')),
 canonical_status text NOT NULL CHECK(canonical_status IN('prepared','authorized','broadcasting','ambiguous','submitted','confirmed','failed','expired','reconciliation_required')),
 wallet_address text NOT NULL,amount_atomic text NOT NULL,chain_id integer NOT NULL CHECK(chain_id=137),
 token_address text NOT NULL CHECK(token_address='0xc2132d05d31c914a87c6611c10748aeb04b58e8f'),
 recipient_address text NOT NULL CHECK(recipient_address='0x0a600b03ef5f8e7f3e182b83440c6d292033db0e'),
 authorization_digest text NOT NULL,user_operation_hash text,transaction_hash text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),CHECK(source='canonical')
);
CREATE INDEX personal_polygon_relay_event_subject_idx ON payments.personal_polygon_relay_event(subject,seq DESC);
CREATE INDEX personal_polygon_relay_event_payment_idx ON payments.personal_polygon_relay_event(subject,payment_id,seq DESC);
ALTER TABLE payments.personal_polygon_relay_event ENABLE ROW LEVEL SECURITY;

CREATE TABLE payments.personal_polygon_relay_outcome (
 attempt_id uuid PRIMARY KEY REFERENCES payments.personal_polygon_relay_attempt(id) ON DELETE RESTRICT,
 payment_id uuid NOT NULL REFERENCES payments.personal_polygon_relay(id) ON DELETE RESTRICT,
 result text NOT NULL CHECK(result IN('confirmed','failed')),
 user_operation_hash text NOT NULL CHECK(user_operation_hash ~ '^0x[0-9a-f]{64}$'),
 transaction_hash text NOT NULL CHECK(transaction_hash ~ '^0x[0-9a-f]{64}$'),
 block_number text NOT NULL CHECK(block_number ~ '^[1-9][0-9]{0,19}$'),block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 confirmations integer NOT NULL CHECK(confirmations>=12),actual_gas_cost_wei text NOT NULL,
 reason text CHECK(reason IS NULL OR reason='user_operation_reverted'),
 observed_native_nonce text,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((result='confirmed' AND reason IS NULL) OR (result='failed' AND reason IS NOT NULL AND observed_native_nonce IS NOT NULL))
);
CREATE INDEX personal_polygon_relay_outcome_payment_idx ON payments.personal_polygon_relay_outcome(payment_id);
ALTER TABLE payments.personal_polygon_relay_outcome ENABLE ROW LEVEL SECURITY;
CREATE TABLE payments.personal_polygon_authorization_retirement (
 payment_id uuid PRIMARY KEY REFERENCES payments.personal_polygon_relay(id) ON DELETE RESTRICT,
 observed_native_nonce text NOT NULL,block_number text NOT NULL CHECK(block_number ~ '^[1-9][0-9]{0,19}$'),
 block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),confirmations integer NOT NULL CHECK(confirmations>=12),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE payments.personal_polygon_authorization_retirement ENABLE ROW LEVEL SECURITY;

CREATE VIEW payments.personal_polygon_relay_internal AS SELECT p.*,a.entry_point_nonce,a.lease_token,a.lease_expires_at,
 o.operation_ciphertext,o.operation_key_id,o.quoted_max_fee_wei,o.operation_valid_after,o.operation_valid_until
 FROM payments.personal_polygon_relay p LEFT JOIN payments.personal_polygon_relay_attempt a ON a.id=p.attempt_id
 LEFT JOIN payments.personal_polygon_relay_operation o ON o.attempt_id=a.id;
CREATE VIEW payments.personal_polygon_relay_dispatch AS SELECT p.*,false AS should_prepare,false AS should_send FROM payments.personal_polygon_relay_internal p;

CREATE FUNCTION payments.guard_polygon_relay_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN RAISE EXCEPTION 'polygon_relay_append_only' USING ERRCODE='22023'; END $function$;
DO $immutable_tables$
DECLARE item text;
BEGIN
 FOREACH item IN ARRAY ARRAY['personal_polygon_native_authorization','personal_polygon_relay_operation','personal_polygon_operation_expiry','personal_polygon_relay_event',
  'personal_polygon_relay_outcome','personal_polygon_authorization_retirement'] LOOP
  EXECUTE pg_catalog.format('CREATE TRIGGER polygon_relay_immutable BEFORE UPDATE OR DELETE ON payments.%I FOR EACH ROW EXECUTE FUNCTION payments.guard_polygon_relay_append_only()',item);
  EXECUTE pg_catalog.format('CREATE TRIGGER polygon_relay_no_truncate BEFORE TRUNCATE ON payments.%I FOR EACH STATEMENT EXECUTE FUNCTION payments.guard_polygon_relay_append_only()',item);
 END LOOP;
END $immutable_tables$;
CREATE FUNCTION payments.guard_personal_transfer_request() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'personal_transfer_request_immutable' USING ERRCODE='22023'; END IF;
 IF ROW(NEW.id,NEW.subject,NEW.source_kind,NEW.chain_namespace,NEW.chain_reference,NEW.wallet_address,NEW.token_address,NEW.recipient_address,NEW.amount_atomic,NEW.expires_at,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.subject,OLD.source_kind,OLD.chain_namespace,OLD.chain_reference,OLD.wallet_address,OLD.token_address,OLD.recipient_address,OLD.amount_atomic,OLD.expires_at,OLD.created_at) THEN
  RAISE EXCEPTION 'personal_transfer_request_immutable' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER personal_transfer_request_immutable BEFORE UPDATE OR DELETE ON payments.personal_transfer_request FOR EACH ROW EXECUTE FUNCTION payments.guard_personal_transfer_request();
CREATE TRIGGER personal_transfer_request_no_truncate BEFORE TRUNCATE ON payments.personal_transfer_request FOR EACH STATEMENT EXECUTE FUNCTION payments.guard_personal_transfer_request();

CREATE FUNCTION payments.guard_polygon_relay_attempt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'polygon_relay_attempt_immutable' USING ERRCODE='22023'; END IF;
 IF ROW(NEW.id,NEW.payment_id,NEW.subject,NEW.chain_id,NEW.entry_point,NEW.relayer_address,NEW.entry_point_nonce,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.payment_id,OLD.subject,OLD.chain_id,OLD.entry_point,OLD.relayer_address,OLD.entry_point_nonce,OLD.created_at)
  OR (ROW(NEW.lease_token,NEW.lease_expires_at) IS DISTINCT FROM ROW(OLD.lease_token,OLD.lease_expires_at)
    AND (OLD.state<>'building' OR NEW.state<>'building' OR EXISTS(SELECT 1 FROM payments.personal_polygon_relay_operation o WHERE o.attempt_id=OLD.id))) THEN
  RAISE EXCEPTION 'polygon_relay_attempt_immutable' USING ERRCODE='22023'; END IF;
 IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
  (OLD.state='building' AND NEW.state IN('persisted','released'))
  OR (OLD.state IN('persisted','ambiguous','submitted') AND NEW.state IN('ambiguous','submitted','confirmed','failed','expired'))) THEN
  RAISE EXCEPTION 'polygon_relay_invalid_transition' USING ERRCODE='22023'; END IF;
 IF NEW.state IN('persisted','ambiguous','submitted','confirmed','failed','expired')
  AND NOT EXISTS(SELECT 1 FROM payments.personal_polygon_relay_operation o WHERE o.attempt_id=NEW.id AND o.payment_id=NEW.payment_id) THEN
  RAISE EXCEPTION 'polygon_relay_operation_required' USING ERRCODE='22023'; END IF;
 IF NEW.state='released' AND EXISTS(SELECT 1 FROM payments.personal_polygon_relay_operation o WHERE o.attempt_id=NEW.id) THEN
  RAISE EXCEPTION 'polygon_relay_operation_locked' USING ERRCODE='22023'; END IF;
 IF NEW.state='expired' AND NOT EXISTS(SELECT 1 FROM payments.personal_polygon_operation_expiry e WHERE e.attempt_id=NEW.id AND e.payment_id=NEW.payment_id) THEN
  RAISE EXCEPTION 'polygon_relay_expiry_proof_required' USING ERRCODE='22023'; END IF;
 IF NEW.state IN('confirmed','failed') AND NOT EXISTS(SELECT 1 FROM payments.personal_polygon_relay_outcome o
  WHERE o.attempt_id=NEW.id AND o.payment_id=NEW.payment_id AND o.result=NEW.state) THEN
  RAISE EXCEPTION 'polygon_relay_receipt_required' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER polygon_relay_attempt_immutable BEFORE UPDATE OR DELETE ON payments.personal_polygon_relay_attempt FOR EACH ROW EXECUTE FUNCTION payments.guard_polygon_relay_attempt();
CREATE TRIGGER polygon_relay_attempt_no_truncate BEFORE TRUNCATE ON payments.personal_polygon_relay_attempt FOR EACH STATEMENT EXECUTE FUNCTION payments.guard_polygon_relay_attempt();
CREATE FUNCTION payments.guard_polygon_relay_reservation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'polygon_relay_budget_immutable' USING ERRCODE='22023'; END IF;
 IF ROW(NEW.id,NEW.payment_id,NEW.subject,NEW.unit,NEW.max_fee_wei,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.payment_id,OLD.subject,OLD.unit,OLD.max_fee_wei,OLD.created_at)
  OR (OLD.attempt_id IS NOT NULL AND NEW.attempt_id IS DISTINCT FROM OLD.attempt_id)
  OR (OLD.state<>'held' AND ROW(NEW.state,NEW.closed_at) IS DISTINCT FROM ROW(OLD.state,OLD.closed_at))
  OR (NEW.attempt_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM payments.personal_polygon_relay_attempt a
   WHERE a.id=NEW.attempt_id AND a.payment_id=NEW.payment_id AND a.subject=NEW.subject)) THEN
  RAISE EXCEPTION 'polygon_relay_budget_immutable' USING ERRCODE='22023'; END IF;
 IF NEW.state='spent' AND NOT EXISTS(SELECT 1 FROM payments.personal_polygon_relay_attempt a
   WHERE a.id=NEW.attempt_id AND a.state IN('confirmed','failed','expired')) THEN
  RAISE EXCEPTION 'polygon_relay_budget_proof_required' USING ERRCODE='22023'; END IF;
 IF NEW.state='released' AND ((NEW.attempt_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM payments.personal_polygon_relay_attempt a
   WHERE a.id=NEW.attempt_id AND a.state='released')) OR (NEW.attempt_id IS NULL AND NOT EXISTS(SELECT 1 FROM payments.personal_polygon_relay p
    WHERE p.id=NEW.payment_id AND (p.authorized_at IS NULL OR EXISTS(SELECT 1 FROM payments.personal_polygon_authorization_retirement r WHERE r.payment_id=p.id))))) THEN
  RAISE EXCEPTION 'polygon_relay_budget_proof_required' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER polygon_relay_budget_immutable BEFORE UPDATE OR DELETE ON payments.personal_polygon_sponsor_reservation FOR EACH ROW EXECUTE FUNCTION payments.guard_polygon_relay_reservation();
CREATE TRIGGER polygon_relay_budget_no_truncate BEFORE TRUNCATE ON payments.personal_polygon_sponsor_reservation FOR EACH STATEMENT EXECUTE FUNCTION payments.guard_polygon_relay_reservation();
CREATE FUNCTION payments.guard_polygon_relay_account() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'polygon_relay_account_immutable' USING ERRCODE='22023'; END IF;
 IF ROW(NEW.chain_id,NEW.entry_point,NEW.relayer_address) IS DISTINCT FROM ROW(OLD.chain_id,OLD.entry_point,OLD.relayer_address)
  OR (OLD.active_attempt_id IS NOT NULL AND NEW.active_attempt_id IS NOT NULL AND NEW.active_attempt_id<>OLD.active_attempt_id) THEN
  RAISE EXCEPTION 'polygon_relay_queue_busy' USING ERRCODE='22023'; END IF;
 IF OLD.active_attempt_id IS NOT NULL AND NEW.active_attempt_id IS NULL AND NOT EXISTS(
  SELECT 1 FROM payments.personal_polygon_relay_attempt a WHERE a.id=OLD.active_attempt_id AND a.state IN('confirmed','failed','released','expired')) THEN
  RAISE EXCEPTION 'polygon_relay_operation_locked' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER polygon_relay_account_immutable BEFORE UPDATE OR DELETE ON payments.personal_polygon_relay_account FOR EACH ROW EXECUTE FUNCTION payments.guard_polygon_relay_account();
CREATE TRIGGER polygon_relay_account_no_truncate BEFORE TRUNCATE ON payments.personal_polygon_relay_account FOR EACH STATEMENT EXECUTE FUNCTION payments.guard_polygon_relay_account();

CREATE FUNCTION payments.personal_transfer_creation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_kind text;v_namespace text;v_chain text;v_token text;v_recipient text;v_abandoned timestamptz;v_prefix text;v_now timestamptz;
 v_solana_pending boolean:=false;v_solana_id_used boolean:=false;v_solana_count bigint:=0;
BEGIN
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'personal_transfer_read_committed_required' USING ERRCODE='22023'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personal-company-payment:'||NEW.subject,0));
 -- Acquire owner before the existing EVM AFTER audit trigger's event lock.
 -- This keeps source status updates and new-intent creation in one lock order.
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='personal_company_payment' THEN
   -- A live legacy receipt may have committed after the operator's RR snapshot
   -- but before trigger installation. Repair only its new metadata reference;
   -- never rewrite the receipt or let an absent cached reference block recovery.
   INSERT INTO payments.personal_transfer_request(id,subject,source_kind,chain_namespace,chain_reference,wallet_address,token_address,
    recipient_address,amount_atomic,status,expires_at,abandoned_at,created_at)
   VALUES(OLD.id,OLD.subject,'evm_direct','eip155',OLD.chain_id::text,OLD.wallet_address,OLD.token_address,
    OLD.recipient_address,OLD.amount_atomic,OLD.status,OLD.expires_at,OLD.abandoned_at,OLD.created_at) ON CONFLICT DO NOTHING;
   IF NOT EXISTS(SELECT 1 FROM payments.personal_transfer_request r WHERE r.id=OLD.id AND r.subject=OLD.subject
    AND r.source_kind='evm_direct' AND r.chain_reference=OLD.chain_id::text AND r.wallet_address=OLD.wallet_address
    AND r.token_address=OLD.token_address AND r.recipient_address=OLD.recipient_address AND r.amount_atomic=OLD.amount_atomic) THEN
    RAISE EXCEPTION 'personal_transfer_registry_conflict' USING ERRCODE='22023'; END IF;
  END IF;
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='personal_company_payment' THEN
  v_kind:='evm_direct';v_namespace:='eip155';v_chain:=NEW.chain_id::text;v_token:=NEW.token_address;v_recipient:=NEW.recipient_address;v_abandoned:=NEW.abandoned_at;v_prefix:='company_payment_';
  PERFORM payments.assert_personal_company_payment_owner(NEW.subject,NEW.wallet_address);
 ELSIF TG_TABLE_NAME='personal_polygon_relay' THEN
  v_kind:='polygon_native_meta';v_namespace:='eip155';v_chain:='137';v_token:=NEW.token_address;v_recipient:=NEW.recipient_address;v_prefix:='polygon_relay_';
  PERFORM payments.assert_personal_company_payment_owner(NEW.subject,NEW.wallet_address);
 ELSIF TG_TABLE_NAME='personal_solana_payment' THEN
  v_kind:='solana_sponsored';v_namespace:='solana';v_chain:='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';v_token:=NEW.token_mint;v_recipient:=NEW.recipient_address;v_prefix:='solana_payment_';
  PERFORM identity.administrative_wallet_person(NEW.subject);
  IF NOT EXISTS(SELECT 1 FROM identity.solana_wallet_binding b WHERE b.subject=NEW.subject AND b.address=NEW.wallet_address
   AND b.cluster='mainnet-beta' AND b.genesis_hash='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') THEN
   RAISE EXCEPTION 'solana_payment_wallet_not_linked' USING ERRCODE='28000'; END IF;
 ELSE RAISE EXCEPTION 'personal_transfer_source_invalid' USING ERRCODE='22023'; END IF;
 v_now:=clock_timestamp();
 IF NEW.status<>'prepared' OR NEW.expires_at<=v_now THEN RAISE EXCEPTION '%invalid_request',v_prefix USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM payments.personal_transfer_request r WHERE r.id=NEW.id)
  OR EXISTS(SELECT 1 FROM payments.personal_company_payment p WHERE p.id=NEW.id) THEN
  RAISE EXCEPTION '%request_already_used',v_prefix USING ERRCODE='22023'; END IF;
 IF pg_catalog.to_regclass('payments.personal_solana_payment') IS NOT NULL THEN
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM payments.personal_solana_payment p WHERE p.id=$1),
   EXISTS(SELECT 1 FROM payments.personal_solana_payment p WHERE p.subject=$2 AND
    (p.status IN(''broadcasting'',''ambiguous'',''submitted'') OR (p.status=''prepared'' AND p.expires_at>$3))),
   (SELECT count(*) FROM payments.personal_solana_payment p WHERE p.subject=$2 AND p.created_at>$3-interval ''10 minutes'')'
   INTO v_solana_id_used,v_solana_pending,v_solana_count USING NEW.id,NEW.subject,v_now;
  IF v_solana_id_used THEN RAISE EXCEPTION '%request_already_used',v_prefix USING ERRCODE='22023'; END IF;
 END IF;
 -- Status caches copied under an operator snapshot are not authoritative.
 -- Read the legacy source at WRITE TIME, after the owner lock, in RC.
 IF v_solana_pending OR EXISTS(SELECT 1 FROM payments.personal_company_payment p WHERE p.subject=NEW.subject
   AND (p.status='submitted' OR (p.status='prepared' AND p.expires_at>v_now AND p.abandoned_at IS NULL)))
  OR EXISTS(SELECT 1 FROM payments.personal_polygon_relay p WHERE p.subject=NEW.subject AND
   (p.status IN('authorized','broadcasting','ambiguous','submitted','reconciliation_required') OR (p.status='prepared' AND p.expires_at>v_now))) THEN
  RAISE EXCEPTION '%pending_exists',v_prefix USING ERRCODE='22023'; END IF;
 IF (SELECT count(*) FROM payments.personal_company_payment p WHERE p.subject=NEW.subject AND p.created_at>v_now-interval '10 minutes')
  +(SELECT count(*) FROM payments.personal_polygon_relay p WHERE p.subject=NEW.subject AND p.created_at>v_now-interval '10 minutes')+v_solana_count>=5 THEN
  RAISE EXCEPTION '%rate_limited',v_prefix USING ERRCODE='54000'; END IF;
 BEGIN
  INSERT INTO payments.personal_transfer_request(id,subject,source_kind,chain_namespace,chain_reference,wallet_address,token_address,
   recipient_address,amount_atomic,status,expires_at,abandoned_at,created_at)
  VALUES(NEW.id,NEW.subject,v_kind,v_namespace,v_chain,NEW.wallet_address,v_token,v_recipient,NEW.amount_atomic,NEW.status,NEW.expires_at,v_abandoned,NEW.created_at);
 EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION '%request_already_used',v_prefix USING ERRCODE='22023'; END;
 RETURN NEW;
END $function$;
CREATE FUNCTION payments.personal_transfer_status_mirror() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_abandoned timestamptz;
BEGIN
 IF TG_TABLE_NAME='personal_company_payment' THEN v_abandoned:=NEW.abandoned_at; END IF;
 UPDATE payments.personal_transfer_request r SET status=NEW.status,abandoned_at=v_abandoned,updated_at=clock_timestamp()
  WHERE r.id=NEW.id AND r.subject=NEW.subject;
 IF NOT FOUND THEN RAISE EXCEPTION 'personal_transfer_registry_missing' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END $function$;
-- Imported references are additional metadata, never rewritten source receipts.
INSERT INTO payments.personal_transfer_request(id,subject,source_kind,chain_namespace,chain_reference,wallet_address,token_address,
 recipient_address,amount_atomic,status,expires_at,abandoned_at,created_at)
 SELECT p.id,p.subject,'evm_direct','eip155',p.chain_id::text,p.wallet_address,p.token_address,p.recipient_address,p.amount_atomic,
 p.status,p.expires_at,p.abandoned_at,p.created_at FROM payments.personal_company_payment p;
CREATE TRIGGER personal_company_payment_global_guard BEFORE INSERT OR UPDATE ON payments.personal_company_payment
 FOR EACH ROW EXECUTE FUNCTION payments.personal_transfer_creation_guard();
CREATE TRIGGER personal_company_payment_global_mirror AFTER UPDATE ON payments.personal_company_payment
 FOR EACH ROW EXECUTE FUNCTION payments.personal_transfer_status_mirror();
CREATE TRIGGER polygon_relay_global_guard BEFORE INSERT OR UPDATE ON payments.personal_polygon_relay
 FOR EACH ROW EXECUTE FUNCTION payments.personal_transfer_creation_guard();
CREATE TRIGGER polygon_relay_global_mirror AFTER UPDATE ON payments.personal_polygon_relay
 FOR EACH ROW EXECUTE FUNCTION payments.personal_transfer_status_mirror();

CREATE FUNCTION payments.polygon_relay_budget_total(p_subject text) RETURNS numeric
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT coalesce(sum(r.max_fee_wei::numeric),0) FROM payments.personal_polygon_sponsor_reservation r
 JOIN payments.personal_polygon_relay p ON p.id=r.payment_id
 WHERE (p_subject IS NULL OR r.subject=p_subject) AND r.unit='POL_WEI' AND
  ((r.state='held' AND (p.status<>'prepared' OR p.expires_at>clock_timestamp()))
   OR (r.state='spent' AND (r.closed_at AT TIME ZONE 'UTC')::date=(clock_timestamp() AT TIME ZONE 'UTC')::date));
$function$;
CREATE FUNCTION payments.polygon_relay_lock(p_subject text,p_id uuid,p_lane boolean)
RETURNS SETOF payments.personal_polygon_relay LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v payments.personal_polygon_relay%ROWTYPE;
BEGIN
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' OR p_id IS NULL THEN
  RAISE EXCEPTION 'polygon_relay_invalid_request' USING ERRCODE='22023'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('polygon-relay-budget:137:POL_WEI',0));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personal-company-payment:'||p_subject,0));
 SELECT p.* INTO v FROM payments.personal_polygon_relay p WHERE p.id=p_id AND p.subject=p_subject;
 IF NOT FOUND THEN RAISE EXCEPTION 'polygon_relay_not_found' USING ERRCODE='P0002'; END IF;
 PERFORM payments.assert_personal_company_payment_owner(p_subject,v.wallet_address);
 IF p_lane THEN
  INSERT INTO payments.personal_polygon_relay_account(chain_id,entry_point,relayer_address)
   VALUES(137,v.entry_point,v.relayer_address) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM payments.personal_polygon_relay_account a WHERE a.chain_id=137 AND a.entry_point=v.entry_point AND a.relayer_address=v.relayer_address FOR UPDATE;
 END IF;
 RETURN QUERY SELECT p.* FROM payments.personal_polygon_relay p WHERE p.id=p_id AND p.subject=p_subject FOR UPDATE;
END $function$;
CREATE FUNCTION payments.polygon_relay_dispatch_result(p_id uuid,p_prepare boolean,p_send boolean)
RETURNS SETOF payments.personal_polygon_relay_dispatch LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT p.*,p_prepare,p_send FROM payments.personal_polygon_relay_internal p WHERE p.id=p_id;
$function$;
CREATE FUNCTION payments.polygon_relay_append_event(p_subject text,p_id uuid,p_event text,p_attempt uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personal-company-events:'||p_subject,0));
 INSERT INTO payments.personal_polygon_relay_event(payment_id,subject,attempt_id,event,canonical_status,wallet_address,
  amount_atomic,chain_id,token_address,recipient_address,authorization_digest,user_operation_hash,transaction_hash)
 SELECT p.id,p.subject,p_attempt,p_event,p.status,p.wallet_address,p.amount_atomic,137,p.token_address,p.recipient_address,
  p.authorization_digest,coalesce(p.user_operation_hash,(SELECT o.user_operation_hash FROM payments.personal_polygon_relay_operation o WHERE o.attempt_id=p_attempt)),
  coalesce(p.transaction_hash,(SELECT o.transaction_hash FROM payments.personal_polygon_relay_outcome o WHERE o.attempt_id=p_attempt))
  FROM payments.personal_polygon_relay p WHERE p.id=p_id AND p.subject=p_subject;
 IF NOT FOUND THEN RAISE EXCEPTION 'polygon_relay_not_found' USING ERRCODE='P0002'; END IF;
END $function$;
CREATE FUNCTION payments.capture_polygon_relay_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_event text;v_attempt uuid;
BEGIN
 v_attempt:=NEW.attempt_id;
 IF TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
  v_event:=NEW.status;
  IF TG_OP='UPDATE' AND NEW.status='authorized' THEN
   v_attempt:=OLD.attempt_id;
   v_event:=CASE WHEN EXISTS(SELECT 1 FROM payments.personal_polygon_operation_expiry e WHERE e.attempt_id=OLD.attempt_id)
    THEN 'operation_expired' WHEN EXISTS(SELECT 1 FROM payments.personal_polygon_relay_outcome o WHERE o.attempt_id=OLD.attempt_id AND o.result='failed')
    THEN 'attempt_failed' ELSE 'attempt_released' END;
  END IF;
 ELSIF NEW.user_operation_hash IS DISTINCT FROM OLD.user_operation_hash THEN v_event:='operation_persisted';
 ELSIF NEW.transaction_hash IS DISTINCT FROM OLD.transaction_hash THEN v_event:='transaction_observed';
 ELSE RETURN NEW; END IF;
 PERFORM payments.polygon_relay_append_event(NEW.subject,NEW.id,v_event,v_attempt);
 RETURN NEW;
END $function$;
CREATE TRIGGER polygon_relay_audit AFTER INSERT OR UPDATE ON payments.personal_polygon_relay
 FOR EACH ROW EXECUTE FUNCTION payments.capture_polygon_relay_event();

CREATE FUNCTION payments.guard_personal_polygon_relay() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
DECLARE v_reset boolean:=false;
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'polygon_relay_snapshot_immutable' USING ERRCODE='22023'; END IF;
 IF ROW(NEW.id,NEW.subject,NEW.wallet_address,NEW.amount_atomic,NEW.execution_mode,NEW.chain_id,NEW.token_address,NEW.token_decimals,
  NEW.recipient_address,NEW.authorization_nonce,NEW.authorization_digest,NEW.domain_separator,NEW.implementation_address,
  NEW.relayer_address,NEW.entry_point,NEW.max_fee_wei,NEW.owner_daily_cap_wei,NEW.global_daily_cap_wei,NEW.created_at,NEW.expires_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.subject,OLD.wallet_address,OLD.amount_atomic,OLD.execution_mode,OLD.chain_id,OLD.token_address,OLD.token_decimals,
  OLD.recipient_address,OLD.authorization_nonce,OLD.authorization_digest,OLD.domain_separator,OLD.implementation_address,
  OLD.relayer_address,OLD.entry_point,OLD.max_fee_wei,OLD.owner_daily_cap_wei,OLD.global_daily_cap_wei,OLD.created_at,OLD.expires_at)
  OR (OLD.status IN('confirmed','failed','expired','reconciliation_required') AND NEW IS DISTINCT FROM OLD) THEN
  RAISE EXCEPTION 'polygon_relay_snapshot_immutable' USING ERRCODE='22023'; END IF;
 IF OLD.authorized_at IS NOT NULL AND ROW(NEW.authorized_at,NEW.authorization_ciphertext,NEW.authorization_key_id)
  IS DISTINCT FROM ROW(OLD.authorized_at,OLD.authorization_ciphertext,OLD.authorization_key_id) THEN
  RAISE EXCEPTION 'polygon_relay_authorization_immutable' USING ERRCODE='22023'; END IF;
 IF OLD.authorized_at IS NULL AND NEW.authorized_at IS NOT NULL AND (OLD.status<>'prepared' OR NEW.status<>'authorized'
  OR NOT EXISTS(SELECT 1 FROM payments.personal_polygon_native_authorization a WHERE a.payment_id=NEW.id
    AND a.subject=NEW.subject AND a.authorization_digest=NEW.authorization_digest AND a.authorization_nonce=NEW.authorization_nonce)) THEN
  RAISE EXCEPTION 'polygon_relay_authorization_required' USING ERRCODE='22023'; END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
  (OLD.status='prepared' AND NEW.status IN('authorized','expired')) OR (OLD.status='authorized' AND NEW.status='broadcasting')
  OR (OLD.status='authorized' AND NEW.status='reconciliation_required')
  OR (OLD.status='broadcasting' AND NEW.status IN('authorized','ambiguous','submitted','confirmed','failed','reconciliation_required'))
  OR (OLD.status='ambiguous' AND NEW.status IN('authorized','submitted','confirmed','failed','reconciliation_required'))
  OR (OLD.status='submitted' AND NEW.status IN('authorized','confirmed','failed','reconciliation_required'))) THEN
  RAISE EXCEPTION 'polygon_relay_invalid_transition' USING ERRCODE='22023'; END IF;
 IF OLD.attempt_id IS NOT NULL AND NEW.attempt_id IS NULL THEN
  v_reset:=(NEW.status='authorized' AND EXISTS(SELECT 1 FROM payments.personal_polygon_relay_attempt a WHERE a.id=OLD.attempt_id
   AND a.payment_id=OLD.id AND ((a.state='released' AND OLD.user_operation_hash IS NULL)
    OR (a.state='expired' AND EXISTS(SELECT 1 FROM payments.personal_polygon_operation_expiry e WHERE e.attempt_id=a.id AND e.observed_native_nonce=OLD.authorization_nonce))
    OR (a.state='failed' AND EXISTS(SELECT 1 FROM payments.personal_polygon_relay_outcome o WHERE o.attempt_id=a.id AND o.result='failed' AND o.observed_native_nonce=OLD.authorization_nonce))))
   OR (NEW.status='reconciliation_required' AND OLD.user_operation_hash IS NULL
    AND EXISTS(SELECT 1 FROM payments.personal_polygon_authorization_retirement r WHERE r.payment_id=OLD.id)
    AND EXISTS(SELECT 1 FROM payments.personal_polygon_relay_attempt a WHERE a.id=OLD.attempt_id AND a.state='released')));
  IF NOT v_reset THEN RAISE EXCEPTION 'polygon_relay_operation_locked' USING ERRCODE='22023'; END IF;
 ELSIF NEW.attempt_id IS DISTINCT FROM OLD.attempt_id AND NOT (OLD.attempt_id IS NULL AND OLD.status='authorized' AND NEW.status='broadcasting'
  AND EXISTS(SELECT 1 FROM payments.personal_polygon_relay_attempt a WHERE a.id=NEW.attempt_id AND a.payment_id=NEW.id AND a.subject=NEW.subject
   AND a.entry_point=NEW.entry_point AND a.relayer_address=NEW.relayer_address AND a.state='building')) THEN
  RAISE EXCEPTION 'polygon_relay_attempt_conflict' USING ERRCODE='22023'; END IF;
 IF NEW.user_operation_hash IS DISTINCT FROM OLD.user_operation_hash AND NOT v_reset THEN
  IF OLD.user_operation_hash IS NOT NULL OR NEW.user_operation_hash IS NULL OR NOT EXISTS(
   SELECT 1 FROM payments.personal_polygon_relay_operation o WHERE o.attempt_id=NEW.attempt_id AND o.payment_id=NEW.id AND o.user_operation_hash=NEW.user_operation_hash) THEN
   RAISE EXCEPTION 'polygon_relay_operation_immutable' USING ERRCODE='22023'; END IF;
 END IF;
 IF OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at AND NOT v_reset THEN
  RAISE EXCEPTION 'polygon_relay_snapshot_immutable' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER polygon_relay_snapshot_immutable BEFORE UPDATE OR DELETE ON payments.personal_polygon_relay FOR EACH ROW EXECUTE FUNCTION payments.guard_personal_polygon_relay();
CREATE TRIGGER polygon_relay_no_truncate BEFORE TRUNCATE ON payments.personal_polygon_relay FOR EACH STATEMENT EXECUTE FUNCTION payments.guard_personal_polygon_relay();
ALTER TABLE payments.personal_polygon_relay ADD CONSTRAINT personal_polygon_current_attempt_fk FOREIGN KEY(attempt_id) REFERENCES payments.personal_polygon_relay_attempt(id) ON DELETE RESTRICT;

CREATE FUNCTION payments.read_personal_polygon_relay(p_subject text,p_id uuid)
RETURNS SETOF payments.personal_polygon_relay_internal LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v payments.personal_polygon_relay%ROWTYPE;
BEGIN
 SELECT p.* INTO v FROM payments.personal_polygon_relay p WHERE p.id=p_id AND p.subject=p_subject;
 IF NOT FOUND THEN RAISE EXCEPTION 'polygon_relay_not_found' USING ERRCODE='P0002'; END IF;
 PERFORM payments.assert_personal_company_payment_owner(p_subject,v.wallet_address);
 RETURN QUERY SELECT p.* FROM payments.personal_polygon_relay_internal p WHERE p.id=p_id AND p.subject=p_subject;
END $function$;
CREATE FUNCTION payments.read_personal_polygon_relay_history(p_subject text)
RETURNS SETOF payments.personal_polygon_relay_internal LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_address text;
BEGIN
 SELECT b.address INTO v_address FROM identity.wallet_binding b WHERE b.subject=p_subject;
 PERFORM payments.assert_personal_company_payment_owner(p_subject,v_address);
 RETURN QUERY SELECT p.* FROM payments.personal_polygon_relay_internal p WHERE p.subject=p_subject AND p.wallet_address=v_address ORDER BY p.created_at DESC,p.id DESC LIMIT 20;
END $function$;
CREATE FUNCTION payments.prepare_personal_polygon_relay(p_subject text,p_address text,p_amount text,p_id uuid,p_token_nonce text,
 p_digest text,p_relayer text,p_entry_point text,p_domain text,p_implementation text,p_max_fee text,p_owner_cap text,p_global_cap text)
RETURNS SETOF payments.personal_polygon_relay_internal LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v payments.personal_polygon_relay%ROWTYPE;v_now timestamptz;v_expiry timestamptz;
BEGIN
 PERFORM payments.assert_personal_company_payment_owner(p_subject,p_address);
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' OR p_id IS NULL
  OR p_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR p_amount IS NULL OR p_amount !~ '^[1-9][0-9]{0,77}$' OR p_token_nonce IS NULL OR p_token_nonce !~ '^(0|[1-9][0-9]{0,77})$'
  OR p_digest IS NULL OR p_digest !~ '^0x[0-9a-f]{64}$' OR p_domain IS NULL OR p_domain !~ '^0x[0-9a-f]{64}$'
  OR p_relayer IS NULL OR p_relayer !~ '^0x[0-9a-f]{40}$' OR p_relayer='0x0000000000000000000000000000000000000000'
  OR p_entry_point IS DISTINCT FROM '0x0000000071727de22e5e9d8baf0edac6f37da032'
  OR p_implementation IS DISTINCT FROM '0x90040487a6c9f949c4f07cadcfb0f3b8eeab4229'
  OR p_max_fee IS NULL OR p_max_fee !~ '^[1-9][0-9]{0,18}$' OR p_owner_cap IS NULL OR p_owner_cap !~ '^[1-9][0-9]{0,18}$'
  OR p_global_cap IS NULL OR p_global_cap !~ '^[1-9][0-9]{0,19}$' THEN
  RAISE EXCEPTION 'polygon_relay_invalid_request' USING ERRCODE='22023'; END IF;
 IF p_amount::numeric>115792089237316195423570985008687907853269984665640564039457584007913129639935
  OR p_token_nonce::numeric>115792089237316195423570985008687907853269984665640564039457584007913129639935
  OR p_max_fee::numeric>1000000000000000000 OR p_owner_cap::numeric>2000000000000000000 OR p_global_cap::numeric>10000000000000000000
  OR p_max_fee::numeric>p_owner_cap::numeric OR p_owner_cap::numeric>p_global_cap::numeric THEN
  RAISE EXCEPTION 'polygon_relay_invalid_request' USING ERRCODE='22023'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('polygon-relay-budget:137:POL_WEI',0));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personal-company-payment:'||p_subject,0));
 SELECT p.* INTO v FROM payments.personal_polygon_relay p WHERE p.id=p_id;
 IF FOUND THEN
  IF ROW(v.subject,v.wallet_address,v.amount_atomic,v.authorization_nonce,v.authorization_digest,v.relayer_address,v.entry_point,v.domain_separator,v.implementation_address,v.max_fee_wei,v.owner_daily_cap_wei,v.global_daily_cap_wei)
   IS DISTINCT FROM ROW(p_subject,p_address,p_amount,p_token_nonce,p_digest,p_relayer,p_entry_point,p_domain,p_implementation,p_max_fee,p_owner_cap,p_global_cap) THEN
   RAISE EXCEPTION 'polygon_relay_request_already_used' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT * FROM payments.read_personal_polygon_relay(p_subject,p_id);RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM payments.personal_transfer_request r WHERE r.id=p_id) THEN
  RAISE EXCEPTION 'polygon_relay_request_already_used' USING ERRCODE='22023'; END IF;
 IF payments.polygon_relay_budget_total(p_subject)+p_max_fee::numeric>p_owner_cap::numeric
  OR payments.polygon_relay_budget_total(NULL)+p_max_fee::numeric>p_global_cap::numeric THEN
  RAISE EXCEPTION 'polygon_relay_budget_exceeded' USING ERRCODE='54000'; END IF;
 v_now:=clock_timestamp();v_expiry:=LEAST(v_now+interval '5 minutes',((v_now AT TIME ZONE 'UTC')::date+1)::timestamp AT TIME ZONE 'UTC');
 INSERT INTO payments.personal_polygon_relay(id,subject,wallet_address,amount_atomic,authorization_nonce,authorization_digest,relayer_address,
  entry_point,domain_separator,implementation_address,max_fee_wei,owner_daily_cap_wei,global_daily_cap_wei,created_at,expires_at)
 VALUES(p_id,p_subject,p_address,p_amount,p_token_nonce,p_digest,p_relayer,p_entry_point,p_domain,p_implementation,p_max_fee,p_owner_cap,p_global_cap,v_now,v_expiry);
 INSERT INTO payments.personal_polygon_sponsor_reservation(payment_id,subject,max_fee_wei) VALUES(p_id,p_subject,p_max_fee);
 RETURN QUERY SELECT * FROM payments.read_personal_polygon_relay(p_subject,p_id);
END $function$;
CREATE FUNCTION payments.authorize_personal_polygon_relay(p_subject text,p_id uuid,p_digest text,p_cipher text,p_key text)
RETURNS SETOF payments.personal_polygon_relay_internal LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v payments.personal_polygon_relay%ROWTYPE;
BEGIN
 SELECT * INTO v FROM payments.polygon_relay_lock(p_subject,p_id,false);
 IF p_digest IS DISTINCT FROM v.authorization_digest THEN RAISE EXCEPTION 'polygon_relay_authorization_conflict' USING ERRCODE='22023'; END IF;
 -- Re-encryption uses a fresh IV. A replay of the same accepted intent returns
 -- its original ciphertext; it never replaces an accepted authorization.
 IF v.authorized_at IS NOT NULL THEN RETURN QUERY SELECT * FROM payments.read_personal_polygon_relay(p_subject,p_id);RETURN; END IF;
 IF v.status<>'prepared' OR v.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'polygon_relay_expired' USING ERRCODE='22023'; END IF;
 IF p_cipher IS NULL OR length(p_cipher) NOT BETWEEN 64 AND 16384
  OR p_cipher !~ '^[a-z0-9_-]{1,16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$'
  OR p_key IS NULL OR p_key !~ '^[a-z0-9_-]{1,16}$' OR split_part(p_cipher,'.',1)<>p_key THEN
  RAISE EXCEPTION 'polygon_relay_invalid_request' USING ERRCODE='22023'; END IF;
 BEGIN
  INSERT INTO payments.personal_polygon_native_authorization(chain_id,token_address,wallet_address,authorization_nonce,payment_id,subject,authorization_digest)
   VALUES(137,v.token_address,v.wallet_address,v.authorization_nonce,v.id,v.subject,v.authorization_digest);
 EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'polygon_relay_nonce_reserved' USING ERRCODE='22023'; END;
 UPDATE payments.personal_polygon_relay SET status='authorized',authorized_at=clock_timestamp(),authorization_ciphertext=p_cipher,authorization_key_id=p_key WHERE id=p_id;
 RETURN QUERY SELECT * FROM payments.read_personal_polygon_relay(p_subject,p_id);
END $function$;

CREATE FUNCTION payments.begin_personal_polygon_relay(p_subject text,p_id uuid,p_attempt uuid,p_nonce text)
RETURNS SETOF payments.personal_polygon_relay_dispatch LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v payments.personal_polygon_relay%ROWTYPE;a payments.personal_polygon_relay_attempt%ROWTYPE;
 lane payments.personal_polygon_relay_account%ROWTYPE;v_reservation uuid;v_now timestamptz;v_lease uuid;
BEGIN
 SELECT * INTO v FROM payments.polygon_relay_lock(p_subject,p_id,true);
 IF p_attempt IS NULL OR p_attempt::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR p_nonce IS NULL OR p_nonce !~ '^(0|[1-9][0-9]{0,77})$' THEN RAISE EXCEPTION 'polygon_relay_invalid_request' USING ERRCODE='22023'; END IF;
 IF p_nonce::numeric>115792089237316195423570985008687907853269984665640564039457584007913129639935 THEN
  RAISE EXCEPTION 'polygon_relay_invalid_request' USING ERRCODE='22023'; END IF;
 SELECT * INTO lane FROM payments.personal_polygon_relay_account q WHERE q.chain_id=137 AND q.entry_point=v.entry_point AND q.relayer_address=v.relayer_address;
 SELECT * INTO a FROM payments.personal_polygon_relay_attempt q WHERE q.id=p_attempt FOR UPDATE;
 IF FOUND THEN
  IF ROW(a.subject,a.payment_id,a.entry_point_nonce,a.entry_point,a.relayer_address)
   IS DISTINCT FROM ROW(p_subject,p_id,p_nonce,v.entry_point,v.relayer_address) THEN
   RAISE EXCEPTION 'polygon_relay_attempt_conflict' USING ERRCODE='22023'; END IF;
  IF v.attempt_id=p_attempt AND v.status='broadcasting' AND a.state='building'
   AND a.lease_expires_at<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM payments.personal_polygon_relay_operation o WHERE o.attempt_id=p_attempt) THEN
   IF lane.active_attempt_id IS DISTINCT FROM p_attempt THEN RAISE EXCEPTION 'polygon_relay_queue_conflict' USING ERRCODE='22023'; END IF;
   v_lease:=gen_random_uuid();
   UPDATE payments.personal_polygon_relay_attempt SET lease_token=v_lease,lease_expires_at=clock_timestamp()+interval '90 seconds',updated_at=clock_timestamp() WHERE id=p_attempt;
   PERFORM payments.polygon_relay_append_event(p_subject,p_id,'lease_reclaimed',p_attempt);
   RETURN QUERY SELECT * FROM payments.polygon_relay_dispatch_result(p_id,true,false);RETURN;
  END IF;
  RETURN QUERY SELECT * FROM payments.polygon_relay_dispatch_result(p_id,false,false);RETURN;
 END IF;
 IF v.status<>'authorized' THEN RAISE EXCEPTION 'polygon_relay_invalid_transition' USING ERRCODE='22023'; END IF;
 IF lane.active_attempt_id IS NOT NULL THEN RAISE EXCEPTION 'polygon_relay_queue_busy' USING ERRCODE='22023'; END IF;
 v_now:=clock_timestamp();
 IF (SELECT count(*) FROM payments.personal_polygon_relay_attempt q WHERE q.subject=p_subject AND q.created_at>v_now-interval '10 minutes')>=5 THEN
  RAISE EXCEPTION 'polygon_relay_rate_limited' USING ERRCODE='54000'; END IF;
 SELECT r.id INTO v_reservation FROM payments.personal_polygon_sponsor_reservation r
  WHERE r.payment_id=p_id AND r.state='held' AND r.attempt_id IS NULL FOR UPDATE;
 IF v_reservation IS NULL THEN
  IF payments.polygon_relay_budget_total(p_subject)+v.max_fee_wei::numeric>v.owner_daily_cap_wei::numeric
   OR payments.polygon_relay_budget_total(NULL)+v.max_fee_wei::numeric>v.global_daily_cap_wei::numeric THEN
   RAISE EXCEPTION 'polygon_relay_budget_exceeded' USING ERRCODE='54000'; END IF;
 ELSIF payments.polygon_relay_budget_total(p_subject)>v.owner_daily_cap_wei::numeric
  OR payments.polygon_relay_budget_total(NULL)>v.global_daily_cap_wei::numeric THEN
  RAISE EXCEPTION 'polygon_relay_budget_exceeded' USING ERRCODE='54000'; END IF;
 v_lease:=gen_random_uuid();
 BEGIN
  INSERT INTO payments.personal_polygon_relay_attempt(id,payment_id,subject,chain_id,entry_point,relayer_address,entry_point_nonce,lease_token,lease_expires_at,created_at,updated_at)
   VALUES(p_attempt,p_id,p_subject,137,v.entry_point,v.relayer_address,p_nonce,v_lease,v_now+interval '90 seconds',v_now,v_now);
 EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'polygon_relay_nonce_reserved' USING ERRCODE='22023'; END;
 IF v_reservation IS NULL THEN
  INSERT INTO payments.personal_polygon_sponsor_reservation(payment_id,subject,attempt_id,max_fee_wei) VALUES(p_id,p_subject,p_attempt,v.max_fee_wei);
 ELSE UPDATE payments.personal_polygon_sponsor_reservation SET attempt_id=p_attempt WHERE id=v_reservation; END IF;
 UPDATE payments.personal_polygon_relay_account SET active_attempt_id=p_attempt,updated_at=v_now
  WHERE chain_id=137 AND entry_point=v.entry_point AND relayer_address=v.relayer_address;
 UPDATE payments.personal_polygon_relay SET status='broadcasting',attempt_id=p_attempt WHERE id=p_id;
 RETURN QUERY SELECT * FROM payments.polygon_relay_dispatch_result(p_id,true,false);
END $function$;
CREATE FUNCTION payments.persist_personal_polygon_relay_operation(p_subject text,p_id uuid,p_attempt uuid,p_lease uuid,p_hash text,
 p_cipher text,p_key text,p_after bigint,p_until bigint,p_quote text)
RETURNS SETOF payments.personal_polygon_relay_dispatch LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v payments.personal_polygon_relay%ROWTYPE;a payments.personal_polygon_relay_attempt%ROWTYPE;o payments.personal_polygon_relay_operation%ROWTYPE;
BEGIN
 SELECT * INTO v FROM payments.polygon_relay_lock(p_subject,p_id,true);
 SELECT q.* INTO a FROM payments.personal_polygon_relay_attempt q WHERE q.id=p_attempt AND q.payment_id=p_id AND q.subject=p_subject FOR UPDATE;
 IF NOT FOUND OR v.attempt_id IS DISTINCT FROM p_attempt THEN RAISE EXCEPTION 'polygon_relay_attempt_conflict' USING ERRCODE='22023'; END IF;
 SELECT q.* INTO o FROM payments.personal_polygon_relay_operation q WHERE q.attempt_id=p_attempt;
 IF FOUND THEN
  IF ROW(o.user_operation_hash,o.operation_valid_after,o.operation_valid_until,o.quoted_max_fee_wei)
    IS DISTINCT FROM ROW(p_hash,p_after,p_until,p_quote) THEN RAISE EXCEPTION 'polygon_relay_operation_conflict' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT * FROM payments.polygon_relay_dispatch_result(p_id,false,false);RETURN;
 END IF;
 IF v.status<>'broadcasting' OR a.state<>'building' OR a.lease_token IS DISTINCT FROM p_lease OR a.lease_expires_at<=clock_timestamp() THEN
  RAISE EXCEPTION 'polygon_relay_lease_lost' USING ERRCODE='22023'; END IF;
 IF p_hash IS NULL OR p_hash !~ '^0x[0-9a-f]{64}$' OR p_cipher IS NULL OR length(p_cipher) NOT BETWEEN 64 AND 45000
  OR p_cipher !~ '^[a-z0-9_-]{1,16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$'
  OR p_key IS NULL OR p_key !~ '^[a-z0-9_-]{1,16}$' OR split_part(p_cipher,'.',1)<>p_key
  OR p_quote IS NULL OR p_quote !~ '^[1-9][0-9]{0,18}$' OR p_after IS NULL OR p_until IS NULL THEN
  RAISE EXCEPTION 'polygon_relay_invalid_request' USING ERRCODE='22023'; END IF;
 IF p_quote::numeric>v.max_fee_wei::numeric OR p_after<0 OR p_after>=281474976710656 OR p_until>=281474976710656 OR p_until<=p_after
  OR p_until<=extract(epoch FROM clock_timestamp()) OR p_until>extract(epoch FROM clock_timestamp())+600
  OR p_after>extract(epoch FROM clock_timestamp())+30 THEN RAISE EXCEPTION 'polygon_relay_invalid_validity' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM payments.personal_polygon_relay_account q WHERE q.chain_id=137 AND q.entry_point=v.entry_point
  AND q.relayer_address=v.relayer_address AND q.active_attempt_id=p_attempt) THEN RAISE EXCEPTION 'polygon_relay_queue_conflict' USING ERRCODE='22023'; END IF;
 BEGIN
  INSERT INTO payments.personal_polygon_relay_operation(attempt_id,payment_id,user_operation_hash,operation_ciphertext,operation_key_id,quoted_max_fee_wei,operation_valid_after,operation_valid_until)
   VALUES(p_attempt,p_id,p_hash,p_cipher,p_key,p_quote,p_after,p_until);
 EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'polygon_relay_operation_conflict' USING ERRCODE='22023'; END;
 UPDATE payments.personal_polygon_relay_attempt SET state='persisted',updated_at=clock_timestamp() WHERE id=p_attempt;
 UPDATE payments.personal_polygon_relay SET user_operation_hash=p_hash WHERE id=p_id;
 RETURN QUERY SELECT * FROM payments.polygon_relay_dispatch_result(p_id,false,true);
END $function$;
CREATE FUNCTION payments.release_personal_polygon_relay_attempt(p_subject text,p_id uuid,p_attempt uuid,p_lease uuid,p_reason text)
RETURNS SETOF payments.personal_polygon_relay_internal LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v payments.personal_polygon_relay%ROWTYPE;a payments.personal_polygon_relay_attempt%ROWTYPE;
BEGIN
 SELECT * INTO v FROM payments.polygon_relay_lock(p_subject,p_id,true);
 SELECT q.* INTO a FROM payments.personal_polygon_relay_attempt q WHERE q.id=p_attempt AND q.payment_id=p_id AND q.subject=p_subject FOR UPDATE;
 IF NOT FOUND OR a.lease_token IS DISTINCT FROM p_lease THEN RAISE EXCEPTION 'polygon_relay_lease_lost' USING ERRCODE='22023'; END IF;
 IF p_reason IS NULL OR p_reason NOT IN('sponsorship_rejected','quote_unavailable','signing_failed','preparation_timeout') THEN
  RAISE EXCEPTION 'polygon_relay_invalid_request' USING ERRCODE='22023'; END IF;
 IF a.state='released' THEN RETURN QUERY SELECT * FROM payments.read_personal_polygon_relay(p_subject,p_id);RETURN; END IF;
 IF v.attempt_id IS DISTINCT FROM p_attempt OR v.status<>'broadcasting' OR a.state<>'building'
  OR EXISTS(SELECT 1 FROM payments.personal_polygon_relay_operation q WHERE q.attempt_id=p_attempt) THEN
  RAISE EXCEPTION 'polygon_relay_operation_locked' USING ERRCODE='22023'; END IF;
 IF p_reason='preparation_timeout' AND a.lease_expires_at>clock_timestamp() THEN RAISE EXCEPTION 'polygon_relay_lease_active' USING ERRCODE='22023'; END IF;
 UPDATE payments.personal_polygon_relay_attempt SET state='released',updated_at=clock_timestamp() WHERE id=p_attempt;
 UPDATE payments.personal_polygon_sponsor_reservation SET state='released',closed_at=clock_timestamp() WHERE attempt_id=p_attempt AND state='held';
 UPDATE payments.personal_polygon_relay_account SET active_attempt_id=NULL,updated_at=clock_timestamp()
  WHERE chain_id=137 AND entry_point=v.entry_point AND relayer_address=v.relayer_address AND active_attempt_id=p_attempt;
 UPDATE payments.personal_polygon_relay SET status='authorized',attempt_id=NULL,user_operation_hash=NULL,transaction_hash=NULL,submitted_at=NULL WHERE id=p_id;
 RETURN QUERY SELECT * FROM payments.read_personal_polygon_relay(p_subject,p_id);
END $function$;
CREATE FUNCTION payments.mark_personal_polygon_relay_submitted(p_subject text,p_id uuid,p_attempt uuid,p_hash text,p_transaction text)
RETURNS SETOF payments.personal_polygon_relay_internal LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v payments.personal_polygon_relay%ROWTYPE;
BEGIN
 SELECT * INTO v FROM payments.polygon_relay_lock(p_subject,p_id,true);
 IF v.attempt_id IS DISTINCT FROM p_attempt OR v.user_operation_hash IS DISTINCT FROM p_hash
  OR (p_transaction IS NOT NULL AND p_transaction !~ '^0x[0-9a-f]{64}$') THEN
  RAISE EXCEPTION 'polygon_relay_operation_conflict' USING ERRCODE='22023'; END IF;
 IF v.status IN('confirmed','failed','reconciliation_required') THEN
  IF p_transaction IS NOT NULL AND v.transaction_hash IS DISTINCT FROM p_transaction THEN RAISE EXCEPTION 'polygon_relay_receipt_conflict' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT * FROM payments.read_personal_polygon_relay(p_subject,p_id);RETURN;
 END IF;
 IF v.status NOT IN('broadcasting','ambiguous','submitted') OR NOT EXISTS(SELECT 1 FROM payments.personal_polygon_relay_operation o
  WHERE o.attempt_id=p_attempt AND o.user_operation_hash=p_hash AND o.payment_id=p_id) THEN
  RAISE EXCEPTION 'polygon_relay_operation_required' USING ERRCODE='22023'; END IF;
 UPDATE payments.personal_polygon_relay_attempt SET state='submitted',updated_at=clock_timestamp() WHERE id=p_attempt;
 UPDATE payments.personal_polygon_relay SET status='submitted',submitted_at=coalesce(submitted_at,clock_timestamp()),
  transaction_hash=coalesce(p_transaction,transaction_hash) WHERE id=p_id;
 RETURN QUERY SELECT * FROM payments.read_personal_polygon_relay(p_subject,p_id);
END $function$;
CREATE FUNCTION payments.mark_personal_polygon_relay_ambiguous(p_subject text,p_id uuid,p_attempt uuid)
RETURNS SETOF payments.personal_polygon_relay_internal LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v payments.personal_polygon_relay%ROWTYPE;
BEGIN
 SELECT * INTO v FROM payments.polygon_relay_lock(p_subject,p_id,true);
 IF v.attempt_id IS DISTINCT FROM p_attempt THEN RAISE EXCEPTION 'polygon_relay_attempt_conflict' USING ERRCODE='22023'; END IF;
 IF v.status IN('submitted','confirmed','failed','reconciliation_required','ambiguous') THEN
  RETURN QUERY SELECT * FROM payments.read_personal_polygon_relay(p_subject,p_id);RETURN; END IF;
 IF v.status<>'broadcasting' OR NOT EXISTS(SELECT 1 FROM payments.personal_polygon_relay_operation o WHERE o.attempt_id=p_attempt AND o.payment_id=p_id) THEN
  RAISE EXCEPTION 'polygon_relay_operation_required' USING ERRCODE='22023'; END IF;
 UPDATE payments.personal_polygon_relay_attempt SET state='ambiguous',updated_at=clock_timestamp() WHERE id=p_attempt;
 UPDATE payments.personal_polygon_relay SET status='ambiguous' WHERE id=p_id;
 RETURN QUERY SELECT * FROM payments.read_personal_polygon_relay(p_subject,p_id);
END $function$;
CREATE FUNCTION payments.expire_personal_polygon_relay(p_subject text,p_id uuid)
RETURNS SETOF payments.personal_polygon_relay_internal LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v payments.personal_polygon_relay%ROWTYPE;
BEGIN
 SELECT * INTO v FROM payments.polygon_relay_lock(p_subject,p_id,false);
 IF v.status='expired' THEN RETURN QUERY SELECT * FROM payments.read_personal_polygon_relay(p_subject,p_id);RETURN; END IF;
 IF v.status<>'prepared' OR v.authorized_at IS NOT NULL OR v.expires_at>clock_timestamp() THEN
  RAISE EXCEPTION 'polygon_relay_operation_locked' USING ERRCODE='22023'; END IF;
 UPDATE payments.personal_polygon_sponsor_reservation SET state='released',closed_at=clock_timestamp() WHERE payment_id=p_id AND state='held' AND attempt_id IS NULL;
 UPDATE payments.personal_polygon_relay SET status='expired',failure_reason='preparation_expired' WHERE id=p_id;
 RETURN QUERY SELECT * FROM payments.read_personal_polygon_relay(p_subject,p_id);
END $function$;

CREATE FUNCTION payments.abandon_personal_polygon_relay(p_subject text,p_id uuid)
RETURNS SETOF payments.personal_polygon_relay_internal LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v payments.personal_polygon_relay%ROWTYPE;
BEGIN
 SELECT * INTO v FROM payments.polygon_relay_lock(p_subject,p_id,false);
 IF v.status='expired' AND v.authorized_at IS NULL THEN RETURN QUERY SELECT * FROM payments.read_personal_polygon_relay(p_subject,p_id);RETURN; END IF;
 IF v.status<>'prepared' OR v.authorized_at IS NOT NULL OR v.authorization_ciphertext IS NOT NULL OR v.attempt_id IS NOT NULL
  OR v.user_operation_hash IS NOT NULL OR EXISTS(SELECT 1 FROM payments.personal_polygon_native_authorization a WHERE a.payment_id=p_id)
  OR EXISTS(SELECT 1 FROM payments.personal_polygon_relay_attempt a WHERE a.payment_id=p_id)
  OR EXISTS(SELECT 1 FROM payments.personal_polygon_relay_operation o WHERE o.payment_id=p_id) THEN
  RAISE EXCEPTION 'polygon_relay_operation_locked' USING ERRCODE='22023'; END IF;
 UPDATE payments.personal_polygon_sponsor_reservation SET state='released',closed_at=clock_timestamp() WHERE payment_id=p_id AND state='held' AND attempt_id IS NULL;
 UPDATE payments.personal_polygon_relay SET status='expired',failure_reason='preparation_abandoned' WHERE id=p_id;
 RETURN QUERY SELECT * FROM payments.read_personal_polygon_relay(p_subject,p_id);
END $function$;

CREATE FUNCTION payments.polygon_relay_uint256(p_value text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $function$
 SELECT CASE WHEN p_value IS NOT NULL AND p_value ~ '^(0|[1-9][0-9]{0,77})$'
  THEN p_value::numeric<=115792089237316195423570985008687907853269984665640564039457584007913129639935 ELSE false END;
$function$;
CREATE FUNCTION payments.polygon_relay_receipt_input(p_hash text,p_tx text,p_block text,p_block_hash text,p_confirmations integer,p_cost text)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
 IF p_hash IS NULL OR p_hash !~ '^0x[0-9a-f]{64}$' OR p_tx IS NULL OR p_tx !~ '^0x[0-9a-f]{64}$'
  OR p_block IS NULL OR p_block !~ '^[1-9][0-9]{0,19}$' OR p_block_hash IS NULL OR p_block_hash !~ '^0x[0-9a-f]{64}$'
  OR p_confirmations IS NULL OR p_confirmations<12 OR p_cost IS NULL OR p_cost !~ '^(0|[1-9][0-9]{0,18})$' THEN
  RAISE EXCEPTION 'polygon_relay_invalid_proof' USING ERRCODE='22023'; END IF;
 IF p_block::numeric>18446744073709551615 OR p_cost::numeric>1000000000000000000 THEN
  RAISE EXCEPTION 'polygon_relay_invalid_proof' USING ERRCODE='22023'; END IF;
END $function$;
CREATE FUNCTION payments.polygon_relay_close_dispatch(p_id uuid,p_attempt uuid,p_state text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v payments.personal_polygon_relay%ROWTYPE;
BEGIN
 SELECT * INTO v FROM payments.personal_polygon_relay WHERE id=p_id;
 IF p_state NOT IN('confirmed','failed','expired') OR v.attempt_id IS DISTINCT FROM p_attempt THEN
  RAISE EXCEPTION 'polygon_relay_attempt_conflict' USING ERRCODE='22023'; END IF;
 UPDATE payments.personal_polygon_relay_attempt SET state=p_state,updated_at=clock_timestamp() WHERE id=p_attempt AND payment_id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'polygon_relay_attempt_conflict' USING ERRCODE='22023'; END IF;
 UPDATE payments.personal_polygon_sponsor_reservation SET state='spent',closed_at=clock_timestamp() WHERE attempt_id=p_attempt AND state='held';
 IF NOT FOUND THEN RAISE EXCEPTION 'polygon_relay_budget_missing' USING ERRCODE='22023'; END IF;
 UPDATE payments.personal_polygon_relay_account SET active_attempt_id=NULL,updated_at=clock_timestamp()
  WHERE chain_id=137 AND entry_point=v.entry_point AND relayer_address=v.relayer_address AND active_attempt_id=p_attempt;
 IF NOT FOUND THEN RAISE EXCEPTION 'polygon_relay_queue_conflict' USING ERRCODE='22023'; END IF;
END $function$;
CREATE FUNCTION payments.confirm_personal_polygon_relay(p_subject text,p_id uuid,p_attempt uuid,p_hash text,p_tx text,
 p_block text,p_block_hash text,p_confirmations integer,p_cost text)
RETURNS SETOF payments.personal_polygon_relay_internal LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v payments.personal_polygon_relay%ROWTYPE;o payments.personal_polygon_relay_outcome%ROWTYPE;q payments.personal_polygon_relay_operation%ROWTYPE;
BEGIN
 PERFORM payments.polygon_relay_receipt_input(p_hash,p_tx,p_block,p_block_hash,p_confirmations,p_cost);
 SELECT * INTO v FROM payments.polygon_relay_lock(p_subject,p_id,true);
 SELECT * INTO o FROM payments.personal_polygon_relay_outcome WHERE attempt_id=p_attempt;
 IF FOUND THEN
  IF ROW(o.payment_id,o.result,o.user_operation_hash,o.transaction_hash,o.block_number,o.block_hash,o.actual_gas_cost_wei)
   IS DISTINCT FROM ROW(p_id,'confirmed'::text,p_hash,p_tx,p_block,p_block_hash,p_cost) THEN
   RAISE EXCEPTION 'polygon_relay_receipt_conflict' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT * FROM payments.read_personal_polygon_relay(p_subject,p_id);RETURN;
 END IF;
 SELECT * INTO q FROM payments.personal_polygon_relay_operation WHERE attempt_id=p_attempt AND payment_id=p_id AND user_operation_hash=p_hash;
 IF NOT FOUND OR v.attempt_id IS DISTINCT FROM p_attempt OR v.user_operation_hash IS DISTINCT FROM p_hash
  OR v.status NOT IN('broadcasting','ambiguous','submitted') OR p_cost::numeric>q.quoted_max_fee_wei::numeric THEN
  RAISE EXCEPTION 'polygon_relay_receipt_conflict' USING ERRCODE='22023'; END IF;
 INSERT INTO payments.personal_polygon_relay_outcome(attempt_id,payment_id,result,user_operation_hash,transaction_hash,block_number,block_hash,confirmations,actual_gas_cost_wei)
  VALUES(p_attempt,p_id,'confirmed',p_hash,p_tx,p_block,p_block_hash,p_confirmations,p_cost);
 PERFORM payments.polygon_relay_close_dispatch(p_id,p_attempt,'confirmed');
 UPDATE payments.personal_polygon_relay SET status='confirmed',transaction_hash=p_tx,block_number=p_block,block_hash=p_block_hash,
  confirmations=p_confirmations,submitted_at=coalesce(submitted_at,clock_timestamp()),confirmed_at=clock_timestamp(),actual_gas_cost_wei=p_cost WHERE id=p_id;
 RETURN QUERY SELECT * FROM payments.read_personal_polygon_relay(p_subject,p_id);
END $function$;
CREATE FUNCTION payments.reject_personal_polygon_relay(p_subject text,p_id uuid,p_attempt uuid,p_hash text,p_tx text,
 p_block text,p_block_hash text,p_confirmations integer,p_cost text,p_reason text,p_native_nonce text)
RETURNS SETOF payments.personal_polygon_relay_internal LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v payments.personal_polygon_relay%ROWTYPE;o payments.personal_polygon_relay_outcome%ROWTYPE;q payments.personal_polygon_relay_operation%ROWTYPE;
BEGIN
 PERFORM payments.polygon_relay_receipt_input(p_hash,p_tx,p_block,p_block_hash,p_confirmations,p_cost);
 IF p_reason IS DISTINCT FROM 'user_operation_reverted'
  OR NOT payments.polygon_relay_uint256(p_native_nonce) THEN RAISE EXCEPTION 'polygon_relay_invalid_proof' USING ERRCODE='22023'; END IF;
 SELECT * INTO v FROM payments.polygon_relay_lock(p_subject,p_id,true);
 SELECT * INTO o FROM payments.personal_polygon_relay_outcome WHERE attempt_id=p_attempt;
 IF FOUND THEN
  IF ROW(o.payment_id,o.result,o.user_operation_hash,o.transaction_hash,o.block_number,o.block_hash,o.actual_gas_cost_wei,o.reason,o.observed_native_nonce)
   IS DISTINCT FROM ROW(p_id,'failed'::text,p_hash,p_tx,p_block,p_block_hash,p_cost,p_reason,p_native_nonce) THEN
   RAISE EXCEPTION 'polygon_relay_receipt_conflict' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT * FROM payments.read_personal_polygon_relay(p_subject,p_id);RETURN;
 END IF;
 SELECT * INTO q FROM payments.personal_polygon_relay_operation WHERE attempt_id=p_attempt AND payment_id=p_id AND user_operation_hash=p_hash;
 IF NOT FOUND OR v.attempt_id IS DISTINCT FROM p_attempt OR v.user_operation_hash IS DISTINCT FROM p_hash
  OR v.status NOT IN('broadcasting','ambiguous','submitted') OR p_cost::numeric>q.quoted_max_fee_wei::numeric THEN RAISE EXCEPTION 'polygon_relay_receipt_conflict' USING ERRCODE='22023'; END IF;
 INSERT INTO payments.personal_polygon_relay_outcome(attempt_id,payment_id,result,user_operation_hash,transaction_hash,block_number,block_hash,
  confirmations,actual_gas_cost_wei,reason,observed_native_nonce)
  VALUES(p_attempt,p_id,'failed',p_hash,p_tx,p_block,p_block_hash,p_confirmations,p_cost,p_reason,p_native_nonce);
 PERFORM payments.polygon_relay_close_dispatch(p_id,p_attempt,'failed');
 IF p_native_nonce=v.authorization_nonce THEN
  UPDATE payments.personal_polygon_relay SET status='authorized',attempt_id=NULL,user_operation_hash=NULL,transaction_hash=NULL,submitted_at=NULL WHERE id=p_id;
 ELSE
  UPDATE payments.personal_polygon_relay SET status='reconciliation_required',transaction_hash=p_tx,block_number=p_block,block_hash=p_block_hash,
   confirmations=p_confirmations,submitted_at=coalesce(submitted_at,clock_timestamp()),actual_gas_cost_wei=p_cost,
   observed_native_nonce=p_native_nonce,authorization_invalidated_at=clock_timestamp(),failure_reason='authorization_nonce_changed' WHERE id=p_id;
 END IF;
 RETURN QUERY SELECT * FROM payments.read_personal_polygon_relay(p_subject,p_id);
END $function$;

CREATE FUNCTION payments.expire_personal_polygon_relay_operation(p_subject text,p_id uuid,p_attempt uuid,p_hash text,p_block text,
 p_block_hash text,p_timestamp bigint,p_aa_nonce text,p_confirmations integer,p_native_nonce text)
RETURNS SETOF payments.personal_polygon_relay_internal LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v payments.personal_polygon_relay%ROWTYPE;a payments.personal_polygon_relay_attempt%ROWTYPE;
 o payments.personal_polygon_relay_operation%ROWTYPE;e payments.personal_polygon_operation_expiry%ROWTYPE;
BEGIN
 IF p_hash IS NULL OR p_hash !~ '^0x[0-9a-f]{64}$' OR p_block IS NULL OR p_block !~ '^[1-9][0-9]{0,19}$'
  OR p_block_hash IS NULL OR p_block_hash !~ '^0x[0-9a-f]{64}$' OR p_timestamp IS NULL OR p_timestamp<=0
  OR p_confirmations IS NULL OR p_confirmations<12 OR NOT payments.polygon_relay_uint256(p_aa_nonce)
  OR NOT payments.polygon_relay_uint256(p_native_nonce) THEN RAISE EXCEPTION 'polygon_relay_invalid_proof' USING ERRCODE='22023'; END IF;
 SELECT * INTO v FROM payments.polygon_relay_lock(p_subject,p_id,true);
 SELECT * INTO e FROM payments.personal_polygon_operation_expiry WHERE attempt_id=p_attempt AND payment_id=p_id;
 IF FOUND THEN
  IF ROW(e.user_operation_hash,e.block_number,e.block_hash,e.canonical_timestamp,e.observed_aa_nonce,e.observed_native_nonce)
   IS DISTINCT FROM ROW(p_hash,p_block,p_block_hash,p_timestamp,p_aa_nonce,p_native_nonce) THEN
   RAISE EXCEPTION 'polygon_relay_receipt_conflict' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT * FROM payments.read_personal_polygon_relay(p_subject,p_id);RETURN;
 END IF;
 SELECT * INTO a FROM payments.personal_polygon_relay_attempt WHERE id=p_attempt AND payment_id=p_id AND subject=p_subject FOR UPDATE;
 IF NOT FOUND OR v.attempt_id IS DISTINCT FROM p_attempt OR v.user_operation_hash IS DISTINCT FROM p_hash
  OR v.status NOT IN('broadcasting','ambiguous','submitted') OR a.entry_point_nonce<>p_aa_nonce THEN
  RAISE EXCEPTION 'polygon_relay_receipt_conflict' USING ERRCODE='22023'; END IF;
 SELECT * INTO o FROM payments.personal_polygon_relay_operation WHERE attempt_id=p_attempt AND payment_id=p_id AND user_operation_hash=p_hash;
 IF NOT FOUND OR p_timestamp<=o.operation_valid_until OR p_timestamp>extract(epoch FROM clock_timestamp())
  OR p_block::numeric>18446744073709551615 THEN
  RAISE EXCEPTION 'polygon_relay_expiry_proof_required' USING ERRCODE='22023'; END IF;
 INSERT INTO payments.personal_polygon_operation_expiry(attempt_id,payment_id,user_operation_hash,block_number,block_hash,
  canonical_timestamp,observed_aa_nonce,confirmations,observed_native_nonce)
  VALUES(p_attempt,p_id,p_hash,p_block,p_block_hash,p_timestamp,p_aa_nonce,p_confirmations,p_native_nonce);
 PERFORM payments.polygon_relay_close_dispatch(p_id,p_attempt,'expired');
 IF p_native_nonce=v.authorization_nonce THEN
  UPDATE payments.personal_polygon_relay SET status='authorized',attempt_id=NULL,user_operation_hash=NULL,transaction_hash=NULL,submitted_at=NULL WHERE id=p_id;
 ELSE
  UPDATE payments.personal_polygon_relay SET status='reconciliation_required',block_number=p_block,block_hash=p_block_hash,
   confirmations=p_confirmations,actual_gas_cost_wei='0',observed_native_nonce=p_native_nonce,
   authorization_invalidated_at=clock_timestamp(),failure_reason='authorization_nonce_changed' WHERE id=p_id;
 END IF;
 RETURN QUERY SELECT * FROM payments.read_personal_polygon_relay(p_subject,p_id);
END $function$;
CREATE FUNCTION payments.retire_native_polygon_relay_authorization(p_subject text,p_id uuid,p_native_nonce text,p_block text,p_block_hash text,p_confirmations integer)
RETURNS SETOF payments.personal_polygon_relay_internal LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v payments.personal_polygon_relay%ROWTYPE;r payments.personal_polygon_authorization_retirement%ROWTYPE;
BEGIN
 IF NOT payments.polygon_relay_uint256(p_native_nonce) OR p_block IS NULL OR p_block !~ '^[1-9][0-9]{0,19}$'
  OR p_block_hash IS NULL OR p_block_hash !~ '^0x[0-9a-f]{64}$' OR p_confirmations IS NULL OR p_confirmations<12 THEN
  RAISE EXCEPTION 'polygon_relay_invalid_proof' USING ERRCODE='22023'; END IF;
 SELECT * INTO v FROM payments.polygon_relay_lock(p_subject,p_id,true);
 SELECT * INTO r FROM payments.personal_polygon_authorization_retirement WHERE payment_id=p_id;
 IF FOUND THEN
  IF ROW(r.observed_native_nonce,r.block_number,r.block_hash) IS DISTINCT FROM ROW(p_native_nonce,p_block,p_block_hash) THEN
   RAISE EXCEPTION 'polygon_relay_receipt_conflict' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT * FROM payments.read_personal_polygon_relay(p_subject,p_id);RETURN;
 END IF;
 IF v.status NOT IN('authorized','broadcasting') OR v.authorized_at IS NULL OR v.user_operation_hash IS NOT NULL
  OR p_native_nonce::numeric<=v.authorization_nonce::numeric OR p_block::numeric>18446744073709551615
  OR EXISTS(SELECT 1 FROM payments.personal_polygon_relay_operation o WHERE o.attempt_id=v.attempt_id) THEN
  RAISE EXCEPTION 'polygon_relay_operation_locked' USING ERRCODE='22023'; END IF;
 INSERT INTO payments.personal_polygon_authorization_retirement(payment_id,observed_native_nonce,block_number,block_hash,confirmations)
  VALUES(p_id,p_native_nonce,p_block,p_block_hash,p_confirmations);
 IF v.attempt_id IS NOT NULL THEN
  UPDATE payments.personal_polygon_relay_attempt SET state='released',updated_at=clock_timestamp() WHERE id=v.attempt_id AND state='building';
  IF NOT FOUND THEN RAISE EXCEPTION 'polygon_relay_operation_locked' USING ERRCODE='22023'; END IF;
  UPDATE payments.personal_polygon_relay_account SET active_attempt_id=NULL,updated_at=clock_timestamp()
   WHERE chain_id=137 AND entry_point=v.entry_point AND relayer_address=v.relayer_address AND active_attempt_id=v.attempt_id;
 END IF;
 UPDATE payments.personal_polygon_sponsor_reservation SET state='released',closed_at=clock_timestamp() WHERE payment_id=p_id AND state='held';
 UPDATE payments.personal_polygon_relay SET status='reconciliation_required',attempt_id=NULL,user_operation_hash=NULL,transaction_hash=NULL,submitted_at=NULL,
  block_number=p_block,block_hash=p_block_hash,confirmations=p_confirmations,observed_native_nonce=p_native_nonce,
  authorization_invalidated_at=clock_timestamp(),failure_reason='authorization_nonce_changed' WHERE id=p_id;
 RETURN QUERY SELECT * FROM payments.read_personal_polygon_relay(p_subject,p_id);
END $function$;
CREATE FUNCTION payments.read_personal_polygon_relay_activity(p_subject text,p_payment uuid,p_cursor uuid,p_limit integer)
RETURNS SETOF payments.personal_polygon_relay_event LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_address text;v_cursor bigint;
BEGIN
 SELECT b.address INTO v_address FROM identity.wallet_binding b WHERE b.subject=p_subject;
 PERFORM payments.assert_personal_company_payment_owner(p_subject,v_address);
 IF p_limit IS NULL OR p_limit<1 OR p_limit>51 THEN RAISE EXCEPTION 'polygon_relay_invalid_request' USING ERRCODE='22023'; END IF;
 IF p_payment IS NOT NULL AND NOT EXISTS(SELECT 1 FROM payments.personal_polygon_relay p WHERE p.id=p_payment AND p.subject=p_subject AND p.wallet_address=v_address) THEN
  RAISE EXCEPTION 'polygon_relay_not_found' USING ERRCODE='P0002'; END IF;
 IF p_cursor IS NOT NULL THEN
  SELECT e.seq INTO v_cursor FROM payments.personal_polygon_relay_event e WHERE e.event_id=p_cursor AND e.subject=p_subject AND e.wallet_address=v_address
   AND (p_payment IS NULL OR e.payment_id=p_payment);
  IF NOT FOUND THEN RAISE EXCEPTION 'polygon_relay_invalid_cursor' USING ERRCODE='22023'; END IF;
 END IF;
 RETURN QUERY SELECT e.* FROM payments.personal_polygon_relay_event e WHERE e.subject=p_subject AND e.wallet_address=v_address
  AND (p_payment IS NULL OR e.payment_id=p_payment) AND (v_cursor IS NULL OR e.seq<v_cursor) ORDER BY e.seq DESC LIMIT p_limit;
END $function$;

-- Remove schema default ACLs from exactly the new objects. No previous role,
-- table grant, auth capability or direct-receipt function is broadened.
DO $private_acl$
DECLARE item record;v_name text;
 v_tables text[]:=ARRAY['personal_transfer_request','personal_polygon_relay','personal_polygon_native_authorization',
  'personal_polygon_relay_attempt','personal_polygon_relay_account','personal_polygon_relay_operation','personal_polygon_sponsor_reservation',
  'personal_polygon_operation_expiry','personal_polygon_relay_event','personal_polygon_relay_outcome','personal_polygon_authorization_retirement',
  'personal_polygon_relay_internal','personal_polygon_relay_dispatch'];
 v_functions text[]:=ARRAY['guard_polygon_relay_append_only','guard_personal_transfer_request','guard_polygon_relay_attempt',
  'guard_polygon_relay_reservation','guard_polygon_relay_account','personal_transfer_creation_guard','personal_transfer_status_mirror',
  'polygon_relay_budget_total','polygon_relay_lock','polygon_relay_dispatch_result','polygon_relay_append_event','capture_polygon_relay_event',
  'guard_personal_polygon_relay','read_personal_polygon_relay','read_personal_polygon_relay_history','prepare_personal_polygon_relay',
  'authorize_personal_polygon_relay','begin_personal_polygon_relay','persist_personal_polygon_relay_operation','release_personal_polygon_relay_attempt',
  'mark_personal_polygon_relay_submitted','mark_personal_polygon_relay_ambiguous','expire_personal_polygon_relay','abandon_personal_polygon_relay',
  'polygon_relay_uint256','polygon_relay_receipt_input','polygon_relay_close_dispatch','confirm_personal_polygon_relay','reject_personal_polygon_relay',
  'expire_personal_polygon_relay_operation','retire_native_polygon_relay_authorization','read_personal_polygon_relay_activity'];
BEGIN
 FOREACH v_name IN ARRAY v_tables LOOP EXECUTE pg_catalog.format('REVOKE ALL ON TABLE payments.%I FROM PUBLIC',v_name); END LOOP;
 EXECUTE 'REVOKE ALL ON SEQUENCE payments.personal_polygon_relay_event_seq_seq FROM PUBLIC';
 FOR item IN SELECT c.oid,c.relkind,a.grantee FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
  WHERE c.relnamespace='payments'::regnamespace AND (c.relname=ANY(v_tables) OR c.relname='personal_polygon_relay_event_seq_seq') AND a.grantee<>c.relowner LOOP
  EXECUTE pg_catalog.format('REVOKE ALL ON %s %s FROM %s',CASE WHEN item.relkind='S' THEN 'SEQUENCE' ELSE 'TABLE' END,item.oid::regclass,
   CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(item.grantee)) END);
 END LOOP;
 FOR item IN SELECT p.oid FROM pg_catalog.pg_proc p WHERE p.pronamespace='payments'::regnamespace AND p.proname=ANY(v_functions) LOOP
  EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',item.oid::regprocedure);
 END LOOP;
 FOR item IN SELECT p.oid,a.grantee FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
  WHERE p.pronamespace='payments'::regnamespace AND p.proname=ANY(v_functions) AND a.grantee<>p.proowner LOOP
  EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %s',item.oid::regprocedure,
   CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(item.grantee)) END);
 END LOOP;
END $private_acl$;
DO $runtime_capabilities$
DECLARE v_signature text;
BEGIN
 FOREACH v_signature IN ARRAY ARRAY[
  'payments.read_personal_polygon_relay(text,uuid)','payments.read_personal_polygon_relay_history(text)',
  'payments.prepare_personal_polygon_relay(text,text,text,uuid,text,text,text,text,text,text,text,text,text)',
  'payments.authorize_personal_polygon_relay(text,uuid,text,text,text)',
  'payments.begin_personal_polygon_relay(text,uuid,uuid,text)',
  'payments.persist_personal_polygon_relay_operation(text,uuid,uuid,uuid,text,text,text,bigint,bigint,text)',
  'payments.release_personal_polygon_relay_attempt(text,uuid,uuid,uuid,text)',
  'payments.mark_personal_polygon_relay_submitted(text,uuid,uuid,text,text)',
  'payments.mark_personal_polygon_relay_ambiguous(text,uuid,uuid)',
  'payments.expire_personal_polygon_relay(text,uuid)','payments.abandon_personal_polygon_relay(text,uuid)',
  'payments.confirm_personal_polygon_relay(text,uuid,uuid,text,text,text,text,integer,text)',
  'payments.reject_personal_polygon_relay(text,uuid,uuid,text,text,text,text,integer,text,text,text)',
  'payments.expire_personal_polygon_relay_operation(text,uuid,uuid,text,text,text,bigint,text,integer,text)',
  'payments.retire_native_polygon_relay_authorization(text,uuid,text,text,text,integer)',
  'payments.read_personal_polygon_relay_activity(text,uuid,uuid,integer)'] LOOP
  EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO mindbliss_auth_core_v1',v_signature::regprocedure);
 END LOOP;
END $runtime_capabilities$;
DO $verify$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
   WHERE c.relnamespace='payments'::regnamespace AND c.relname IN('personal_transfer_request','personal_polygon_relay','personal_polygon_native_authorization',
    'personal_polygon_relay_attempt','personal_polygon_relay_account','personal_polygon_relay_operation','personal_polygon_sponsor_reservation',
    'personal_polygon_operation_expiry','personal_polygon_relay_event','personal_polygon_relay_outcome','personal_polygon_authorization_retirement',
    'personal_polygon_relay_internal','personal_polygon_relay_dispatch','personal_polygon_relay_event_seq_seq') AND a.grantee<>c.relowner)
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace='payments'::regnamespace AND c.relkind='r'
   AND c.relname IN('personal_transfer_request','personal_polygon_relay','personal_polygon_native_authorization','personal_polygon_relay_attempt',
    'personal_polygon_relay_account','personal_polygon_relay_operation','personal_polygon_sponsor_reservation','personal_polygon_operation_expiry',
    'personal_polygon_relay_event','personal_polygon_relay_outcome','personal_polygon_authorization_retirement') AND NOT c.relrowsecurity)
  OR (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace='payments'::regnamespace AND p.proname IN(
    'read_personal_polygon_relay','read_personal_polygon_relay_history','prepare_personal_polygon_relay','authorize_personal_polygon_relay',
    'begin_personal_polygon_relay','persist_personal_polygon_relay_operation','release_personal_polygon_relay_attempt','mark_personal_polygon_relay_submitted',
    'mark_personal_polygon_relay_ambiguous','expire_personal_polygon_relay','abandon_personal_polygon_relay','confirm_personal_polygon_relay',
    'reject_personal_polygon_relay','expire_personal_polygon_relay_operation','retire_native_polygon_relay_authorization','read_personal_polygon_relay_activity')
    AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog']::text[]
    AND pg_catalog.has_function_privilege('mindbliss_auth_core_v1',p.oid,'EXECUTE'))<>16
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.prepare_personal_company_payment_v3(text,text,text,uuid,integer)'::regprocedure))<>'655b1dc08cc2ccd354bac7fe7d07abba'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.guard_personal_company_payment()'::regprocedure))<>'88247529f627ea098673b99cd23a9929'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('payments.capture_personal_company_payment_event()'::regprocedure))<>'fe7ecd7d9321bfed23cd56016aed6f46' THEN
  RAISE EXCEPTION 'polygon_relay_runtime_isolation_failed'; END IF;
END $verify$;
COMMIT;
