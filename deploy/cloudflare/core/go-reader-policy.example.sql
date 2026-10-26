-- PREPARED ONLY. Three NEW Go-service NOLOGIN policy groups; no credentials.
-- Replace REPLACE_WITH_CURATED_DATABASE after reviewing the canonical target.
-- Attach each separately-created, empty LOGIN to EXACTLY ONE matching group,
-- INHERIT TRUE / SET FALSE / ADMIN FALSE, and audit the login's effective ACLs.
-- Do not reuse the Bun reader/auth login or any shared legacy/global role.
-- All financial mutations, background compensation, Stripe/BMP calls, support,
-- comms and reconciliation remain disabled separately in the deployment.
-- This script never creates missing business tables or modifies PUBLIC/old roles.
-- No future-default grants: a new table needs a separate access review. Full
-- business-table SELECT includes later columns: review those BEFORE adding them.
-- Auth/binding/audit use column allowlists instead of full-table SELECT.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('mindbliss-go-reader-policy-v1',0));
DO $$ BEGIN
  IF current_database()<>'REPLACE_WITH_CURATED_DATABASE' THEN
    RAISE EXCEPTION 'go_reader_explicit_database_review_required';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('mindbliss_go_engine_reader_v1',
    'mindbliss_go_payments_reader_v1','mindbliss_go_withdrawals_reader_v1')) THEN
    RAISE EXCEPTION 'go_reader_fresh_role_names_required';
  END IF;
END $$;

-- Explicit audited relation manifests, not a schema-wide or auto-discovered
-- grant. r=ordinary table; v=reviewed view. Sequences, enums, function names,
-- NATS subjects and Go identifiers are NOT relations in this policy.
-- Temporary operator-only metadata disappears at COMMIT, not application data.
CREATE TEMP TABLE go_reader_relations(service text,relation_name text,expected_kind "char",required boolean,
  PRIMARY KEY(service,relation_name)) ON COMMIT DROP;
INSERT INTO go_reader_relations VALUES
  -- ledger/service.go GetWalletBalance. GetMovements currently unimplemented;
  -- concept is the sole approved preparatory lookup, not the bonus-engine data.
  ('engine','mlm.wallet','r',true),
  ('engine','mlm.wallet_movement','r',true),
  ('engine','mlm.concept','r',true),
  -- payments: member/profile/admin tree/network, plan, ledger and Stripe reports.
  ('payments','mlm.person','r',true),
  ('payments','mlm.affiliate','r',true),
  ('payments','mlm.affiliate_closure','r',true),
  ('payments','mlm.affiliate_package','r',true),
  ('payments','mlm.affiliate_rank_achieved','r',true),
  ('payments','mlm.alert_event','r',true),
  ('payments','mlm.approval_request','r',true),
  ('payments','mlm.asset','r',true),
  ('payments','mlm.binary_period','r',true),
  ('payments','mlm.blacklist','r',true),
  ('payments','mlm.cd_roi_tier','r',true),
  ('payments','mlm.concept','r',true),
  ('payments','mlm.country','r',true),
  ('payments','mlm.investment_cd','r',true),
  ('payments','mlm.kyc_document','r',true),
  -- GET /api/member/onboarding requires the separately reviewed table65 DDL.
  ('payments','mlm.member_onboarding','r',true),
  ('payments','mlm.package','r',true),
  ('payments','mlm.package_cap_state','r',true),
  ('payments','mlm.plan_config','r',true),
  ('payments','mlm.rank','r',true),
  ('payments','mlm.rank_bonus_installment','r',true),
  ('payments','mlm.tree_event','r',true),
  ('payments','mlm.wallet','r',true),
  ('payments','mlm.wallet_movement','r',true),
  ('payments','mlm.withdrawal_request','r',true),
  ('payments','mlm.v_cd_qualification','v',true),
  ('payments','mlm.v_period_solvency','v',true),
  ('payments','mlm.v_tree_pv_truth','v',true),
  ('payments','payments.purchase_intent','r',true),
  ('payments','payments.stripe_event','r',true),
  ('payments','payments.stripe_sale','r',true),
  -- Optional operational/non-recovery paths; explicit grants only IF present.
  -- Their absence is not a reason to create data or enable financial endpoints.
  ('payments','payments.operational_charge_adjustment','r',false),
  ('payments','payments.registration_referral','r',false),
  -- stripe_recovery_read.go/member_recovery.go. Not all of recovery schema.
  ('payments','recovery.stripe_sale_identity','r',true),
  ('payments','recovery.package_catalog_snapshot','r',true),
  ('payments','recovery.v_stripe_funds_review','v',true),
  ('payments','recovery.v_stripe_funds_provider_comparison','v',true),
  -- withdrawals admin/list/balance/link read models, no transaction INSERTs.
  ('withdrawals','mlm.person','r',true),
  ('withdrawals','mlm.affiliate','r',true),
  ('withdrawals','mlm.asset','r',true),
  ('withdrawals','mlm.concept','r',true),
  ('withdrawals','mlm.wallet','r',true),
  ('withdrawals','mlm.wallet_movement','r',true),
  ('withdrawals','mlm.withdrawal_request','r',true),
  -- GET /api/admin/bmp-links reads this table. Ordinary ListWithdrawals does
  -- NOT depend on it; EmailByWithdrawalID uses it in the blocked pay path.
  ('withdrawals','mlm.bmp_account_link','r',true);

