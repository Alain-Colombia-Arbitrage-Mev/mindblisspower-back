-- =============================================================================
-- 42_support_tickets.sql — Tickets de soporte (panel admin + miembros)
-- Pre-req: schema support (schema_support_kb.sql).
-- Run: psql -d vicionpower -v ON_ERROR_STOP=1 -f 42_support_tickets.sql
-- =============================================================================

CREATE TABLE IF NOT EXISTS support.ticket (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email        text        NOT NULL,             -- miembro que abre el ticket
  subject      text        NOT NULL,
  body         text        NOT NULL,
  status       text        NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','answered','closed')),
  answer       text,                             -- respuesta del admin
  answered_by  text,                             -- email del admin que respondió
  answered_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ticket_status_idx  ON support.ticket (status, created_at DESC);
CREATE INDEX IF NOT EXISTS ticket_email_idx   ON support.ticket (lower(email), created_at DESC);

DROP TRIGGER IF EXISTS ticket_touch ON support.ticket;
CREATE TRIGGER ticket_touch BEFORE UPDATE ON support.ticket
  FOR EACH ROW EXECUTE FUNCTION support.touch_updated_at();

-- El app user de vp-payments necesita CRUD (GRANT como master):
-- GRANT USAGE ON SCHEMA support TO vp_engine;  -- ya otorgado
GRANT SELECT, INSERT, UPDATE ON support.ticket TO vp_engine;
