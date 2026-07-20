-- =============================================================================
-- 50_bmp_account_link.sql — vínculo de email BMP alterno, con aprobación admin
-- =============================================================================
-- Cuando el email de sesión (Cognito) no existe en BMP, el afiliado puede
-- solicitar vincular otro correo. Ese vínculo NO es auto-servicio: requiere
-- aprobación de un admin, porque de lo contrario cualquiera podría apuntar su
-- retiro al email BMP de un tercero y desviar el pago.
--
-- Invariantes (índices parciales únicos — los garantiza la BASE, no el código):
--   - un solo vínculo 'approved' por afiliado
--   - una sola solicitud 'pending_admin' por afiliado
--
-- Un vínculo 'rejected' no participa de ningún índice único: el afiliado puede
-- volver a solicitar tras un rechazo, y el historial de rechazos se conserva.
--
-- Apply: psql -U migrator -d vicionpower -f 50_bmp_account_link.sql
-- Pre-req: schema_mlm.sql (mlm.person, mlm.affiliate).
-- Idempotente (IF NOT EXISTS; el DO/EXCEPTION atrapa duplicate_object del enum).
-- =============================================================================

BEGIN;

DO $$ BEGIN
  CREATE TYPE mlm.bmp_link_status AS ENUM ('pending_admin', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS mlm.bmp_account_link (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  affiliate_id          bigint NOT NULL REFERENCES mlm.affiliate(id),
  bmp_email             text   NOT NULL,
  status                mlm.bmp_link_status NOT NULL DEFAULT 'pending_admin',
  bmp_user_id           text,
  bmp_block_reason      text,
  requested_at          timestamptz NOT NULL DEFAULT now(),
  requested_from_ip     inet,
  reviewed_by_person_id bigint REFERENCES mlm.person(id),
  reviewed_at           timestamptz,
  review_note           text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS bmp_account_link_one_approved
  ON mlm.bmp_account_link (affiliate_id) WHERE status = 'approved';

CREATE UNIQUE INDEX IF NOT EXISTS bmp_account_link_one_pending
  ON mlm.bmp_account_link (affiliate_id) WHERE status = 'pending_admin';

CREATE INDEX IF NOT EXISTS bmp_account_link_pending_queue
  ON mlm.bmp_account_link (requested_at DESC) WHERE status = 'pending_admin';

COMMENT ON TABLE mlm.bmp_account_link IS
  'Vínculo afiliado → email BMP alterno. Requiere aprobación admin (D2).';
COMMENT ON COLUMN mlm.bmp_account_link.bmp_user_id IS
  'userId devuelto por BMP al verificar: ancla estable de identidad para auditoría.';

-- vp-payments (rol vp_engine) solicita/lista/revisa; el BFF read-only lista.
-- Condicional para que la migración corra igual en dev (sin esos roles) y en RDS.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vp_engine') THEN
    GRANT SELECT, INSERT, UPDATE ON mlm.bmp_account_link TO vp_engine;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_read') THEN
    GRANT SELECT ON mlm.bmp_account_link TO app_read;
  END IF;
END $$;

COMMIT;