DO $$ DECLARE item record; function_name text;
BEGIN
  FOR item IN SELECT * FROM go_reader_relations LOOP
    IF to_regclass(item.relation_name) IS NULL THEN
      IF item.required THEN RAISE EXCEPTION 'go_reader_required_relation_missing: %',item.relation_name; END IF;
    ELSIF (SELECT relkind FROM pg_class WHERE oid=to_regclass(item.relation_name))<>item.expected_kind THEN
      RAISE EXCEPTION 'go_reader_relation_kind_requires_review: %',item.relation_name;
    END IF;
  END LOOP;
  IF to_regclass('auth.user') IS NULL OR to_regclass('identity.auth_binding') IS NULL
    OR to_regclass('audit.activity_log') IS NULL OR NOT EXISTS(SELECT 1 FROM pg_attribute
      WHERE attrelid='mlm.person'::regclass AND attname='public_id' AND atttypid='uuid'::regtype AND NOT attisdropped) THEN
    RAISE EXCEPTION 'go_reader_identity72_or_audit_schema_required';
  END IF;
  FOREACH function_name IN ARRAY ARRAY['mlm.norm_email(text)','mlm.norm_phone10(text)','mlm.norm_name(text)'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
      WHERE p.oid=to_regprocedure(function_name) AND NOT p.prosecdef AND p.provolatile='i' AND l.lanname='sql') THEN
      RAISE EXCEPTION 'go_reader_normalizer_invoker_immutable_sql_required';
    END IF;
  END LOOP;
END $$;

CREATE ROLE mindbliss_go_engine_reader_v1 NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE mindbliss_go_payments_reader_v1 NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE mindbliss_go_withdrawals_reader_v1 NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
DO $$ DECLARE item record; group_name text;
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO mindbliss_go_engine_reader_v1,mindbliss_go_payments_reader_v1,mindbliss_go_withdrawals_reader_v1',current_database());
  FOR item IN SELECT * FROM go_reader_relations WHERE to_regclass(relation_name) IS NOT NULL LOOP
    group_name='mindbliss_go_'||item.service||'_reader_v1';
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I',split_part(item.relation_name,'.',1),group_name);
    EXECUTE format('GRANT SELECT ON TABLE %s TO %I',to_regclass(item.relation_name),group_name);
  END LOOP;
END $$;
-- Go validates JWT via PUBLIC HTTPS JWKS, not direct auth.jwks/session queries.
-- Its binding SQL uses exactly these auth/identity columns; Engine does not.
GRANT USAGE ON SCHEMA auth,identity TO mindbliss_go_payments_reader_v1,mindbliss_go_withdrawals_reader_v1;
GRANT SELECT(id,email,email_verified) ON auth.user TO mindbliss_go_payments_reader_v1,mindbliss_go_withdrawals_reader_v1;
GRANT SELECT(subject,person_id,provider) ON identity.auth_binding TO mindbliss_go_payments_reader_v1,mindbliss_go_withdrawals_reader_v1;
-- sales.go operational counts use only these four audit fields. No actor data,
-- before_data, broad audit-history or runtime writes are granted.
GRANT USAGE ON SCHEMA audit TO mindbliss_go_payments_reader_v1;
GRANT SELECT(after_data,entity_type,action,occurred_at) ON audit.activity_log TO mindbliss_go_payments_reader_v1;
GRANT EXECUTE ON FUNCTION mlm.norm_email(text),mlm.norm_phone10(text),mlm.norm_name(text) TO mindbliss_go_payments_reader_v1;
DO $$ DECLARE extension_schema text;
BEGIN
  SELECT n.nspname INTO extension_schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='unaccent';
  IF extension_schema IS NOT NULL THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO mindbliss_go_payments_reader_v1',extension_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.unaccent(text) TO mindbliss_go_payments_reader_v1',extension_schema);
  END IF;
END $$;

