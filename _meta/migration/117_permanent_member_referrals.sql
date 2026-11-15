-- Permanent referral identity is independent of purchase and binary placement.
-- Installation writes no old rows. Runtime capture writes new metadata plus
-- only the owner's person.updated_at as an explicit MVCC bookkeeping fence.
-- Affiliates, packages, placement, balances, authentication and old hints stay unchanged.
BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('permanent-member-referrals-v1',0));
DO $preflight$
DECLARE v_owner oid;
BEGIN
 IF pg_catalog.current_database()<>'mindbliss_curated_20261025' OR pg_catalog.pg_is_in_recovery()
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('identity.require_administrative_native_session(text,text)'::regprocedure))<>'01bb63725c11ae353cb768a42ffa9485'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('identity.read_member_profile(text,text)'::regprocedure))<>'6c7e3d246185ce1cfa3502a84e1d8eca'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('identity.update_member_profile(text,text,text,text,text)'::regprocedure))<>'8478af8d38bd80c69d6744d9ff2798ac'
  OR pg_catalog.to_regclass('identity.permanent_member_referral') IS NOT NULL
  OR pg_catalog.to_regclass('identity.member_registration_sponsor') IS NOT NULL THEN
  RAISE EXCEPTION 'member_referral_requires_fresh_review'; END IF;
 SELECT proowner INTO v_owner FROM pg_catalog.pg_proc WHERE oid='identity.require_administrative_native_session(text,text)'::regprocedure;
 IF NOT pg_catalog.pg_has_role(v_owner,'USAGE')
  OR NOT pg_catalog.has_schema_privilege('mindbliss_auth_core_v1','identity','USAGE')
  OR NOT pg_catalog.has_table_privilege(v_owner,'mlm.person','SELECT')
  OR NOT pg_catalog.has_table_privilege(v_owner,'mlm.affiliate','SELECT')
  OR NOT pg_catalog.has_table_privilege(v_owner,'payments.registration_referral','SELECT')
  OR NOT pg_catalog.has_table_privilege(v_owner,'payments.purchase_intent','SELECT')
  OR NOT pg_catalog.has_table_privilege(v_owner,'payments.nowpayments_membership_attempt','SELECT')
  OR NOT pg_catalog.has_column_privilege(v_owner,'mlm.person','updated_at','UPDATE')
  OR NOT pg_catalog.has_table_privilege(v_owner,'mlm.affiliate_package','SELECT') THEN
  RAISE EXCEPTION 'member_referral_existing_owner_policy_required'; END IF;
END $preflight$;

