-- Migration 62 — registration referral attribution
-- Persists the referral code captured during signup so checkout does not depend
-- only on browser storage when the user later pays from another session/device.

CREATE TABLE IF NOT EXISTS payments.registration_referral (
  email_norm           text PRIMARY KEY,
  referral_code        text NOT NULL CHECK (length(btrim(referral_code)) BETWEEN 1 AND 64),
  sponsor_affiliate_id bigint NOT NULL,
  source               text NOT NULL DEFAULT 'register',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  consumed_at          timestamptz
);

CREATE INDEX IF NOT EXISTS registration_referral_sponsor_idx
  ON payments.registration_referral (sponsor_affiliate_id);

CREATE INDEX IF NOT EXISTS registration_referral_updated_idx
  ON payments.registration_referral (updated_at);

GRANT SELECT, INSERT, UPDATE ON payments.registration_referral TO vp_engine;
