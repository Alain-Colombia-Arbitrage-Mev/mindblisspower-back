-- 58_support_ticket_triage_ai.sql
-- Triage, asignacion de agentes y auditoria de borradores IA para support.ticket.
-- Cambio backward-compatible: las columnas nuevas tienen defaults y no alteran
-- los estados existentes open/answered/closed.

BEGIN;

ALTER TABLE support.ticket
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'member',
  ADD COLUMN IF NOT EXISTS assigned_to text,
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz,
  ADD COLUMN IF NOT EXISTS problem_summary text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS ai_support_request boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_filter_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS ai_draft_answer text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS ai_draft_status text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS ai_drafted_at timestamptz,
  ADD COLUMN IF NOT EXISTS ai_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS last_ai_error text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS inbound_message_id text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_priority_chk') THEN
    ALTER TABLE support.ticket
      ADD CONSTRAINT ticket_priority_chk
      CHECK (priority IN ('critical','high','normal','low'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_category_chk') THEN
    ALTER TABLE support.ticket
      ADD CONSTRAINT ticket_category_chk
      CHECK (category IN ('access','payments','kyc','tree','commissions','withdrawals','technical','general','non_support'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_source_chk') THEN
    ALTER TABLE support.ticket
      ADD CONSTRAINT ticket_source_chk
      CHECK (source IN ('member','email','access_help','admin','chatwoot','ai'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_ai_draft_status_chk') THEN
    ALTER TABLE support.ticket
      ADD CONSTRAINT ticket_ai_draft_status_chk
      CHECK (ai_draft_status IN ('none','drafted','blocked','escalate','error'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ticket_priority_status_idx
  ON support.ticket (priority, status, created_at DESC);

CREATE INDEX IF NOT EXISTS ticket_assigned_status_idx
  ON support.ticket (lower(assigned_to), status, created_at DESC)
  WHERE assigned_to IS NOT NULL;

CREATE INDEX IF NOT EXISTS ticket_source_created_idx
  ON support.ticket (source, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS ticket_inbound_message_uidx
  ON support.ticket (lower(inbound_message_id))
  WHERE inbound_message_id IS NOT NULL AND inbound_message_id <> '';

CREATE TABLE IF NOT EXISTS support.agent (
  email            text PRIMARY KEY,
  name             text NOT NULL DEFAULT '',
  active           boolean NOT NULL DEFAULT true,
  specialties      text[] NOT NULL DEFAULT ARRAY['general']::text[],
  max_open_tickets integer NOT NULL DEFAULT 25 CHECK (max_open_tickets BETWEEN 1 AND 200),
  sort_order       integer NOT NULL DEFAULT 100,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (email = lower(btrim(email)) AND position('@' in email) > 1)
);

CREATE INDEX IF NOT EXISTS support_agent_active_idx
  ON support.agent (active, sort_order, email);

DROP TRIGGER IF EXISTS support_agent_touch ON support.agent;
CREATE TRIGGER support_agent_touch BEFORE UPDATE ON support.agent
  FOR EACH ROW EXECUTE FUNCTION support.touch_updated_at();

INSERT INTO support.agent (email, name, specialties, sort_order)
VALUES
  ('devfidubit@gmail.com', 'Devfidubit', ARRAY['access','payments','tree','technical','general']::text[], 10),
  ('gabgarluc@outlook.com', 'Soporte administrativo', ARRAY['general','payments','kyc','withdrawals']::text[], 20)
ON CONFLICT (email) DO NOTHING;

COMMENT ON COLUMN support.ticket.priority IS
  'Prioridad operativa de soporte: critical, high, normal o low.';
COMMENT ON COLUMN support.ticket.ai_support_request IS
  'true solo cuando asunto/contenido pasan el filtro deterministico de soporte.';
COMMENT ON COLUMN support.ticket.ai_draft_status IS
  'Estado del borrador IA; drafted puede enviarse, blocked/escalate/error requieren humano.';
COMMENT ON TABLE support.agent IS
  'Agentes asignables desde el panel administrativo de soporte.';

DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['vp_engine','engine_write','app_write','app_admin'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON support.ticket TO %I', role_name);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON support.agent TO %I', role_name);
    END IF;
  END LOOP;

  FOREACH role_name IN ARRAY ARRAY['engine_read','app_read'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('GRANT SELECT ON support.ticket TO %I', role_name);
      EXECUTE format('GRANT SELECT ON support.agent TO %I', role_name);
    END IF;
  END LOOP;
END $$;

COMMIT;