CREATE TABLE identity.permanent_member_referral (
 subject text PRIMARY KEY REFERENCES auth."user"(id),
 person_id bigint NOT NULL UNIQUE REFERENCES mlm.person(id),
 code text NOT NULL CHECK(length(code) BETWEEN 1 AND 64 AND code !~ '[[:space:][:cntrl:]]'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX permanent_member_referral_code_idx ON identity.permanent_member_referral(lower(code));
ALTER TABLE identity.permanent_member_referral ENABLE ROW LEVEL SECURITY;

CREATE TABLE identity.member_registration_sponsor (
 subject text PRIMARY KEY REFERENCES auth."user"(id),
 person_id bigint NOT NULL UNIQUE REFERENCES mlm.person(id),
 sponsor_person_id bigint NOT NULL REFERENCES mlm.person(id),
 referral_code text NOT NULL CHECK(length(referral_code) BETWEEN 1 AND 64 AND referral_code !~ '[[:space:][:cntrl:]]'),
 source text NOT NULL CHECK(source IN('referral','company')),
 company_affiliate_id bigint REFERENCES mlm.affiliate(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(person_id<>sponsor_person_id),
 CHECK((source='company' AND company_affiliate_id IS NOT NULL) OR(source='referral' AND company_affiliate_id IS NULL))
);
CREATE INDEX member_registration_sponsor_person_idx ON identity.member_registration_sponsor(sponsor_person_id,created_at DESC);
ALTER TABLE identity.member_registration_sponsor ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION identity.member_referral_person_eligible(p_person bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT EXISTS(SELECT 1 FROM mlm.person p WHERE p.id=p_person AND p.status::text IN('active','pending')
  AND NOT coalesce(p.blacklisted,false)
  AND NOT EXISTS(SELECT 1 FROM mlm.affiliate a WHERE a.person_id=p.id AND a.status::text IN('suspended','banned','deleted'))
  AND NOT EXISTS(SELECT 1 FROM mlm.blacklist b
   WHERE (b.email_norm IS NOT NULL AND b.email_norm=mlm.norm_email(p.email))
    OR(b.phone_last10 IS NOT NULL AND b.phone_last10=mlm.norm_phone10(p.phone_number))
    OR(b.name_norm IS NOT NULL AND b.name_norm=mlm.norm_name(p.first_name||' '||p.last_name)
      AND(b.birthdate IS NULL OR(p.birthday IS NOT NULL AND b.birthdate=p.birthday)))))
$function$;

CREATE FUNCTION identity.ensure_permanent_member_referral(p_subject text,p_session text)
RETURNS TABLE(person_id bigint,code text,name text,affiliate_id bigint,sponsor_affiliate_id bigint,native_until timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' AS $function$
DECLARE v_native timestamptz;r record;a mlm.affiliate%ROWTYPE;l record;v_code text;
BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('permanent-referral-owner:'||p_subject,0));
 BEGIN v_native:=identity.require_administrative_native_session(p_subject,p_session);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'member_referral_forbidden' USING ERRCODE='28000'; END;
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'member_referral_unavailable' USING ERRCODE='40001'; END IF;
 BEGIN
  SELECT p.id,btrim(concat_ws(' ',p.first_name,p.last_name)) AS display_name INTO STRICT r
  FROM identity.auth_binding b JOIN mlm.person p ON p.id=b.person_id AND p.user_id=b.subject
  WHERE b.subject=p_subject AND b.provider='better_auth' FOR SHARE OF b,p;
 EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN RAISE EXCEPTION 'member_referral_forbidden' USING ERRCODE='28000'; END;
 IF NOT identity.member_referral_person_eligible(r.id) THEN RAISE EXCEPTION 'member_referral_forbidden' USING ERRCODE='28000'; END IF;
 BEGIN SELECT x.* INTO STRICT a FROM mlm.affiliate x WHERE x.person_id=r.id;
 EXCEPTION WHEN NO_DATA_FOUND THEN a:=NULL;
  WHEN TOO_MANY_ROWS THEN RAISE EXCEPTION 'member_referral_forbidden' USING ERRCODE='28000'; END;
 SELECT x.* INTO l FROM identity.permanent_member_referral x WHERE x.subject=p_subject;
 IF FOUND THEN
  IF l.person_id<>r.id THEN RAISE EXCEPTION 'member_referral_forbidden' USING ERRCODE='28000'; END IF;
  v_code:=l.code;
 ELSE
  v_code:=CASE WHEN a.id IS NOT NULL THEN coalesce(nullif(a.invitation_link,''),'MP'||a.id::text)
    ELSE 'MB'||replace(pg_catalog.gen_random_uuid()::text,'-','') END;
  IF length(v_code) NOT BETWEEN 1 AND 64 OR v_code ~ '[[:space:][:cntrl:]]'
   OR EXISTS(SELECT 1 FROM mlm.affiliate other WHERE other.person_id<>r.id AND lower(other.invitation_link)=lower(v_code)) THEN
   RAISE EXCEPTION 'member_referral_unavailable' USING ERRCODE='22023'; END IF;
  BEGIN INSERT INTO identity.permanent_member_referral(subject,person_id,code)VALUES(p_subject,r.id,v_code);
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'member_referral_unavailable' USING ERRCODE='23505'; END;
 END IF;
 IF v_native<=clock_timestamp() THEN RAISE EXCEPTION 'member_referral_forbidden' USING ERRCODE='28000'; END IF;
 RETURN QUERY SELECT r.id,v_code,r.display_name,a.id,a.sponsor_id,v_native;
END $function$;

CREATE FUNCTION identity.read_member_referral(p_subject text,p_session text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' AS $function$
DECLARE o record;v_sponsor bigint;v_sponsor_name text;v_sponsor_code text;v_source text;v_rows jsonb;v_active bigint;v_total bigint;
BEGIN
 SELECT * INTO STRICT o FROM identity.ensure_permanent_member_referral(p_subject,p_session);
 -- An existing affiliate's real recruitment sponsor is always authoritative.
 -- Binary parent_id is never read or substituted for recruitment attribution.
 IF o.affiliate_id IS NOT NULL THEN
  SELECT p.id,btrim(concat_ws(' ',p.first_name,p.last_name)),coalesce(l.code,nullif(a.invitation_link,''),'MP'||a.id::text)
   INTO v_sponsor,v_sponsor_name,v_sponsor_code FROM mlm.affiliate a JOIN mlm.person p ON p.id=a.person_id
   LEFT JOIN identity.permanent_member_referral l ON l.person_id=p.id WHERE a.id=o.sponsor_affiliate_id;
  v_source:='existing_affiliate';
 ELSE
  SELECT p.id,btrim(concat_ws(' ',p.first_name,p.last_name)),r.referral_code,r.source
   INTO v_sponsor,v_sponsor_name,v_sponsor_code,v_source FROM identity.member_registration_sponsor r
   JOIN mlm.person p ON p.id=r.sponsor_person_id WHERE r.subject=p_subject AND r.person_id=o.person_id;
 END IF;
 WITH direct_people AS (
  SELECT a.person_id FROM mlm.affiliate a WHERE o.affiliate_id IS NOT NULL AND a.sponsor_id=o.affiliate_id
  UNION
  SELECT r.person_id FROM identity.member_registration_sponsor r WHERE r.sponsor_person_id=o.person_id
   AND NOT EXISTS(SELECT 1 FROM mlm.affiliate a WHERE a.person_id=r.person_id)
 ), all_direct AS (
  SELECT 'person:'||p.public_id::text AS id,btrim(concat_ws(' ',p.first_name,split_part(p.last_name,' ',1))) AS name,
   coalesce(a.created_at,p.created_at) AS created_at,
   EXISTS(SELECT 1 FROM mlm.affiliate_package ap WHERE ap.affiliate_id=a.id AND ap.status::text='active') AS active_package
  FROM direct_people d JOIN mlm.person p ON p.id=d.person_id LEFT JOIN mlm.affiliate a ON a.person_id=p.id
  WHERE identity.member_referral_person_eligible(p.id)
 ), latest AS(SELECT * FROM all_direct ORDER BY created_at DESC,id DESC LIMIT 50)
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',coalesce(nullif(name,''),'Miembro'),
    'status',CASE WHEN active_package THEN 'activo' ELSE 'registrado' END,'date',created_at) ORDER BY created_at DESC,id),'[]'::jsonb),
   (SELECT count(*) FROM all_direct),(SELECT count(*) FROM all_direct WHERE active_package) INTO v_rows,v_total,v_active FROM latest;
 IF o.native_until<=clock_timestamp() THEN RAISE EXCEPTION 'member_referral_forbidden' USING ERRCODE='28000'; END IF;
 RETURN jsonb_build_object('positioned',o.affiliate_id IS NOT NULL,'code',o.code,'name',o.name,'placement','automatic','generated',true,
  'metrics',jsonb_build_object('total',v_total,'active',v_active,'pending',v_total-v_active),'referrals',v_rows,
  'sponsor_name',coalesce(v_sponsor_name,''),'sponsor_referral_code',coalesce(v_sponsor_code,''),'attribution_source',coalesce(v_source,'unassigned'));
END $function$;

CREATE FUNCTION identity.capture_member_referral(p_subject text,p_session text,p_ref text,p_company_root bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' AS $function$
DECLARE o record;r record;v_person bigint;v_code text;v_count bigint;v_source text;v_cycle boolean;v_depth integer;
BEGIN
 IF p_ref IS NULL OR length(p_ref)>64 OR p_ref ~ '[[:space:][:cntrl:]]' THEN
  RAISE EXCEPTION 'member_referral_invalid_request' USING ERRCODE='22023'; END IF;
 SELECT * INTO STRICT o FROM identity.ensure_permanent_member_referral(p_subject,p_session);
 IF o.affiliate_id IS NOT NULL THEN
  RETURN jsonb_build_object('ok',true,'ref','','preferred_side','','positioned',true,'immutable',true);
 END IF;
 SELECT x.* INTO r FROM identity.member_registration_sponsor x WHERE x.subject=p_subject;
 IF FOUND THEN
  IF r.person_id<>o.person_id THEN RAISE EXCEPTION 'member_referral_forbidden' USING ERRCODE='28000'; END IF;
  RETURN jsonb_build_object('ok',true,'ref',r.referral_code,'preferred_side','','positioned',false,'immutable',true);
 END IF;
 -- Every writer uses person -> attribution lock order. The owner-scoped
 -- advisory lease was acquired before native/person row locks in ensure().
 PERFORM p.id FROM mlm.person p WHERE p.id=o.person_id FOR NO KEY UPDATE;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('permanent-referral-attribution-v1',0));
 IF EXISTS(SELECT 1 FROM mlm.affiliate a WHERE a.person_id=o.person_id) THEN
  RETURN jsonb_build_object('ok',true,'ref','','preferred_side','','positioned',true,'immutable',true);
 END IF;
 -- A previously owner-verified server attribution is authoritative over a
 -- later browser hint. It is preserved rather than expired into company fallback.
 SELECT rr.referral_code,a.person_id INTO r FROM payments.registration_referral rr JOIN mlm.person p ON p.id=o.person_id
  LEFT JOIN mlm.affiliate a ON a.id=rr.sponsor_affiliate_id
  WHERE rr.email_norm=lower(btrim(p.email::text)) AND rr.source='verified_login' AND rr.consumed_at IS NULL;
 IF FOUND THEN
  v_person:=r.person_id;v_code:=r.referral_code;v_source:='referral';
  IF v_person IS NULL OR NOT identity.member_referral_person_eligible(v_person) THEN
   RAISE EXCEPTION 'member_referral_invalid_code' USING ERRCODE='22023'; END IF;
 ELSIF p_ref='' THEN
  SELECT p.id,coalesce(l.code,nullif(a.invitation_link,''),'MP'||a.id::text) INTO v_person,v_code
   FROM mlm.affiliate a JOIN mlm.person p ON p.id=a.person_id
   LEFT JOIN identity.permanent_member_referral l ON l.person_id=p.id
   WHERE a.id=p_company_root AND a.parent_id IS NULL AND a.sponsor_id IS NULL
    AND a.status::text='active' AND p.status::text='active'
    AND identity.member_referral_person_eligible(p.id);
  IF NOT FOUND THEN RAISE EXCEPTION 'member_referral_unconfigured' USING ERRCODE='22023'; END IF;
  v_source:='company';
 ELSE
  SELECT l.person_id,l.code INTO v_person,v_code FROM identity.permanent_member_referral l WHERE lower(l.code)=lower(p_ref);
  IF FOUND THEN
   IF EXISTS(SELECT 1 FROM mlm.affiliate a WHERE a.person_id<>v_person AND(
    lower(a.invitation_link)=lower(p_ref) OR(p_ref ~ '^[Mm][Pp][0-9]+$' AND a.id::text=ltrim(substr(p_ref,3),'0')))) THEN
    RAISE EXCEPTION 'member_referral_invalid_code' USING ERRCODE='22023'; END IF;
  ELSE
  WITH candidates AS (
   SELECT a.person_id,coalesce(nullif(a.invitation_link,''),'MP'||a.id::text) AS code,
    CASE WHEN a.invitation_link=p_ref THEN 1 WHEN lower(a.invitation_link)=lower(p_ref) THEN 2 ELSE 3 END AS priority
   FROM mlm.affiliate a WHERE lower(a.invitation_link)=lower(p_ref)
    OR(p_ref ~ '^[Mm][Pp][0-9]+$' AND a.id::text=ltrim(substr(p_ref,3),'0'))
  ), best AS(SELECT DISTINCT person_id,code FROM candidates WHERE priority=(SELECT min(priority)FROM candidates))
  SELECT min(person_id),min(code),count(DISTINCT person_id) INTO v_person,v_code,v_count FROM best;
  IF v_count<>1 THEN RAISE EXCEPTION 'member_referral_invalid_code' USING ERRCODE='22023'; END IF;
  END IF;
  IF NOT identity.member_referral_person_eligible(v_person) THEN
   RAISE EXCEPTION 'member_referral_invalid_code' USING ERRCODE='22023'; END IF;
  v_source:='referral';
 END IF;
 IF v_person=o.person_id THEN RAISE EXCEPTION 'member_referral_invalid_code' USING ERRCODE='22023'; END IF;
 WITH RECURSIVE lineage(person_id,seen,depth,cycle) AS (
  SELECT v_person,ARRAY[v_person],0,v_person=o.person_id
  UNION ALL
  SELECT coalesce(sp.person_id,edge.sponsor_person_id),l.seen||coalesce(sp.person_id,edge.sponsor_person_id),l.depth+1,
   coalesce(sp.person_id,edge.sponsor_person_id)=ANY(l.seen) OR coalesce(sp.person_id,edge.sponsor_person_id)=o.person_id
  FROM lineage l LEFT JOIN mlm.affiliate a ON a.person_id=l.person_id
   LEFT JOIN mlm.affiliate sp ON sp.id=a.sponsor_id LEFT JOIN identity.member_registration_sponsor edge ON edge.person_id=l.person_id AND a.id IS NULL
  WHERE NOT l.cycle AND l.depth<1000 AND coalesce(sp.person_id,edge.sponsor_person_id) IS NOT NULL
 ) SELECT coalesce(bool_or(cycle),false),max(depth)INTO v_cycle,v_depth FROM lineage;
 IF v_cycle OR v_depth>=1000 THEN RAISE EXCEPTION 'member_referral_invalid_code' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM payments.purchase_intent pi LEFT JOIN mlm.affiliate a ON a.id=pi.sponsor_affiliate_id
    WHERE pi.person_id=o.person_id AND pi.status::text NOT IN('failed','expired','cancelled','refunded') AND a.person_id IS DISTINCT FROM v_person)
  OR EXISTS(SELECT 1 FROM payments.nowpayments_membership_attempt pi LEFT JOIN mlm.affiliate a ON a.id=pi.sponsor_affiliate_id
    WHERE pi.person_id=o.person_id AND pi.state<>'closed_reviewed' AND a.person_id IS DISTINCT FROM v_person) THEN
  RAISE EXCEPTION 'member_referral_outstanding_order' USING ERRCODE='55000'; END IF;
 -- Real row-version fence: a prior REPEATABLE READ reservation cannot miss
 -- this attribution after waiting on the same owner row. Its pre-provider
 -- reservation rolls back with 40001 and follows the existing local retry rule.
 UPDATE mlm.person SET updated_at=clock_timestamp() WHERE id=o.person_id;
 INSERT INTO identity.member_registration_sponsor(subject,person_id,sponsor_person_id,referral_code,source,company_affiliate_id)
  VALUES(p_subject,o.person_id,v_person,v_code,v_source,CASE WHEN v_source='company' THEN p_company_root ELSE NULL END);
 IF o.native_until<=clock_timestamp() THEN RAISE EXCEPTION 'member_referral_forbidden' USING ERRCODE='28000'; END IF;
 RETURN jsonb_build_object('ok',true,'ref',v_code,'preferred_side','','positioned',false,'immutable',true);
END $function$;

CREATE FUNCTION identity.read_member_profile_v2(p_subject text,p_session text)
RETURNS TABLE(first_name text,last_name text,phone text,country text,payout_wallet_usdc text,sponsor_name text,sponsor_referral_code text,referral_code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' AS $function$
DECLARE p record;c jsonb;
BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('permanent-referral-owner:'||p_subject,0));
 SELECT * INTO STRICT p FROM identity.read_member_profile(p_subject,p_session);
 c:=identity.read_member_referral(p_subject,p_session);
 RETURN QUERY SELECT p.first_name,p.last_name,p.phone,p.country,p.payout_wallet_usdc,
  c->>'sponsor_name',c->>'sponsor_referral_code',c->>'code';
END $function$;

CREATE FUNCTION identity.update_member_profile_v2(p_subject text,p_session text,p_name text,p_phone text,p_country text)
RETURNS TABLE(first_name text,last_name text,phone text,country text,payout_wallet_usdc text,sponsor_name text,sponsor_referral_code text,referral_code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' AS $function$
BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('permanent-referral-owner:'||p_subject,0));
 PERFORM identity.update_member_profile(p_subject,p_session,p_name,p_phone,p_country);
 RETURN QUERY SELECT * FROM identity.read_member_profile_v2(p_subject,p_session);
END $function$;

-- Legacy checkout may not silently replace a newly recorded recruitment
-- sponsor with the company while that sponsor has no binary affiliate yet.
-- This guard never places a node, fulfils a purchase, or changes an old row.
CREATE FUNCTION payments.guard_permanent_referral_checkout()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' AS $function$
DECLARE r record;v_affiliate bigint;v_count bigint;
BEGIN
 IF TG_OP<>'INSERT' OR TG_TABLE_SCHEMA<>'payments' OR TG_TABLE_NAME NOT IN('purchase_intent','nowpayments_membership_attempt') THEN
  RAISE EXCEPTION 'member_referral_checkout_guard_invalid' USING ERRCODE='22023'; END IF;
 IF NEW.person_id IS NULL OR EXISTS(SELECT 1 FROM mlm.affiliate a WHERE a.person_id=NEW.person_id) THEN RETURN NEW; END IF;
 PERFORM p.id FROM mlm.person p WHERE p.id=NEW.person_id FOR NO KEY UPDATE;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('permanent-referral-attribution-v1',0));
 SELECT x.* INTO r FROM identity.member_registration_sponsor x WHERE x.person_id=NEW.person_id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 SELECT min(a.id),count(*) INTO v_affiliate,v_count FROM mlm.affiliate a WHERE a.person_id=r.sponsor_person_id
  AND identity.member_referral_person_eligible(a.person_id);
 IF v_count=0 THEN RAISE EXCEPTION 'referral_sponsor_needs_placement' USING ERRCODE='55000'; END IF;
 IF v_count<>1 OR NEW.sponsor_affiliate_id IS DISTINCT FROM v_affiliate THEN
  RAISE EXCEPTION 'referral_sponsor_mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER purchase_intent_permanent_referral_guard BEFORE INSERT ON payments.purchase_intent
 FOR EACH ROW EXECUTE FUNCTION payments.guard_permanent_referral_checkout();
