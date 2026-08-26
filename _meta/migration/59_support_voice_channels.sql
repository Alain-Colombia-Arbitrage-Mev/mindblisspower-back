-- 59_support_voice_channels.sql
-- Canales publicos de soporte por Twilio: llamadas de voz, WhatsApp Calling y
-- mensajes de WhatsApp. La IA solo responde mensajes clasificados como soporte.

BEGIN;

ALTER TABLE support.ticket
  DROP CONSTRAINT IF EXISTS ticket_source_chk;

ALTER TABLE support.ticket
  ADD CONSTRAINT ticket_source_chk
  CHECK (source IN ('member','email','access_help','admin','chatwoot','ai','voice','whatsapp','whatsapp_call'));

CREATE TABLE IF NOT EXISTS support.call_session (
  call_sid          text PRIMARY KEY,
  ticket_id         bigint REFERENCES support.ticket(id) ON DELETE SET NULL,
  from_number       text NOT NULL DEFAULT '',
  to_number         text NOT NULL DEFAULT '',
  channel           text NOT NULL DEFAULT 'voice'
                    CHECK (channel IN ('voice','whatsapp_call')),
  status            text NOT NULL DEFAULT 'in_progress'
                    CHECK (status IN ('in_progress','completed','failed','busy','no_answer','canceled')),
  transcript        text NOT NULL DEFAULT '',
  last_user_message text NOT NULL DEFAULT '',
  last_ai_answer    text NOT NULL DEFAULT '',
  turns             integer NOT NULL DEFAULT 0 CHECK (turns >= 0),
  started_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz
);

CREATE INDEX IF NOT EXISTS support_call_ticket_idx
  ON support.call_session(ticket_id);

CREATE INDEX IF NOT EXISTS support_call_status_idx
  ON support.call_session(status, updated_at DESC);

DROP TRIGGER IF EXISTS support_call_session_touch ON support.call_session;
CREATE TRIGGER support_call_session_touch BEFORE UPDATE ON support.call_session
  FOR EACH ROW EXECUTE FUNCTION support.touch_updated_at();

COMMENT ON TABLE support.call_session IS
  'Sesiones de llamadas entrantes de soporte por Twilio Voice y WhatsApp Calling.';
COMMENT ON COLUMN support.call_session.channel IS
  'voice = llamada telefonica; whatsapp_call = llamada de WhatsApp Business Calling.';

DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['vp_engine','engine_write','app_write','app_admin'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON support.call_session TO %I', role_name);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON support.ticket TO %I', role_name);
    END IF;
  END LOOP;

  FOREACH role_name IN ARRAY ARRAY['engine_read','app_read'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('GRANT SELECT ON support.call_session TO %I', role_name);
      EXECUTE format('GRANT SELECT ON support.ticket TO %I', role_name);
    END IF;
  END LOOP;
END $$;

COMMIT;
