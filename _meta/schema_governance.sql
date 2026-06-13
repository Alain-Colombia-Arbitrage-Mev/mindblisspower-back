-- =============================================================================
-- VicionPower — Schema de governance (ADR 0009 retention + ADR 0010 four-eyes)
--
-- Pre-req: schema_mlm.sql ya aplicado.
-- Run: psql -U migrator -d vicionpower -f schema_governance.sql
-- =============================================================================

SET search_path = mlm, public;

-- =============================================================================
-- 1. APPROVAL_REQUEST (ADR 0010 — four-eyes)
-- =============================================================================

CREATE TYPE mlm.approval_status AS ENUM (
  'pending', 'approved', 'rejected', 'expired', 'executed'
);

CREATE TYPE mlm.approval_operation_type AS ENUM (
  'manual_adjustment',
  'reversal',
  'withdrawal_approve',
  'kyc_override',
  'blacklist_remove',
  'admin_promote',
  'tree_relocate',
  'concept_modify',
  'crypto_whitelist',
  'bulk_operation',
  'ddl_production',
  'secret_rotation',
  'plan_config_publish'  -- ADR-0010 + Capa 3: publicar config de comisiones (editor four-eyes)
);

CREATE TABLE mlm.approval_request (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_type          mlm.approval_operation_type NOT NULL,
  payload                 jsonb NOT NULL,
  -- payload contiene:
  --   { amount_usd: ..., target_person_id: ..., target_wallet_id: ...,
  --     concept_id: ..., reason_long: ..., metadata: { ... } }
  amount_usd              numeric(14,2),  -- denorm para queries de threshold
  requires_n_approvers    smallint NOT NULL CHECK (requires_n_approvers BETWEEN 1 AND 3),

  status                  mlm.approval_status NOT NULL DEFAULT 'pending',

  initiator_person_id     bigint NOT NULL REFERENCES mlm.person(id),
  initiator_reason        text NOT NULL CHECK (length(initiator_reason) >= 10),

  approver_1_person_id    bigint REFERENCES mlm.person(id),
  approver_1_at           timestamptz,
  approver_1_reason       text,
  approver_1_decision     text CHECK (approver_1_decision IN ('approve','reject') OR approver_1_decision IS NULL),

  approver_2_person_id    bigint REFERENCES mlm.person(id),
  approver_2_at           timestamptz,
  approver_2_reason       text,
  approver_2_decision     text CHECK (approver_2_decision IN ('approve','reject') OR approver_2_decision IS NULL),

  approver_3_person_id    bigint REFERENCES mlm.person(id),
  approver_3_at           timestamptz,
  approver_3_reason       text,
  approver_3_decision     text CHECK (approver_3_decision IN ('approve','reject') OR approver_3_decision IS NULL),

  cooling_off_until       timestamptz,  -- para ops > $100k, fecha mínima de ejecución
  created_at              timestamptz NOT NULL DEFAULT now(),
  expires_at              timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  executed_at             timestamptz,
  executed_txn_id         uuid REFERENCES mlm.transaction(id),

  -- Constraints DB-enforced
  CONSTRAINT approval_initiator_not_approver_1
    CHECK (approver_1_person_id IS NULL OR approver_1_person_id <> initiator_person_id),
  CONSTRAINT approval_initiator_not_approver_2
    CHECK (approver_2_person_id IS NULL OR approver_2_person_id <> initiator_person_id),
  CONSTRAINT approval_initiator_not_approver_3
    CHECK (approver_3_person_id IS NULL OR approver_3_person_id <> initiator_person_id),
  CONSTRAINT approval_distinct_approvers
    CHECK (
      (approver_1_person_id IS NULL OR approver_2_person_id IS NULL OR approver_1_person_id <> approver_2_person_id)
      AND
      (approver_1_person_id IS NULL OR approver_3_person_id IS NULL OR approver_1_person_id <> approver_3_person_id)
      AND
      (approver_2_person_id IS NULL OR approver_3_person_id IS NULL OR approver_2_person_id <> approver_3_person_id)
    )
);

CREATE INDEX approval_request_status_idx ON mlm.approval_request(status, created_at DESC)
  WHERE status IN ('pending', 'approved');