CREATE TRIGGER nowpayments_membership_permanent_referral_guard BEFORE INSERT ON payments.nowpayments_membership_attempt
 FOR EACH ROW EXECUTE FUNCTION payments.guard_permanent_referral_checkout();

-- The Go checkout calls this before starting its reservation transaction or
-- any provider invoice. Absence is explicit, never permission to substitute
-- the company for an unpositioned member's recorded recruitment sponsor.
CREATE FUNCTION payments.read_permanent_checkout_sponsor(p_subject text,p_person bigint)
RETURNS TABLE(sponsor_affiliate_id bigint,referral_code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' AS $function$
DECLARE v_person bigint;r record;v_id bigint;v_count bigint;
BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('permanent-referral-owner:'||p_subject,0));
 BEGIN v_person:=identity.administrative_wallet_person(p_subject);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'referral_identity_review' USING ERRCODE='28000'; END;
 IF v_person IS DISTINCT FROM p_person THEN RAISE EXCEPTION 'referral_identity_review' USING ERRCODE='28000'; END IF;
 SELECT min(a.sponsor_id),count(*) INTO v_id,v_count FROM mlm.affiliate a WHERE a.person_id=v_person;
 IF v_count>1 THEN RAISE EXCEPTION 'referral_identity_review' USING ERRCODE='28000'; END IF;
 IF v_count=1 THEN RETURN QUERY SELECT v_id,''::text; RETURN; END IF;
 SELECT x.* INTO r FROM identity.member_registration_sponsor x WHERE x.person_id=v_person AND x.subject=p_subject;
 IF NOT FOUND THEN RAISE EXCEPTION 'referral_attribution_required' USING ERRCODE='55000'; END IF;
 SELECT min(a.id),count(*) INTO v_id,v_count FROM mlm.affiliate a WHERE a.person_id=r.sponsor_person_id
  AND identity.member_referral_person_eligible(a.person_id);
 IF v_count=0 THEN RAISE EXCEPTION 'referral_sponsor_needs_placement' USING ERRCODE='55000'; END IF;
 IF v_count<>1 THEN RAISE EXCEPTION 'referral_identity_review' USING ERRCODE='28000'; END IF;
 RETURN QUERY SELECT v_id,r.referral_code;
