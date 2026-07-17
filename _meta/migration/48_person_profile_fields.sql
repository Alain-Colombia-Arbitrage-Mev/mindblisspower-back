-- 48_person_profile_fields.sql — campos editables del perfil del miembro.
-- Owned by vp-payments. El miembro edita país y su billetera de retiro USDC
-- (ERC-20) desde /dashboard/profile → POST /api/member/profile.
-- phone_number y first_name/last_name ya existen.
ALTER TABLE mlm.person
  ADD COLUMN IF NOT EXISTS country            text,
  ADD COLUMN IF NOT EXISTS payout_wallet_usdc text;

-- vp_engine ya tiene INSERT,UPDATE en mlm.person (migración 47).