CREATE INDEX approval_request_initiator_idx ON mlm.approval_request(initiator_person_id, created_at DESC);
CREATE INDEX approval_request_operation_idx ON mlm.approval_request(operation_type, status);

-- ---------------------------------------------------------------------------
-- Trigger: validar que solo admins pueden ser approvers + transitions legales
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mlm.fn_validate_approval_request() RETURNS trigger AS $$
DECLARE
  v_is_admin_approver_1 boolean;
  v_is_admin_approver_2 boolean;
  v_is_admin_approver_3 boolean;
  v_is_admin_initiator  boolean;
BEGIN
  -- Initiator debe ser admin
  SELECT is_admin INTO v_is_admin_initiator FROM mlm.person WHERE id = NEW.initiator_person_id;
  IF v_is_admin_initiator IS NOT TRUE THEN
    RAISE EXCEPTION 'Initiator % is not admin', NEW.initiator_person_id;
  END IF;

  -- Approvers (cuando se asignan) deben ser admins
  IF NEW.approver_1_person_id IS NOT NULL THEN
    SELECT is_admin INTO v_is_admin_approver_1 FROM mlm.person WHERE id = NEW.approver_1_person_id;
    IF v_is_admin_approver_1 IS NOT TRUE THEN
      RAISE EXCEPTION 'Approver 1 (%) is not admin', NEW.approver_1_person_id;
    END IF;
  END IF;
  IF NEW.approver_2_person_id IS NOT NULL THEN
    SELECT is_admin INTO v_is_admin_approver_2 FROM mlm.person WHERE id = NEW.approver_2_person_id;
    IF v_is_admin_approver_2 IS NOT TRUE THEN
      RAISE EXCEPTION 'Approver 2 (%) is not admin', NEW.approver_2_person_id;
    END IF;
  END IF;
  IF NEW.approver_3_person_id IS NOT NULL THEN
    SELECT is_admin INTO v_is_admin_approver_3 FROM mlm.person WHERE id = NEW.approver_3_person_id;
    IF v_is_admin_approver_3 IS NOT TRUE THEN
      RAISE EXCEPTION 'Approver 3 (%) is not admin', NEW.approver_3_person_id;
    END IF;
  END IF;

  -- Status transitions legales
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'executed' AND NEW.status <> 'executed' THEN
      RAISE EXCEPTION 'Cannot change status from executed';
    END IF;
    IF OLD.status = 'rejected' AND NEW.status NOT IN ('rejected') THEN
      RAISE EXCEPTION 'Cannot change status from rejected';
    END IF;
    IF OLD.status = 'expired' AND NEW.status NOT IN ('expired') THEN
      RAISE EXCEPTION 'Cannot change status from expired';
    END IF;
    -- pending → approved | rejected | expired (OK)
    -- approved → executed (OK)
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_approval_request
  BEFORE INSERT OR UPDATE ON mlm.approval_request
  FOR EACH ROW EXECUTE FUNCTION mlm.fn_validate_approval_request();

-- ---------------------------------------------------------------------------
-- Trigger: auto-mover a 'approved' cuando se completen N firmas positivas;
-- auto-mover a 'rejected' si cualquier approver rechaza
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mlm.fn_advance_approval_status() RETURNS trigger AS $$
DECLARE
  v_approve_count smallint := 0;
  v_reject_any boolean := false;
BEGIN
  IF NEW.status <> 'pending' THEN
    RETURN NEW;
  END IF;

  IF NEW.approver_1_decision = 'approve' THEN v_approve_count := v_approve_count + 1; END IF;
  IF NEW.approver_2_decision = 'approve' THEN v_approve_count := v_approve_count + 1; END IF;
  IF NEW.approver_3_decision = 'approve' THEN v_approve_count := v_approve_count + 1; END IF;

  IF NEW.approver_1_decision = 'reject'
     OR NEW.approver_2_decision = 'reject'
     OR NEW.approver_3_decision = 'reject' THEN
    v_reject_any := true;
  END IF;

  IF v_reject_any THEN
    NEW.status := 'rejected';
  ELSIF v_approve_count >= NEW.requires_n_approvers THEN
    NEW.status := 'approved';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_advance_approval_status
  BEFORE UPDATE ON mlm.approval_request
  FOR EACH ROW
  WHEN (OLD.status = 'pending')
  EXECUTE FUNCTION mlm.fn_advance_approval_status();

