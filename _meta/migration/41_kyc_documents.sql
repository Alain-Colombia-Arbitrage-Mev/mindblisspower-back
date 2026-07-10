-- 41_kyc_documents.sql — documentos KYC subidos por el miembro (S3 + registro).
-- Owned by vp-payments. Apply: psql -U migrator -d vicionpower -f 41_kyc_documents.sql
-- Pre-req: schema_mlm.sql (mlm.person con kyc_status).
-- Flujo: upload-url (pending_upload) → PUT presignado a S3 → confirm (in_review;
-- person.kyc_status pasa a in_review) → revisión admin (approved/rejected).
SET search_path = mlm, public;

CREATE TABLE IF NOT EXISTS mlm.kyc_document (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  person_id     bigint NOT NULL REFERENCES mlm.person(id),
  doc_type      text   NOT NULL CHECK (doc_type IN ('identity_card','passport','proof_address','selfie')),
  original_name text   NOT NULL,
  mime_type     text   NOT NULL CHECK (mime_type IN ('application/pdf','image/jpeg','image/png')),
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 15728640), -- 15 MB
  storage_key   text   NOT NULL UNIQUE,           -- clave S3 (bucket privado, SSE)
  status        text   NOT NULL DEFAULT 'pending_upload'
                CHECK (status IN ('pending_upload','in_review','approved','rejected')),
  reject_reason text,
  reviewed_by   bigint REFERENCES mlm.person(id),
  reviewed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kyc_document_person_idx ON mlm.kyc_document(person_id, created_at DESC);
CREATE INDEX IF NOT EXISTS kyc_document_review_idx ON mlm.kyc_document(status) WHERE status = 'in_review';

-- vp-payments (rol vp_engine) crea/confirma/lista; el BFF read-only puede listar.
-- Condicional para que la migración corra igual en dev (sin esos roles) y en RDS.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vp_engine') THEN
    GRANT SELECT, INSERT, UPDATE ON mlm.kyc_document TO vp_engine;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_read') THEN
    GRANT SELECT ON mlm.kyc_document TO app_read;
  END IF;
END $$;
