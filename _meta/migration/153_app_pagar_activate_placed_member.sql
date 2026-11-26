-- A newly registered person starts pending. The member tree masks pending
-- profiles even when they have a binary node. Publish the profile and its
-- new position atomically after the first complete Pagar receipt.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

DO $install$
DECLARE
  v_owner oid;
  v_definition text;
  v_anchor text:=$anchor$      FROM legs l WHERE l.id=a.id;
      RETURN v_affiliate;$anchor$;
  v_replacement text:=$replacement$      FROM legs l WHERE l.id=a.id;

      UPDATE mlm.person p
      SET status='active',updated_at=clock_timestamp()
      WHERE p.id=v_person AND p.status='pending';
      RETURN v_affiliate;$replacement$;
BEGIN
  IF current_database()<>'mindbliss_curated_20261025' OR pg_is_in_recovery()
    OR to_regclass('payments.app_pagar_first_placement') IS NULL THEN
    RAISE EXCEPTION 'app_pagar_member_activation_requires_first_placement';
  END IF;

  SELECT proowner INTO STRICT v_owner FROM pg_proc
  WHERE oid='payments.queue_first_app_pagar_placement_v1()'::regprocedure;
  IF NOT has_column_privilege(v_owner,'mlm.person','status','SELECT')
    OR NOT has_column_privilege(v_owner,'mlm.person','status','UPDATE')
    OR NOT has_column_privilege(v_owner,'mlm.person','updated_at','UPDATE') THEN
    RAISE EXCEPTION 'app_pagar_member_activation_owner_permissions_required';
  END IF;

  v_definition:=pg_get_functiondef('payments.place_first_app_pagar_v1(text,uuid)'::regprocedure);
  IF cardinality(string_to_array(v_definition,v_anchor))<>2 THEN
    RAISE EXCEPTION 'app_pagar_member_activation_placement_definition_changed';
  END IF;
  EXECUTE replace(v_definition,v_anchor,v_replacement);
END $install$;

COMMIT;