-- ---------------------------------------------------------------------------
-- Job: expirar requests pending después de window
-- (corre cada 5 min vía pg_cron o cron externo)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mlm.fn_expire_pending_approvals() RETURNS integer AS $$
DECLARE v_count integer;
BEGIN
  UPDATE mlm.approval_request
     SET status = 'expired'
   WHERE status = 'pending'
     AND expires_at < now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- View: cola de pendientes para el dashboard de admins
-- ---------------------------------------------------------------------------
CREATE VIEW mlm.v_approval_queue AS
SELECT
  ar.id,
  ar.operation_type,
  ar.amount_usd,
  ar.requires_n_approvers,
  ar.status,
  p_init.first_name || ' ' || p_init.last_name AS initiator_name,
  ar.initiator_reason,
  ar.created_at,
  ar.expires_at,
  EXTRACT(EPOCH FROM (ar.expires_at - now()))::int AS seconds_to_expire,
  CASE
    WHEN ar.approver_1_decision IS NOT NULL THEN 1 ELSE 0
  END +
  CASE
    WHEN ar.approver_2_decision IS NOT NULL THEN 1 ELSE 0
  END +
  CASE
    WHEN ar.approver_3_decision IS NOT NULL THEN 1 ELSE 0
  END AS signed_count,
  ar.payload
FROM mlm.approval_request ar
JOIN mlm.person p_init ON p_init.id = ar.initiator_person_id
WHERE ar.status IN ('pending', 'approved')
ORDER BY ar.created_at ASC;

-- =============================================================================
-- 2. DATA SUBJECT REQUEST (ADR 0009 — Habeas Data right to be forgotten)
-- =============================================================================

CREATE TYPE mlm.dsr_type AS ENUM (
  'access',         -- pedir copia de mis datos
  'rectification',  -- corregir datos incorrectos
  'deletion',       -- borrar mis datos (con caveats)
  'opposition',     -- oponerse a tratamiento (e.g., marketing)
  'portability'     -- export de mis datos en formato máquina
);

CREATE TYPE mlm.dsr_status AS ENUM (
  'pending', 'in_review', 'approved', 'rejected', 'completed'
);

CREATE TABLE mlm.data_subject_request (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  person_id           bigint NOT NULL REFERENCES mlm.person(id),
  request_type        mlm.dsr_type NOT NULL,
  status              mlm.dsr_status NOT NULL DEFAULT 'pending',
  reason_subject      text,                        -- razón que da el sujeto
  reason_decision     text,                        -- razón de aprobar/rechazar (compliance)
  reviewer_person_id  bigint REFERENCES mlm.person(id),
  blocking_reason     text,                        -- e.g., "saldo pendiente de retiro $500"
  created_at          timestamptz NOT NULL DEFAULT now(),
  reviewed_at         timestamptz,
  completed_at        timestamptz,
  -- SLA Habeas Data: 10 días hábiles para responder, prorrogable a 5 más
  sla_deadline        timestamptz NOT NULL DEFAULT now() + interval '10 days'
);

CREATE INDEX dsr_status_idx ON mlm.data_subject_request(status, created_at DESC)
  WHERE status IN ('pending', 'in_review');
CREATE INDEX dsr_person_idx ON mlm.data_subject_request(person_id);

-- ---------------------------------------------------------------------------
-- Función de anonimización (ADR 0009)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mlm.fn_anonymize_person(p_person_id bigint, p_reason text)
RETURNS void AS $$
DECLARE
  v_salt text := current_setting('app.anonymize_salt', true);
  v_hash text;
