-- 20260830_repair_purchase_intent_user_identity.sql
-- One-time production repair:
-- purchase_intent.user_id was stale, while person_id and affiliate_id already
-- pointed to the real buyer. This keeps payment ownership aligned with the
-- authoritative mlm.person email without moving tree position, packages or PV.

\set ON_ERROR_STOP on
\pset pager off

BEGIN;

DO $$
DECLARE
  v_rows integer;
BEGIN
  SELECT count(*)
    INTO v_rows
    FROM payments.purchase_intent pi
    JOIN mlm.person p ON p.id = pi.person_id
    JOIN mlm.affiliate a ON a.id = pi.affiliate_id
   WHERE pi.id = 'e1af4c89-209a-4156-934b-cbc06428a9a1'::uuid
     AND pi.status = 'activated'
     AND pi.stripe_present IS TRUE
     AND p.email::text = 'ysrojas4@gmail.com'
     AND pi.user_id = 'watermelon246@icloud.com'
     AND a.person_id = pi.person_id
     AND EXISTS (
       SELECT 1
         FROM mlm.affiliate_package ap
        WHERE ap.affiliate_id = pi.affiliate_id
          AND ap.transaction_hash = pi.stripe_payment_intent_id
          AND ap.status::text = 'active'
     )
     AND EXISTS (
       SELECT 1
         FROM mlm.tree_event te
        WHERE te.external_ref = 'package_purchase:' || pi.stripe_payment_intent_id
          AND te.kind::text = 'pv_credit'
     );

  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one safe purchase_intent candidate, found %', v_rows;
  END IF;
END $$;

UPDATE payments.purchase_intent pi
   SET user_id = p.email::text,
       updated_at = now()
  FROM mlm.person p
 WHERE pi.id = 'e1af4c89-209a-4156-934b-cbc06428a9a1'::uuid
   AND p.id = pi.person_id
RETURNING pi.id,
          pi.user_id AS repaired_user_id,
          p.email::text AS authoritative_email,
          pi.person_id,
          pi.affiliate_id,
          pi.status,
          pi.stripe_present;

COMMIT;
