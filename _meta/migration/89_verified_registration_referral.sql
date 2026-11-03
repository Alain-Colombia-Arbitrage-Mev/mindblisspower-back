-- PREPARED ONLY. Operator-reviewed metadata capability; never run on startup.
-- No backfill, tree/identity mutation, financial permission, or order rewrite.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('verified-registration-referral-v1',0));
DO $preflight$
DECLARE original_search_path text:=pg_catalog.current_setting('search_path');
BEGIN
 IF pg_catalog.current_database()<>'mindbliss_curated_20261025' THEN
  RAISE EXCEPTION 'referral_explicit_database_review_required';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='mindbliss_referral_owner_20261103')
 OR pg_catalog.to_regprocedure('payments.verified_registration_referral(text,text,text,text)') IS NOT NULL THEN
  RAISE EXCEPTION 'referral_capability_requires_fresh_review';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='mindbliss_go_payments_reader_v1'
  AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls) THEN
  RAISE EXCEPTION 'referral_existing_payments_reader_policy_required';
 END IF;
 IF pg_catalog.has_table_privilege('mindbliss_go_payments_reader_v1','payments.registration_referral','INSERT,UPDATE,DELETE,TRUNCATE') THEN
  RAISE EXCEPTION 'referral_runtime_must_not_have_table_dml';
 END IF;
 -- Migration 68 pins unaccent to its actual extension schema. The invoker
 -- normalizer must work under the same safe path as the future definer; fail
 -- before granting any capability if that dependency is still unqualified.
 PERFORM pg_catalog.set_config('search_path','pg_catalog, pg_temp',true);
 PERFORM mlm.norm_name('Synthetic referral preflight');
 PERFORM pg_catalog.set_config('search_path',original_search_path,true);
END $preflight$;

CREATE ROLE mindbliss_referral_owner_20261103 NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA auth,identity,mlm,payments TO mindbliss_referral_owner_20261103;
GRANT SELECT(id,email,email_verified) ON auth.user TO mindbliss_referral_owner_20261103;
GRANT SELECT(subject,person_id,provider) ON identity.auth_binding TO mindbliss_referral_owner_20261103;
GRANT SELECT(id,user_id,email,status,blacklisted,phone_number,first_name,last_name,birthday)
 ON mlm.person TO mindbliss_referral_owner_20261103;
-- PostgreSQL requires UPDATE on at least one column for a row lock. This NOLOGIN
-- owner uses that privilege ONLY for FOR NO KEY UPDATE, never an UPDATE command.
-- No runtime membership or UPDATE privilege is granted to the payments reader.
GRANT UPDATE(updated_at) ON mlm.person TO mindbliss_referral_owner_20261103;
GRANT SELECT(id,person_id,status,invitation_link) ON mlm.affiliate TO mindbliss_referral_owner_20261103;
GRANT SELECT(email_norm,phone_last10,name_norm,birthdate) ON mlm.blacklist TO mindbliss_referral_owner_20261103;
GRANT SELECT(email_norm,referral_code,sponsor_affiliate_id,preferred_side,source,updated_at,consumed_at),
 INSERT(email_norm,referral_code,sponsor_affiliate_id,preferred_side,source,created_at,updated_at,consumed_at),
 UPDATE(referral_code,sponsor_affiliate_id,preferred_side,source,updated_at,consumed_at)
 ON payments.registration_referral TO mindbliss_referral_owner_20261103;
GRANT EXECUTE ON FUNCTION mlm.norm_email(text),mlm.norm_phone10(text),mlm.norm_name(text)
 TO mindbliss_referral_owner_20261103;
DO $normalizer$
DECLARE extension_schema text;
BEGIN
 SELECT n.nspname INTO STRICT extension_schema FROM pg_catalog.pg_extension e
 JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='unaccent';
 EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA %I TO mindbliss_referral_owner_20261103',extension_schema);
 EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %I.unaccent(text) TO mindbliss_referral_owner_20261103',extension_schema);
END $normalizer$;

