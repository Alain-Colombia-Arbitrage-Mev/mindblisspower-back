-- 67_comms_campaigns.sql — comunicados masivos por correo (campañas por segmento,
-- aprobación four-eyes, cola de destinatarios, bajas y supresión por rebote).
SET search_path = mlm, public;

BEGIN;

CREATE SCHEMA IF NOT EXISTS comms;

DO $$ BEGIN
  CREATE TYPE comms.campaign_status AS ENUM
    ('draft','pending_approval','approved','sending','paused','done','cancelled','rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE comms.recipient_status AS ENUM
    ('queued','sending','sent','delivered','bounced','complained','failed','skipped');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS comms.campaign (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject             text NOT NULL CHECK (length(subject) BETWEEN 3 AND 150),
  body_markdown       text NOT NULL CHECK (length(body_markdown) BETWEEN 10 AND 20000),
  segment             jsonb NOT NULL CHECK (jsonb_typeof(segment) = 'object'),
  status              comms.campaign_status NOT NULL DEFAULT 'draft',
  approval_request_id bigint REFERENCES mlm.approval_request(id),
  created_by          citext NOT NULL,
  approved_by         citext,
  audience_count      integer,
  test_sends          smallint NOT NULL DEFAULT 0,
  sent_count          integer NOT NULL DEFAULT 0,
  delivered_count     integer NOT NULL DEFAULT 0,
  bounced_count       integer NOT NULL DEFAULT 0,
  complained_count    integer NOT NULL DEFAULT 0,
  failed_count        integer NOT NULL DEFAULT 0,
  pause_reason        text,
  started_at          timestamptz,
  finished_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaign_active_idx
  ON comms.campaign(status, id) WHERE status IN ('approved','sending','paused');

CREATE TABLE IF NOT EXISTS comms.campaign_recipient (
  campaign_id     bigint NOT NULL REFERENCES comms.campaign(id) ON DELETE CASCADE,
  person_id       bigint NOT NULL REFERENCES mlm.person(id),
  email           citext NOT NULL,
  first_name      text NOT NULL DEFAULT '',
  status          comms.recipient_status NOT NULL DEFAULT 'queued',
  ses_message_id  text,
  attempts        smallint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error      text,
  skip_reason     text,
  sent_at         timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, person_id)
);
CREATE INDEX IF NOT EXISTS campaign_recipient_queue_idx
  ON comms.campaign_recipient(campaign_id, next_attempt_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS campaign_recipient_sending_idx
  ON comms.campaign_recipient(updated_at) WHERE status = 'sending';
CREATE UNIQUE INDEX IF NOT EXISTS campaign_recipient_msgid_idx
  ON comms.campaign_recipient(ses_message_id) WHERE ses_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS comms.unsubscribe (
  email       citext PRIMARY KEY,
  person_id   bigint REFERENCES mlm.person(id),
  source      text NOT NULL DEFAULT 'link' CHECK (source IN ('link','complaint','admin')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS comms.suppressed_email (
  email       citext PRIMARY KEY,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION comms.touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS campaign_touch ON comms.campaign;
CREATE TRIGGER campaign_touch BEFORE UPDATE ON comms.campaign
  FOR EACH ROW EXECUTE FUNCTION comms.touch_updated_at();
DROP TRIGGER IF EXISTS campaign_recipient_touch ON comms.campaign_recipient;
CREATE TRIGGER campaign_recipient_touch BEFORE UPDATE ON comms.campaign_recipient
  FOR EACH ROW EXECUTE FUNCTION comms.touch_updated_at();

-- Grants (ejecutar como master; en tests los roles existen sin login)
GRANT USAGE ON SCHEMA comms TO vp_engine;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA comms TO vp_engine;
ALTER DEFAULT PRIVILEGES IN SCHEMA comms GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vp_engine;

COMMIT;

-- Fuera de la transacción: ADD VALUE no puede usarse dentro del mismo bloque
-- en el que luego se referencia el valor.
ALTER TYPE mlm.approval_operation_type ADD VALUE IF NOT EXISTS 'comms_campaign';