DO $$ DECLARE service_name text; group_name text; column_name text; item record;
BEGIN
  FOREACH service_name IN ARRAY ARRAY['engine','payments','withdrawals'] LOOP
    group_name='mindbliss_go_'||service_name||'_reader_v1';
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=group_name AND NOT rolcanlogin AND rolinherit
      AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
      OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=group_name)) THEN
      RAISE EXCEPTION 'go_reader_role_attributes_or_inheritance';
    END IF;
    IF has_database_privilege(group_name,current_database(),'CREATE') OR EXISTS(SELECT 1 FROM pg_namespace n
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND has_schema_privilege(group_name,n.oid,'CREATE')) THEN
      RAISE EXCEPTION 'go_reader_public_create_requires_review';
    END IF;
    IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prosecdef
      AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
      AND has_schema_privilege(group_name,n.oid,'USAGE') AND has_function_privilege(group_name,p.oid,'EXECUTE')) THEN
      RAISE EXCEPTION 'go_reader_accessible_security_definer_requires_review';
    END IF;
    IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')
      AND (has_table_privilege(group_name,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(group_name,c.oid,'INSERT,UPDATE,REFERENCES'))) THEN
      RAISE EXCEPTION 'go_reader_effective_data_write_access';
    END IF;
    IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
        AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(group_name,c.oid,'USAGE,SELECT,UPDATE') ELSE false END) THEN
      RAISE EXCEPTION 'go_reader_effective_sequence_access';
    END IF;
    -- No unexpected PUBLIC table/column reads, including sessions/JWKS/claims,
    -- support/comms/cron or another service's data. Extension metadata excluded.
    IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')
        AND has_any_column_privilege(group_name,c.oid,'SELECT')
        AND NOT EXISTS(SELECT 1 FROM go_reader_relations a WHERE a.service=service_name AND to_regclass(a.relation_name)=c.oid)
        AND NOT(service_name IN ('payments','withdrawals') AND c.oid IN ('auth.user'::regclass,'identity.auth_binding'::regclass))
        AND NOT(service_name='payments' AND c.oid='audit.activity_log'::regclass)
        AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid
          AND d.refclassid='pg_extension'::regclass AND d.deptype='e')) THEN
      RAISE EXCEPTION 'go_reader_unreviewed_relation_read_access';
    END IF;
    IF service_name IN ('payments','withdrawals') THEN
      FOR column_name IN SELECT attname FROM pg_attribute WHERE attrelid='auth.user'::regclass AND attnum>0
        AND NOT attisdropped AND attname NOT IN ('id','email','email_verified') LOOP
        IF has_column_privilege(group_name,'auth.user',column_name,'SELECT') THEN RAISE EXCEPTION 'go_reader_extra_auth_user_column'; END IF;
      END LOOP;
      FOR column_name IN SELECT attname FROM pg_attribute WHERE attrelid='identity.auth_binding'::regclass AND attnum>0
        AND NOT attisdropped AND attname NOT IN ('subject','person_id','provider') LOOP
        IF has_column_privilege(group_name,'identity.auth_binding',column_name,'SELECT') THEN RAISE EXCEPTION 'go_reader_extra_binding_column'; END IF;
      END LOOP;
    END IF;
    IF service_name='payments' THEN
      FOR column_name IN SELECT attname FROM pg_attribute WHERE attrelid='audit.activity_log'::regclass AND attnum>0
        AND NOT attisdropped AND attname NOT IN ('after_data','entity_type','action','occurred_at') LOOP
        IF has_column_privilege(group_name,'audit.activity_log',column_name,'SELECT') THEN RAISE EXCEPTION 'go_reader_extra_audit_column'; END IF;
      END LOOP;
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    WHERE a.grantee=0 AND d.defaclobjtype IN ('r','S')) THEN
    RAISE EXCEPTION 'go_reader_public_future_data_defaults_require_review';
  END IF;
  -- Do not let an owner-privileged report view indirectly reveal auth secrets.
  IF EXISTS(WITH RECURSIVE deps(root_oid,relation_oid) AS (
    SELECT DISTINCT c.oid,d.refobjid FROM go_reader_relations a JOIN pg_class c ON c.oid=to_regclass(a.relation_name)
      JOIN pg_rewrite w ON w.ev_class=c.oid JOIN pg_depend d ON d.classid='pg_rewrite'::regclass AND d.objid=w.oid
      AND d.refclassid='pg_class'::regclass WHERE c.relkind='v' AND d.refobjid<>c.oid
    UNION
    SELECT deps.root_oid,d.refobjid FROM deps JOIN pg_class c ON c.oid=deps.relation_oid AND c.relkind='v'
      JOIN pg_rewrite w ON w.ev_class=c.oid JOIN pg_depend d ON d.classid='pg_rewrite'::regclass AND d.objid=w.oid
      AND d.refclassid='pg_class'::regclass AND d.refobjid<>c.oid
  ) SELECT 1 FROM deps JOIN pg_class c ON c.oid=deps.relation_oid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('auth','identity')) THEN
    RAISE EXCEPTION 'go_reader_report_view_private_identity_dependency';
  END IF;
END $$;
-- PUBLIC/legacy credentials remain unchanged. This policy creates no LOGIN,
-- password, role membership, business row, function, default ACL or message.
-- Core proxy must STILL block financial POSTs and disable jobs/provider calls;
-- database read-only grants cannot stop a Stripe HTTP request before a DB write.
COMMIT;
