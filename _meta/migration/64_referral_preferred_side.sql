-- Migration 64 — preferred binary placement side
-- Persists which of the sponsor's two links (left/right) a new member used.
-- The sponsor remains the commercial referrer; parent_id is resolved at payment
-- activation by following the requested side until the first available slot.

ALTER TABLE payments.registration_referral
  ADD COLUMN IF NOT EXISTS preferred_side char(1);

ALTER TABLE payments.purchase_intent
  ADD COLUMN IF NOT EXISTS preferred_side char(1);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'registration_referral_preferred_side_check'
       AND conrelid = 'payments.registration_referral'::regclass
  ) THEN
    ALTER TABLE payments.registration_referral
      ADD CONSTRAINT registration_referral_preferred_side_check
      CHECK (preferred_side IS NULL OR preferred_side IN ('L','R'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'purchase_intent_preferred_side_check'
       AND conrelid = 'payments.purchase_intent'::regclass
  ) THEN
    ALTER TABLE payments.purchase_intent
      ADD CONSTRAINT purchase_intent_preferred_side_check
      CHECK (preferred_side IS NULL OR preferred_side IN ('L','R'));
  END IF;
END $$;

COMMENT ON COLUMN payments.registration_referral.preferred_side IS
  'Requested sponsor leg from the registration link: L or R; null keeps legacy weak-leg placement.';

COMMENT ON COLUMN payments.purchase_intent.preferred_side IS
  'Placement side snapshot used atomically when the paid buyer enters the binary tree.';