END $function$;

DO $ownership$
DECLARE v_owner oid;item record;signature text;
BEGIN
 SELECT proowner INTO v_owner FROM pg_catalog.pg_proc WHERE oid='identity.require_administrative_native_session(text,text)'::regprocedure;
 FOR item IN SELECT c.oid::regclass AS relation FROM pg_catalog.pg_class c WHERE c.oid IN(
  'identity.permanent_member_referral'::regclass,'identity.member_registration_sponsor'::regclass) LOOP
  EXECUTE format('ALTER TABLE %s OWNER TO %I',item.relation,pg_get_userbyid(v_owner));
 END LOOP;
 FOREACH signature IN ARRAY ARRAY['identity.member_referral_person_eligible(bigint)',
  'identity.ensure_permanent_member_referral(text,text)','identity.read_member_referral(text,text)',
  'identity.capture_member_referral(text,text,text,bigint)','identity.read_member_profile_v2(text,text)',
  'identity.update_member_profile_v2(text,text,text,text,text)','payments.guard_permanent_referral_checkout()',
  'payments.read_permanent_checkout_sponsor(text,bigint)'] LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO %I',signature,pg_get_userbyid(v_owner));
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
 END LOOP;
 FOR item IN SELECT c.oid::regclass relation,a.grantee FROM pg_catalog.pg_class c
  CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl)a WHERE c.oid IN(
   'identity.permanent_member_referral'::regclass,'identity.member_registration_sponsor'::regclass) AND a.grantee<>c.relowner LOOP
  EXECUTE format('REVOKE ALL ON TABLE %s FROM %s',item.relation,CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(item.grantee)) END);
 END LOOP;
 FOR item IN SELECT p.oid::regprocedure signature,a.grantee FROM pg_catalog.pg_proc p
  CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl)a WHERE p.oid IN(
   'identity.member_referral_person_eligible(bigint)'::regprocedure,'identity.ensure_permanent_member_referral(text,text)'::regprocedure,
   'identity.read_member_referral(text,text)'::regprocedure,'identity.capture_member_referral(text,text,text,bigint)'::regprocedure,
   'identity.read_member_profile_v2(text,text)'::regprocedure,'identity.update_member_profile_v2(text,text,text,text,text)'::regprocedure,
   'payments.guard_permanent_referral_checkout()'::regprocedure,'payments.read_permanent_checkout_sponsor(text,bigint)'::regprocedure)
   AND a.grantee<>p.proowner AND a.grantee<>0 LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',item.signature,pg_get_userbyid(item.grantee));
 END LOOP;
END $ownership$;
GRANT EXECUTE ON FUNCTION identity.read_member_referral(text,text),identity.capture_member_referral(text,text,text,bigint),
 identity.read_member_profile_v2(text,text),identity.update_member_profile_v2(text,text,text,text,text) TO mindbliss_auth_core_v1;
GRANT EXECUTE ON FUNCTION payments.read_permanent_checkout_sponsor(text,bigint) TO mindbliss_go_payments_reader_v1;
COMMIT;
