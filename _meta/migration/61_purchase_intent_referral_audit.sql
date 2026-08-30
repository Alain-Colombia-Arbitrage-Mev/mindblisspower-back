-- 61_purchase_intent_referral_audit.sql
-- Trazabilidad del código de referido usado al crear checkout.
-- Antes sólo persistíamos sponsor_affiliate_id; si el navegador mandaba un
-- código stale pero resoluble, no quedaba forma de auditar qué código llegó.

ALTER TABLE payments.purchase_intent
  ADD COLUMN IF NOT EXISTS referral_code text;

CREATE INDEX IF NOT EXISTS purchase_intent_referral_code_idx
  ON payments.purchase_intent (lower(referral_code))
  WHERE referral_code IS NOT NULL AND referral_code <> '';
