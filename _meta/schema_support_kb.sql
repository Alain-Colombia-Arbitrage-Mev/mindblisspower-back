-- =============================================================================
-- schema_support_kb.sql — Base de conocimiento del bot de soporte (RAG)
--
-- Decisión 2026-07-09:
--   - Postgres = FUENTE DE VERDAD de los documentos; Qdrant = índice vectorial
--     DERIVADO y reconstruible (vp-kb-indexer --rebuild).
--   - Embeddings: intfloat/multilingual-e5-large vía OpenRouter.
--     Reglas duras del modelo: prefijos "passage: "/"query: ", límite 512
--     tokens ⇒ chunks ≤ ~400 tokens, 1024 dims, distancia Cosine.
--   - Las TRANSACCIONES no se vectorizan (preguntas transaccionales = tool
--     calls tipadas contra la API, no RAG).
--
-- Pre-req: schema_mlm.sql ya aplicado (usa el rol/DB existentes).
-- Run: psql -U migrator -d vicionpower -f schema_support_kb.sql
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS support;
SET search_path = support, public;

-- Visibilidad del documento: filtra en Qdrant (payload index) para que el bot
-- NUNCA sirva contenido interno a un miembro.
CREATE TYPE support.kb_visibility AS ENUM ('public', 'member', 'admin');

-- =============================================================================
-- 1. KB_DOCUMENTS — documento canónico (FAQ, política, guía del plan)
-- =============================================================================
CREATE TABLE support.kb_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo       text        NOT NULL,
  categoria    text        NOT NULL,              -- ej: 'pagos','rangos','retiros','kyc'
  lang         text        NOT NULL DEFAULT 'es',
  rol_visible  support.kb_visibility NOT NULL DEFAULT 'member',
  version      int         NOT NULL DEFAULT 1,
  body         text        NOT NULL,              -- markdown completo del documento
  activo       boolean     NOT NULL DEFAULT true, -- false ⇒ indexer purga sus puntos de Qdrant
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX kb_documents_categoria_idx ON support.kb_documents (categoria) WHERE activo;

-- =============================================================================
-- 2. KB_CHUNKS — fragmentos embebibles (≤ ~400 tokens por límite e5 de 512)
--
-- El chunking lo hace la app al guardar el documento (borra e inserta los
-- chunks del doc en la misma tx). `checksum` = sha256 del texto ⇒ el indexer
-- solo re-embebe lo que cambió.
--
-- Estado de indexación SIN tabla aparte:
--   pendiente  := embedded_at IS NULL OR updated_at > embedded_at
--   el indexer marca embedded_at + embed_model tras el upsert a Qdrant.
-- =============================================================================
CREATE TABLE support.kb_chunks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id       uuid        NOT NULL REFERENCES support.kb_documents(id) ON DELETE CASCADE,
  ord          int         NOT NULL,              -- posición dentro del documento
  texto        text        NOT NULL,
  checksum     text        NOT NULL,              -- sha256 hex del texto
  metadata     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  embedded_at  timestamptz,                       -- NULL ⇒ pendiente de embeber
  embed_model  text,                              -- modelo con el que se embebió
  UNIQUE (doc_id, ord)
);

-- Cola de trabajo del indexer: pendientes primero, barato de escanear.
CREATE INDEX kb_chunks_pending_idx ON support.kb_chunks (updated_at)
  WHERE embedded_at IS NULL;

CREATE INDEX kb_chunks_doc_idx ON support.kb_chunks (doc_id);

-- =============================================================================
-- 3. updated_at automático (mismo patrón que el resto del schema)
-- =============================================================================
CREATE OR REPLACE FUNCTION support.touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER kb_documents_touch BEFORE UPDATE ON support.kb_documents
  FOR EACH ROW EXECUTE FUNCTION support.touch_updated_at();

-- En chunks: solo si cambió el contenido (checksum). Un UPDATE idéntico no debe
-- disparar re-embedding.
CREATE TRIGGER kb_chunks_touch BEFORE UPDATE ON support.kb_chunks
  FOR EACH ROW WHEN (OLD.checksum IS DISTINCT FROM NEW.checksum)
  EXECUTE FUNCTION support.touch_updated_at();
