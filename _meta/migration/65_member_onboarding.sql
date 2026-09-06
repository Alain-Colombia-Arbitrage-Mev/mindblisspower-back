-- 65_member_onboarding.sql — perfil privado de onboarding del miembro.
--
-- Separa documento, fecha de nacimiento, dirección y preferencias del registro
-- general de mlm.person. Sólo vp_engine puede leer o escribir esta tabla; no se
-- concede acceso al rol read-only usado por paneles/reportes.
SET search_path = mlm, public;

CREATE TABLE IF NOT EXISTS mlm.member_onboarding (
  person_id               bigint PRIMARY KEY REFERENCES mlm.person(id) ON DELETE CASCADE,
  city                    text CHECK (city IS NULL OR char_length(city) <= 120),
  document_type           text CHECK (document_type IS NULL OR document_type IN ('cc','ce','passport','dni')),
  document_number         text CHECK (document_number IS NULL OR char_length(document_number) BETWEEN 3 AND 40),
  birth_date              date CHECK (birth_date IS NULL OR birth_date >= DATE '1900-01-01'),
  address                 text CHECK (address IS NULL OR char_length(address) <= 240),
  preferred_language      text NOT NULL DEFAULT 'es'
                          CHECK (preferred_language IN ('es','en','pt')),
  communication_channel   text NOT NULL DEFAULT 'whatsapp'
                          CHECK (communication_channel IN ('whatsapp','email','phone')),
  member_interest         text NOT NULL DEFAULT 'wellbeing'
                          CHECK (member_interest IN ('wellbeing','products','community','education')),
  support_needs           text CHECK (support_needs IS NULL OR char_length(support_needs) <= 1000),
  accepts_privacy         boolean NOT NULL DEFAULT false,
  accepts_communications  boolean NOT NULL DEFAULT false,
  privacy_accepted_at     timestamptz,
  completed_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON mlm.member_onboarding FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vp_engine') THEN
    GRANT SELECT, INSERT, UPDATE ON mlm.member_onboarding TO vp_engine;
  END IF;
END $$;
