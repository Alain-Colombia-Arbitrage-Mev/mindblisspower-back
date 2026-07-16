-- 46_kyc_ocr.sql — validación OCR de documentos KYC (pasaporte).
-- Owned by vp-payments. Pre-req: 41_kyc_documents.sql.
-- El OCR (OpenRouter vision) valida que un pasaporte sea pasaporte, esté vigente
-- y que los datos coincidan; si pasa, auto-aprueba. Fallo/ilegible → in_review.
SET search_path = mlm, public;

ALTER TABLE mlm.kyc_document
  ADD COLUMN IF NOT EXISTS ocr_status text NOT NULL DEFAULT 'skipped'
      CHECK (ocr_status IN ('skipped','pending','passed','failed','error')),
  ADD COLUMN IF NOT EXISTS ocr_result    jsonb,
  ADD COLUMN IF NOT EXISTS ocr_reason    text,
  ADD COLUMN IF NOT EXISTS doc_expiry    date,
  ADD COLUMN IF NOT EXISTS ocr_checked_at timestamptz;

-- Sweep de respaldo: documentos con OCR pendiente (reintento tras reinicio).
CREATE INDEX IF NOT EXISTS kyc_document_ocr_pending_idx
  ON mlm.kyc_document(created_at) WHERE ocr_status = 'pending';
