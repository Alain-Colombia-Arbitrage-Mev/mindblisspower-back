BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

DO $preflight$
BEGIN
  IF current_database()<>'mindbliss_curated_20261025' OR pg_is_in_recovery()
    OR NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgrelid='payments.app_pagar_accounting_receipt'::regclass
        AND tgfoid='payments.require_app_pagar_full_receipt_v1()'::regprocedure
        AND tgenabled IN ('O','A')
    ) THEN
    RAISE EXCEPTION 'app_pagar_placement_requires_full_receipt_guard';
  END IF;
END $preflight$;

CREATE TABLE payments.app_pagar_first_placement (
  subject text PRIMARY KEY,
  payment_id uuid NOT NULL UNIQUE REFERENCES payments.app_pagar_accounting_receipt(payment_id),
  affiliate_id bigint REFERENCES mlm.affiliate(id),
  assigned_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((affiliate_id IS NULL)=(assigned_at IS NULL))
);
ALTER TABLE payments.app_pagar_first_placement ENABLE ROW LEVEL SECURITY;
CREATE INDEX app_pagar_first_placement_due_idx
  ON payments.app_pagar_first_placement(next_attempt_at,subject) WHERE affiliate_id IS NULL;

-- The existing affiliate path trigger resolves ltree from public. That schema
-- is owned by the database owner and the App runtime has USAGE only.
CREATE FUNCTION payments.place_first_app_pagar_v1(p_subject text,p_payment uuid)
RETURNS bigint LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp SET lock_timeout='150ms' AS $function$
DECLARE
  v_person bigint;
  v_affiliate bigint;
  v_status text;
  v_sponsor bigint;
BEGIN
  IF EXISTS(SELECT 1 FROM payments.app_pagar_economic_hold h WHERE h.payment_id=p_payment) THEN
    RETURN NULL;
  END IF;

  -- Referral capture and legacy activation serialize on the same person.
  SELECT p.id INTO v_person
  FROM auth."user" u
  JOIN identity.auth_binding b ON b.subject=u.id AND b.provider='better_auth'
  JOIN mlm.person p ON p.id=b.person_id AND p.user_id=u.id
     AND lower(btrim(u.email))=lower(btrim(p.email::text)) AND p.public_id IS NOT NULL
  WHERE u.id=p_subject AND u.email_verified
  FOR NO KEY UPDATE OF p NOWAIT;
  IF NOT FOUND OR NOT identity.member_referral_person_eligible(v_person) THEN
    RETURN NULL;
  END IF;

  SELECT a.id,a.status::text INTO v_affiliate,v_status FROM mlm.affiliate a WHERE a.person_id=v_person;
  IF FOUND THEN
    RETURN CASE WHEN v_status='active' THEN v_affiliate END;
  END IF;

  SELECT a.id INTO v_sponsor
  FROM identity.member_registration_sponsor r
  JOIN mlm.affiliate a ON a.person_id=r.sponsor_person_id AND a.status::text='active'
  WHERE r.subject=p_subject AND r.person_id=v_person AND a.person_id<>v_person
    AND identity.member_referral_person_eligible(a.person_id)
    AND (r.source='referral' OR
      (r.source='company' AND a.id=r.company_affiliate_id AND a.parent_id IS NULL AND a.sponsor_id IS NULL));
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Lock class 2 and weak-leg ordering match the existing binary engine.
  IF NOT pg_try_advisory_xact_lock(2,v_sponsor::integer) THEN
    RETURN NULL;
  END IF;

  FOR attempt IN 1..16 LOOP
    WITH RECURSIVE walk AS (
      SELECT a.id,a.path,a.depth,
        CASE WHEN a.left_pv_current<a.right_pv_current THEN 'L'
             WHEN a.right_pv_current<a.left_pv_current THEN 'R'
             WHEN a.left_count<=a.right_count THEN 'L' ELSE 'R' END::mlm.tree_position AS side,
        0 AS distance
      FROM mlm.affiliate a WHERE a.id=v_sponsor
      UNION ALL
      SELECT c.id,c.path,c.depth,
        CASE WHEN c.left_pv_current<c.right_pv_current THEN 'L'
             WHEN c.right_pv_current<c.left_pv_current THEN 'R'
             WHEN c.left_count<=c.right_count THEN 'L' ELSE 'R' END::mlm.tree_position,
        w.distance+1
      FROM walk w JOIN mlm.affiliate c ON c.parent_id=w.id AND c.position=w.side
      WHERE w.distance<512
    )
    INSERT INTO mlm.affiliate(person_id,parent_id,position,sponsor_id,path,depth,status)
    SELECT v_person,w.id,w.side,v_sponsor,w.path,w.depth,'active'
    FROM walk w ORDER BY w.distance DESC LIMIT 1
    ON CONFLICT DO NOTHING RETURNING id INTO v_affiliate;
    IF FOUND THEN
      -- Maintain network counts and closure while Pagar PV remains in its own ledger.
      WITH ancestors AS (
        SELECT a.id
        FROM mlm.affiliate a JOIN mlm.affiliate_closure c ON c.ancestor_id=a.id
        WHERE c.descendant_id=v_affiliate AND c.distance>0
        ORDER BY a.depth FOR NO KEY UPDATE OF a
      ), legs AS (
        SELECT a.id,l.position
        FROM ancestors a JOIN mlm.affiliate l ON l.parent_id=a.id
        JOIN mlm.affiliate_closure c ON c.ancestor_id=l.id AND c.descendant_id=v_affiliate
      )
      UPDATE mlm.affiliate a
      SET left_count=a.left_count+CASE WHEN l.position='L' THEN 1 ELSE 0 END,
          right_count=a.right_count+CASE WHEN l.position='R' THEN 1 ELSE 0 END,
          updated_at=clock_timestamp()
      FROM legs l WHERE l.id=a.id;
      RETURN v_affiliate;
    END IF;

    -- A different sponsor's overlapping descent can take the same slot.
    -- A concurrent activation of this person can also finish via another rail.
    SELECT a.id,a.status::text INTO v_affiliate,v_status FROM mlm.affiliate a WHERE a.person_id=v_person;
    IF FOUND THEN
      RETURN CASE WHEN v_status='active' THEN v_affiliate END;
    END IF;
  END LOOP;
  RETURN NULL;