BEGIN
  IF v_salt IS NULL THEN
    RAISE EXCEPTION 'app.anonymize_salt not configured (ALTER DATABASE ... SET app.anonymize_salt = ...)';
  END IF;

  v_hash := encode(digest(p_person_id::text || v_salt, 'sha256'), 'hex');

  UPDATE mlm.person SET
    user_id            = NULL,        -- rompe link con auth.user
    first_name         = 'ANON-' || substring(v_hash, 1, 8),
    last_name          = 'ANON-' || substring(v_hash, 9, 8),
    alias              = NULL,
    email              = 'anon-' || substring(v_hash, 1, 16) || '@anonymized.local',
    phone_country_id   = NULL,
    phone_number       = '',
    birthday           = NULL,
    birth_country_id   = NULL,
    ssn_encrypted      = NULL,
    status             = 'deleted',
    kyc_status         = 'not_started',
    kyc_approved_at    = NULL,
    updated_at         = now()
  WHERE id = p_person_id;

  -- Log en auditoría
  INSERT INTO audit.activity_log (entity_type, entity_id, action, after_data, occurred_at)
  VALUES (
    'person', p_person_id::text, 'anonymized',
    jsonb_build_object('reason', p_reason, 'hash', substring(v_hash, 1, 16)),
    now()
  );

  -- TODO: caller debe también eliminar KYC docs en Storage Box
  -- (pgcrypto no maneja S3; eso lo hace el worker en vp-engine)
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Job: identificar candidatos a anonimización (5 años inactividad)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mlm.fn_find_anonymization_candidates()
RETURNS TABLE(person_id bigint, last_activity timestamptz) AS $$
  -- Última actividad = max de updated_at en person, affiliate, y wallet_movement vinculado
  SELECT p.id,
         GREATEST(
           p.updated_at,
           a.updated_at,
           COALESCE((SELECT max(wm.posted_at)
                       FROM mlm.affiliate aff
                       JOIN mlm.wallet w ON w.affiliate_id = aff.id
                       JOIN mlm.wallet_movement wm ON wm.wallet_id = w.id
                      WHERE aff.person_id = p.id), '1970-01-01'::timestamptz)
         ) AS last_activity
    FROM mlm.person p
    LEFT JOIN mlm.affiliate a ON a.person_id = p.id
   WHERE p.status <> 'deleted'
     AND p.is_admin = false   -- nunca anonimizar admins automáticamente
   GROUP BY p.id, p.updated_at, a.updated_at
  HAVING GREATEST(
           p.updated_at,
           a.updated_at,
           COALESCE((SELECT max(wm.posted_at)
                       FROM mlm.affiliate aff
                       JOIN mlm.wallet w ON w.affiliate_id = aff.id
                       JOIN mlm.wallet_movement wm ON wm.wallet_id = w.id
                      WHERE aff.person_id = p.id), '1970-01-01'::timestamptz)
         ) < now() - interval '5 years';
$$ LANGUAGE sql STABLE;

-- =============================================================================
-- 3. PERMISSIONS
-- =============================================================================

GRANT SELECT ON mlm.approval_request, mlm.v_approval_queue TO app_read;
GRANT SELECT, INSERT, UPDATE ON mlm.approval_request TO app_write;
-- app_admin puede llamar fn_anonymize_person, no app_write
GRANT EXECUTE ON FUNCTION mlm.fn_anonymize_person(bigint, text) TO app_admin;
GRANT EXECUTE ON FUNCTION mlm.fn_expire_pending_approvals() TO app_admin;
GRANT EXECUTE ON FUNCTION mlm.fn_find_anonymization_candidates() TO app_admin, app_read;

GRANT SELECT, INSERT, UPDATE ON mlm.data_subject_request TO app_write;

-- =============================================================================
-- 4. CONFIG: salt para anonimización (debe setearse antes del primer uso)
-- =============================================================================
-- En el host de producción, ejecutar UNA vez:
--   ALTER DATABASE vicionpower SET app.anonymize_salt = '<openssl rand -base64 32>';
-- Esto hace persistente el salt; rotarlo invalidaría hashes pasados (no rotar
-- a menos que sea breach response).

\echo 'Schema governance instalado.'
\echo 'PASOS PENDIENTES MANUALES:'
\echo '  1. ALTER DATABASE vicionpower SET app.anonymize_salt = ''<32-byte-random>'';'
\echo '  2. Configurar pg_cron o cron externo para mlm.fn_expire_pending_approvals() cada 5 min'
\echo '  3. Configurar job mensual en vp-engine para mlm.fn_find_anonymization_candidates()'