-- NULL ref = read; non-NULL ref = verified last-touch update. Caller JWT/service
-- proof is verified in Go; this independent DB boundary rechecks binding/email,
-- restrictions and sponsor eligibility. Every name is schema-qualified and the
-- safe search_path excludes public and other caller-writable schemas.
CREATE FUNCTION payments.verified_registration_referral(
 p_subject text,p_email text,p_ref text,p_side text
) RETURNS TABLE(referral_code text,preferred_side text,positioned boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
SET lock_timeout='2s'
AS $function$
DECLARE
 owner_id bigint;
 sponsor_id bigint;
 sponsor_count bigint;
 owner_row record;
 stored record;
BEGIN
 -- A stale REPEATABLE READ snapshot could miss an affiliate committed while
 -- waiting for the buyer lock. The HTTP capability uses autocommit READ
 -- COMMITTED; other caller isolation levels must fail closed for writes.
 IF p_ref IS NOT NULL AND pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'referral_read_committed_required';
 END IF;
 IF p_subject IS NULL OR pg_catalog.btrim(p_subject)='' OR p_email IS NULL OR
    p_email<>pg_catalog.lower(pg_catalog.btrim(p_email)) OR pg_catalog.length(p_email) NOT BETWEEN 3 AND 254 OR
    pg_catalog.strpos(p_email,'@')=0 THEN
  RAISE EXCEPTION 'referral_identity_review';
 END IF;
 SELECT p.id INTO owner_id FROM identity.auth_binding b
 JOIN auth.user u ON u.id=b.subject JOIN mlm.person p ON p.id=b.person_id AND p.user_id=b.subject
 WHERE b.subject=p_subject AND b.provider='better_auth' AND u.email_verified
 AND pg_catalog.lower(pg_catalog.btrim(u.email))=p_email AND pg_catalog.lower(pg_catalog.btrim(p.email::text))=p_email;
 IF NOT FOUND THEN RAISE EXCEPTION 'referral_identity_review'; END IF;

 -- Same buyer lock used by NOW invoice creation/activation. Check the current
 -- affiliate AFTER acquiring it: placement winning the race makes POST a no-op.
 IF p_ref IS NOT NULL THEN
  PERFORM p.id FROM mlm.person p WHERE p.id=owner_id FOR NO KEY UPDATE;
 END IF;
 SELECT p.status,p.blacklisted,p.email,p.phone_number,p.first_name,p.last_name,p.birthday INTO owner_row FROM mlm.person p
 JOIN identity.auth_binding b ON b.person_id=p.id AND b.subject=p.user_id
 JOIN auth.user u ON u.id=b.subject
 WHERE p.id=owner_id AND b.subject=p_subject AND b.provider='better_auth' AND u.email_verified
 AND pg_catalog.lower(pg_catalog.btrim(u.email))=p_email AND pg_catalog.lower(pg_catalog.btrim(p.email::text))=p_email
 AND NOT EXISTS(SELECT 1 FROM mlm.person other WHERE other.id<>p.id AND pg_catalog.lower(pg_catalog.btrim(other.email::text))=p_email);
 IF NOT FOUND THEN RAISE EXCEPTION 'referral_identity_review'; END IF;
 IF owner_row.status::text NOT IN ('active','pending') OR COALESCE(owner_row.blacklisted,false)
 OR EXISTS(SELECT 1 FROM mlm.affiliate a WHERE a.person_id=owner_id AND a.status::text IN ('suspended','banned','deleted'))
 OR EXISTS(SELECT 1 FROM mlm.blacklist b
  WHERE (b.email_norm IS NOT NULL AND b.email_norm=mlm.norm_email(owner_row.email))
   OR (b.phone_last10 IS NOT NULL AND b.phone_last10=mlm.norm_phone10(owner_row.phone_number))
   OR (b.name_norm IS NOT NULL AND b.name_norm=mlm.norm_name(owner_row.first_name||' '||owner_row.last_name)
     AND (b.birthdate IS NULL OR (owner_row.birthday IS NOT NULL AND b.birthdate=owner_row.birthday)))) THEN
  RAISE EXCEPTION 'referral_owner_restricted';
 END IF;
 IF EXISTS(SELECT 1 FROM mlm.affiliate a WHERE a.person_id=owner_id) THEN
  RETURN QUERY SELECT ''::text,''::text,true;
  RETURN;
 END IF;

 IF p_ref IS NOT NULL THEN
  IF pg_catalog.length(p_ref) NOT BETWEEN 1 AND 64 OR p_ref ~ '[[:space:][:cntrl:]]'
    OR p_side IS NULL OR p_side NOT IN ('','L','R') THEN
   RAISE EXCEPTION 'invalid_referral_code';
  END IF;
  -- Exact legacy match, then case-insensitive legacy, then MP{id}. Ambiguous
  -- matches at the winning priority fail closed, rather than pick an arbitrary
  -- sponsor. Numeric text comparison avoids attacker-controlled bigint casts.
  WITH candidates AS (
   SELECT a.id,CASE WHEN a.invitation_link=p_ref THEN 1
     WHEN pg_catalog.lower(a.invitation_link)=pg_catalog.lower(p_ref) THEN 2 ELSE 3 END AS priority
   FROM mlm.affiliate a JOIN mlm.person p ON p.id=a.person_id
   WHERE (pg_catalog.lower(a.invitation_link)=pg_catalog.lower(p_ref)
     OR (p_ref ~ '^[Mm][Pp][0-9]+$' AND a.id::text=pg_catalog.ltrim(pg_catalog.substr(p_ref,3),'0')))
   AND a.status::text='active' AND p.status::text='active' AND NOT COALESCE(p.blacklisted,false)
   AND NOT EXISTS(SELECT 1 FROM mlm.blacklist b
    WHERE (b.email_norm IS NOT NULL AND b.email_norm=mlm.norm_email(p.email))
     OR (b.phone_last10 IS NOT NULL AND b.phone_last10=mlm.norm_phone10(p.phone_number))
     OR (b.name_norm IS NOT NULL AND b.name_norm=mlm.norm_name(p.first_name||' '||p.last_name)
      AND (b.birthdate IS NULL OR (p.birthday IS NOT NULL AND b.birthdate=p.birthday))))
  ) SELECT pg_catalog.min(c.id),pg_catalog.count(*) INTO sponsor_id,sponsor_count
    FROM candidates c WHERE c.priority=(SELECT pg_catalog.min(c2.priority) FROM candidates c2);
  IF sponsor_count<>1 THEN RAISE EXCEPTION 'invalid_referral_code'; END IF;
  INSERT INTO payments.registration_referral AS rr
   (email_norm,referral_code,sponsor_affiliate_id,preferred_side,source,created_at,updated_at,consumed_at)
  VALUES(p_email,p_ref,sponsor_id,NULLIF(p_side,''),'verified_login',pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),NULL)
  ON CONFLICT(email_norm) DO UPDATE SET referral_code=EXCLUDED.referral_code,
   sponsor_affiliate_id=EXCLUDED.sponsor_affiliate_id,preferred_side=EXCLUDED.preferred_side,
   source=EXCLUDED.source,updated_at=pg_catalog.clock_timestamp(),consumed_at=NULL;
 END IF;
 SELECT rr.referral_code,COALESCE(rr.preferred_side,'')::text AS side INTO stored
 FROM payments.registration_referral rr JOIN mlm.affiliate a ON a.id=rr.sponsor_affiliate_id
 JOIN mlm.person p ON p.id=a.person_id
 WHERE rr.email_norm=p_email AND rr.consumed_at IS NULL AND rr.updated_at>=pg_catalog.now()-interval '30 days'
 AND a.status::text='active' AND p.status::text='active' AND NOT COALESCE(p.blacklisted,false)
 AND NOT EXISTS(SELECT 1 FROM mlm.blacklist b
  WHERE (b.email_norm IS NOT NULL AND b.email_norm=mlm.norm_email(p.email))
   OR (b.phone_last10 IS NOT NULL AND b.phone_last10=mlm.norm_phone10(p.phone_number))
   OR (b.name_norm IS NOT NULL AND b.name_norm=mlm.norm_name(p.first_name||' '||p.last_name)
    AND (b.birthdate IS NULL OR (p.birthday IS NOT NULL AND b.birthdate=p.birthday))));
 IF FOUND THEN
  RETURN QUERY SELECT stored.referral_code::text,stored.side::text,false;
 ELSE
  RETURN QUERY SELECT ''::text,''::text,false;
 END IF;
END $function$;
REVOKE ALL ON FUNCTION payments.verified_registration_referral(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION payments.verified_registration_referral(text,text,text,text) TO mindbliss_go_payments_reader_v1;
GRANT CREATE ON SCHEMA payments TO mindbliss_referral_owner_20261103;
GRANT mindbliss_referral_owner_20261103 TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
ALTER FUNCTION payments.verified_registration_referral(text,text,text,text) OWNER TO mindbliss_referral_owner_20261103;
REVOKE CREATE ON SCHEMA payments FROM mindbliss_referral_owner_20261103;
GRANT mindbliss_referral_owner_20261103 TO CURRENT_USER WITH INHERIT FALSE, SET FALSE;
COMMIT;