EXCEPTION WHEN lock_not_available OR deadlock_detected OR serialization_failure THEN
  -- The subtransaction rolls back any partial placement. The receipt survives.
  RETURN NULL;
END $function$;

CREATE FUNCTION payments.attempt_first_app_pagar_placement_v1(p_subject text,p_payment uuid)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
DECLARE v_affiliate bigint;
BEGIN
  -- Both callers already own this exact queue row.
  v_affiliate:=payments.place_first_app_pagar_v1(p_subject,p_payment);
  UPDATE payments.app_pagar_first_placement q
  SET affiliate_id=v_affiliate,
      assigned_at=CASE WHEN v_affiliate IS NOT NULL THEN clock_timestamp() END,
      next_attempt_at=clock_timestamp()+interval '5 minutes'
  WHERE q.subject=p_subject AND q.payment_id=p_payment AND q.affiliate_id IS NULL;
END $function$;

CREATE FUNCTION payments.queue_first_app_pagar_placement_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
  INSERT INTO payments.app_pagar_first_placement(subject,payment_id)
    VALUES(NEW.subject,NEW.payment_id)
    ON CONFLICT(subject) DO NOTHING;
  IF FOUND THEN
    PERFORM payments.attempt_first_app_pagar_placement_v1(NEW.subject,NEW.payment_id);
  END IF;
  RETURN NEW;
END $function$;

CREATE TRIGGER app_pagar_queue_first_placement AFTER INSERT ON payments.app_pagar_accounting_receipt
  FOR EACH ROW WHEN (NEW.previous_gross_usd_minor=0)
  EXECUTE FUNCTION payments.queue_first_app_pagar_placement_v1();

CREATE FUNCTION payments.retry_first_app_pagar_placements_v1()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
DECLARE q record;
BEGIN
  FOR q IN
    SELECT p.subject,p.payment_id FROM payments.app_pagar_first_placement p
    WHERE p.affiliate_id IS NULL AND p.next_attempt_at<=statement_timestamp()
    ORDER BY p.next_attempt_at,p.subject LIMIT 4 FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM payments.attempt_first_app_pagar_placement_v1(q.subject,q.payment_id);
  END LOOP;
END $function$;

DO $install$
DECLARE
  v_relation regclass:='payments.app_pagar_first_placement'::regclass;
  v_owner name;
  v_signature text;
  v_grantee text;
  v_definition text;
  v_retry text:='  WITH eligible AS (';
  v_eligibility text:='    WHERE r.confirmed_at<=v_now AND identity.member_referral_person_eligible(p.id)';
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO STRICT v_owner
    FROM pg_class c WHERE c.oid='payments.app_pagar_accounting_receipt'::regclass;
  EXECUTE format('ALTER TABLE %s OWNER TO %I',v_relation,v_owner);
  FOR v_grantee IN
    SELECT DISTINCT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END
    FROM pg_class c,LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid=v_relation AND a.grantee<>c.relowner
  LOOP
    EXECUTE 'REVOKE ALL ON TABLE '||v_relation||' FROM '||v_grantee;
  END LOOP;

  FOREACH v_signature IN ARRAY ARRAY['payments.place_first_app_pagar_v1(text,uuid)',
    'payments.attempt_first_app_pagar_placement_v1(text,uuid)','payments.queue_first_app_pagar_placement_v1()',
    'payments.retry_first_app_pagar_placements_v1()']
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO %I',v_signature,v_owner);
    FOR v_grantee IN
      SELECT DISTINCT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END
      FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid=v_signature::regprocedure AND a.grantee<>p.proowner
    LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION '||v_signature||' FROM '||v_grantee;
    END LOOP;
  END LOOP;

  -- Extend the deployed ROI function in place, preserving its owner, ACL,
  -- execution limits and arithmetic. Activate new receipts after placement.
  v_definition:=pg_get_functiondef('payments.run_app_pagar_roi_v1()'::regprocedure);
  IF cardinality(string_to_array(v_definition,v_retry))<>2
     OR cardinality(string_to_array(v_definition,v_eligibility))<>2 THEN
    RAISE EXCEPTION 'app_pagar_placement_roi_definition_changed';
  END IF;
  v_definition:=replace(v_definition,v_retry,
    '  PERFORM payments.retry_first_app_pagar_placements_v1();'||chr(10)||chr(10)||v_retry);
  v_definition:=replace(v_definition,v_eligibility,v_eligibility||chr(10)||
    '      AND (a.id IS NOT NULL OR NOT EXISTS ('||
    'SELECT 1 FROM payments.app_pagar_first_placement q WHERE q.subject=r.subject))');
  EXECUTE v_definition;
END $install$;

COMMIT;
