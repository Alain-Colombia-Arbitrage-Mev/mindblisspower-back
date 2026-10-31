-- Operator-reviewed missing-schema repair only. Never run at app startup.
-- Layout compatible with migrations 62 + 64, without their legacy writer grants
-- or purchase_intent ALTER. No backfill, attribution, identity or payment write.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='2min';
SELECT pg_advisory_xact_lock(hashtextextended('registration-referral-checkout-reader-v1',0));

CREATE TABLE payments.registration_referral (
  email_norm text PRIMARY KEY,
  referral_code text NOT NULL CHECK(length(btrim(referral_code)) BETWEEN 1 AND 64),
  sponsor_affiliate_id bigint NOT NULL,
  preferred_side char(1),
  source text NOT NULL DEFAULT 'register',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  CONSTRAINT registration_referral_preferred_side_check
    CHECK(preferred_side IS NULL OR preferred_side IN('L','R'))
);
CREATE INDEX registration_referral_sponsor_idx
  ON payments.registration_referral(sponsor_affiliate_id);
CREATE INDEX registration_referral_updated_idx
  ON payments.registration_referral(updated_at);

REVOKE ALL ON payments.registration_referral FROM PUBLIC;
-- The existing report login already has schema USAGE and the sponsor/blacklist
-- reads. LookupRegistrationReferral needs exactly these six columns, not SELECT *.
GRANT SELECT(email_norm,referral_code,sponsor_affiliate_id,preferred_side,updated_at,consumed_at)
  ON payments.registration_referral TO mindbliss_payments_20261025;
COMMIT;
