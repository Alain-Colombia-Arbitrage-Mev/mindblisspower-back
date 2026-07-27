-- =============================================================================
-- 53_news.sql — Comunicados / news del miembro servidos desde el backend.
-- Reemplaza el array NEWS hardcodeado del growth-hub (incl. datos bancarios
-- OBSOLETOS: el negocio cobra SOLO por Stripe, no por depósito bancario).
-- Pre-req: schema support (schema_support_kb.sql / 42_support_tickets.sql).
-- Run: psql -d vicionpower -v ON_ERROR_STOP=1 -f 53_news.sql
-- Idempotente y condicional en el grant (corre igual en dev sin el rol vp_engine,
-- mismo patrón que 41/47/52).
-- =============================================================================

CREATE TABLE IF NOT EXISTS support.news (
  id         bigserial   PRIMARY KEY,
  title      text        NOT NULL,
  body       text        NOT NULL,
  published  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS news_published_idx
  ON support.news (published, created_at DESC);

-- vp-payments (rol vp_engine) lee las news para el miembro y — si el admin va a
-- postearlas — también escribe. Condicional para no fallar en dev sin el rol.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vp_engine') THEN
    GRANT SELECT, INSERT ON support.news TO vp_engine;
    GRANT USAGE, SELECT ON SEQUENCE support.news_id_seq TO vp_engine;
  END IF;
END $$;
