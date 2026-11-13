import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
// Build-time Unicode whitelist, independent of the database's locale/ctype.
// Categories L and M are taken from this reviewed Node Unicode version.
assert.equal(process.versions.unicode, '17.0');
const ranges = [], letters = []; let begin = -1, end = -1, lbegin = -1, lend = -1;
const flush = (out, start, finish) => { if (start >= 0) out.push(start === finish ? escape(start) : `${escape(start)}-${escape(finish)}`); };
const escape = value => value <= 65535 ? `\\${value.toString(16).padStart(4,'0')}` : `\\+${value.toString(16).padStart(6,'0')}`;
for (let value = 1; value <= 0x10ffff; value++) {
  const character = String.fromCodePoint(value), allowed = /[\p{L}\p{M}]/u.test(character), letter = /\p{L}/u.test(character);
  if (allowed) { if (begin < 0) begin = value; end = value; } else if (begin >= 0) { flush(ranges, begin, end); begin = -1; }
  if (letter) { if (lbegin < 0) lbegin = value; lend = value; } else if (lbegin >= 0) { flush(letters, lbegin, lend); lbegin = -1; }
}
flush(ranges,begin,end);flush(letters,lbegin,lend);
const cls = ranges.join(''), letterClass = letters.join('');
const sql = `-- Own profile only: display name/contact metadata, not authentication identities.
-- Unicode17.0 L/M whitelist generated offline; no locale-dependent name classification.
-- No row backfill, new table, payment, wallet, role, position, email or verified-phone change.
BEGIN;
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='2min';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-member-profile-v1',0));
DO $preflight$
DECLARE v_owner oid;item record;
BEGIN
 IF pg_catalog.current_database()<>'mindbliss_curated_20261025' OR pg_catalog.pg_is_in_recovery()
  OR pg_catalog.current_setting('server_encoding')<>'UTF8'
  OR pg_catalog.md5(pg_catalog.pg_get_functiondef('identity.require_administrative_native_session(text,text)'::regprocedure))<>'01bb63725c11ae353cb768a42ffa9485'
  OR pg_catalog.to_regprocedure('identity.read_member_profile(text,text)') IS NOT NULL
  OR pg_catalog.to_regprocedure('identity.update_member_profile(text,text,text,text,text)') IS NOT NULL THEN
  RAISE EXCEPTION 'member_profile_requires_fresh_review';END IF;
 SELECT proowner INTO v_owner FROM pg_catalog.pg_proc WHERE oid='identity.require_administrative_native_session(text,text)'::regprocedure;
 IF NOT pg_catalog.pg_has_role(v_owner,'USAGE') OR NOT pg_catalog.has_schema_privilege('mindbliss_auth_core_v1','identity','USAGE')
  OR NOT pg_catalog.has_table_privilege(v_owner,'identity.auth_binding','SELECT')
  OR NOT pg_catalog.has_any_column_privilege(v_owner,'identity.auth_binding','UPDATE')
  OR NOT pg_catalog.has_table_privilege(v_owner,'mlm.person','SELECT')
  OR NOT pg_catalog.has_table_privilege(v_owner,'mlm.affiliate','SELECT')
  OR NOT pg_catalog.has_table_privilege(v_owner,'auth.user','SELECT') THEN
  RAISE EXCEPTION 'member_profile_existing_owner_policy_required';END IF;
 FOR item IN SELECT * FROM (VALUES('mlm.person','first_name'),('mlm.person','last_name'),('mlm.person','phone_number'),('mlm.person','country'),('mlm.person','updated_at'),
  ('auth.user','name'),('auth.user','contact_phone_e164'),('auth.user','updated_at')) x(relation_name,column_name) LOOP
  IF NOT pg_catalog.has_column_privilege(v_owner,item.relation_name,item.column_name,'UPDATE') THEN
   RAISE EXCEPTION 'member_profile_existing_owner_policy_required';END IF;
 END LOOP;
 IF(SELECT count(*) FROM pg_catalog.pg_attribute WHERE attrelid='mlm.person'::regclass AND NOT attisdropped AND attnum>0
   AND attname IN('first_name','last_name','phone_number','country','payout_wallet_usdc') AND atttypid='text'::regtype)<>5
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='auth.user'::regclass AND attname='contact_phone_e164' AND atttypid='text'::regtype AND NOT attisdropped) THEN
  RAISE EXCEPTION 'member_profile_existing_schema_required';END IF;
END $preflight$;

CREATE FUNCTION identity.read_member_profile(p_subject text,p_session text)
RETURNS TABLE(first_name text,last_name text,phone text,country text,payout_wallet_usdc text,sponsor_name text,sponsor_referral_code text,referral_code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_native timestamptz;r record;v_sponsor_name text;v_sponsor_code text;v_referral text;
BEGIN
 BEGIN v_native:=identity.require_administrative_native_session(p_subject,p_session);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'member_profile_forbidden' USING ERRCODE='28000';END;
 BEGIN
  SELECT p.id,p.first_name,p.last_name,p.phone_number,p.country,p.payout_wallet_usdc INTO STRICT r
  FROM auth."user" u JOIN identity.auth_binding b ON b.subject=u.id AND b.provider='better_auth'
  JOIN mlm.person p ON p.id=b.person_id AND p.user_id=u.id
  WHERE u.id=p_subject AND u.email_verified=true AND p.public_id IS NOT NULL AND p.status::text IN('pending','active')
   AND NOT coalesce(p.blacklisted,false) AND lower(btrim(p.email::text))=lower(btrim(u.email))
  FOR SHARE OF u,b,p;
 EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN RAISE EXCEPTION 'member_profile_forbidden' USING ERRCODE='28000';END;
 -- Sponsor is recruitment, never the binary placement parent.
 BEGIN
  SELECT btrim(concat_ws(' ',sp.first_name,sp.last_name)),sa.invitation_link,a.invitation_link
   INTO STRICT v_sponsor_name,v_sponsor_code,v_referral FROM mlm.affiliate a
   LEFT JOIN mlm.affiliate sa ON sa.id=a.sponsor_id LEFT JOIN mlm.person sp ON sp.id=sa.person_id
   WHERE a.person_id=r.id;
 EXCEPTION WHEN NO_DATA_FOUND THEN v_sponsor_name:=NULL;v_sponsor_code:=NULL;v_referral:=NULL;
  WHEN TOO_MANY_ROWS THEN RAISE EXCEPTION 'member_profile_forbidden' USING ERRCODE='28000';END;
 IF v_native<=clock_timestamp() THEN RAISE EXCEPTION 'member_profile_forbidden' USING ERRCODE='28000';END IF;
 RETURN QUERY SELECT coalesce(r.first_name,''),coalesce(r.last_name,''),coalesce(r.phone_number,''),coalesce(r.country,''),coalesce(r.payout_wallet_usdc,''),
  coalesce(v_sponsor_name,''),coalesce(v_sponsor_code,''),coalesce(v_referral,'');
END $function$;

CREATE FUNCTION identity.update_member_profile(p_subject text,p_session text,p_name text,p_phone text,p_country text)
RETURNS TABLE(first_name text,last_name text,phone text,country text,payout_wallet_usdc text,sponsor_name text,sponsor_referral_code text,referral_code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE v_native timestamptz;v_name text;v_first text;v_last text;v_country text;v_rows bigint;r record;
BEGIN
 IF p_name IS NULL OR length(p_name) NOT BETWEEN 1 AND 512 OR p_name ~ U&'[\\0001-\\001f\\007f-\\009f]'
  OR p_phone IS NULL OR length(p_phone)>16 OR p_phone ~ U&'[\\0001-\\001f\\007f-\\009f]' OR(p_phone<>'' AND p_phone !~ '^\\+[1-9][0-9]{6,14}$')
  OR(p_country IS NOT NULL AND(length(p_country)>2 OR p_country ~ U&'[\\0001-\\001f\\007f-\\009f]' OR(p_country<>'' AND p_country !~ '^[A-Z]{2}$'))) THEN
  RAISE EXCEPTION 'member_profile_invalid_request' USING ERRCODE='22023';END IF;
 v_name:=btrim(pg_catalog.regexp_replace(pg_catalog.normalize(p_name,'NFC'),' +',' ','g'));
 IF length(v_name) NOT BETWEEN 1 AND 160 OR(v_name COLLATE pg_catalog."C") !~ U&'^[${cls} .\\2019''-]+$'
  OR(v_name COLLATE pg_catalog."C") !~ U&'[${letterClass}]' THEN
  RAISE EXCEPTION 'member_profile_invalid_request' USING ERRCODE='22023';END IF;
 v_first:=pg_catalog.split_part(v_name,' ',1);v_last:=CASE WHEN pg_catalog.strpos(v_name,' ')=0 THEN '' ELSE pg_catalog.substr(v_name,pg_catalog.strpos(v_name,' ')+1) END;
 -- Serialize only this new writer before taking mutable person/user locks.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member-profile-owner:'||coalesce(p_subject,''),0));
 BEGIN v_native:=identity.require_administrative_native_session(p_subject,p_session);
 EXCEPTION WHEN SQLSTATE '28000' THEN RAISE EXCEPTION 'member_profile_forbidden' USING ERRCODE='28000';END;
 BEGIN
  SELECT p.id,p.country INTO STRICT r
  FROM auth."user" u JOIN identity.auth_binding b ON b.subject=u.id AND b.provider='better_auth'
  JOIN mlm.person p ON p.id=b.person_id AND p.user_id=u.id
  WHERE u.id=p_subject AND u.email_verified=true AND p.public_id IS NOT NULL AND p.status::text IN('pending','active')
   AND NOT coalesce(p.blacklisted,false) AND lower(btrim(p.email::text))=lower(btrim(u.email))
  FOR UPDATE OF u,p FOR SHARE OF b;
 EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN RAISE EXCEPTION 'member_profile_forbidden' USING ERRCODE='28000';END;
 IF v_native<=clock_timestamp() THEN RAISE EXCEPTION 'member_profile_forbidden' USING ERRCODE='28000';END IF;
 v_country:=CASE WHEN p_country IS NULL THEN r.country ELSE p_country END;
 UPDATE mlm.person p SET first_name=v_first,last_name=v_last,phone_number=p_phone,country=v_country,updated_at=clock_timestamp()
  WHERE p.id=r.id AND p.user_id=p_subject;
 GET DIAGNOSTICS v_rows=ROW_COUNT;
 IF v_rows<>1 THEN RAISE EXCEPTION 'member_profile_unavailable';END IF;
 UPDATE auth."user" u SET name=v_name,contact_phone_e164=NULLIF(p_phone,''),updated_at=clock_timestamp() WHERE u.id=p_subject;
 GET DIAGNOSTICS v_rows=ROW_COUNT;
 IF v_rows<>1 THEN RAISE EXCEPTION 'member_profile_unavailable';END IF;
 RETURN QUERY SELECT * FROM identity.read_member_profile(p_subject,p_session);
END $function$;

DO $owners$
DECLARE v_owner text;v_signature text;item record;
BEGIN
 SELECT pg_catalog.pg_get_userbyid(proowner) INTO v_owner FROM pg_catalog.pg_proc WHERE oid='identity.require_administrative_native_session(text,text)'::regprocedure;
 FOREACH v_signature IN ARRAY ARRAY['identity.read_member_profile(text,text)','identity.update_member_profile(text,text,text,text,text)'] LOOP
  EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO %I',v_signature,v_owner);
  EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,mindbliss_auth_core_v1',v_signature);
  FOR item IN SELECT DISTINCT a.grantee FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a WHERE p.oid=v_signature::regprocedure AND a.grantee<>p.proowner LOOP
   EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I',v_signature,pg_catalog.pg_get_userbyid(item.grantee));
  END LOOP;
  EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO mindbliss_auth_core_v1',v_signature);
 END LOOP;
END $owners$;
DO $verify$
DECLARE v_owner oid;v_signature text;
BEGIN
 SELECT proowner INTO v_owner FROM pg_catalog.pg_proc WHERE oid='identity.require_administrative_native_session(text,text)'::regprocedure;
 FOREACH v_signature IN ARRAY ARRAY['identity.read_member_profile(text,text)','identity.update_member_profile(text,text,text,text,text)'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid=v_signature::regprocedure AND proowner=v_owner AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog']::text[])
   OR NOT pg_catalog.has_function_privilege('mindbliss_auth_core_v1',v_signature,'EXECUTE')
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a WHERE p.oid=v_signature::regprocedure AND a.grantee<>p.proowner AND a.grantee<>'mindbliss_auth_core_v1'::regrole) THEN
   RAISE EXCEPTION 'member_profile_isolation_failed';END IF;
 END LOOP;
END $verify$;
COMMIT;
`;
await writeFile(new URL('../_meta/migration/115_native_member_profile.sql',import.meta.url),sql,{flag:'w'});
