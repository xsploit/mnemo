-- riko-mind memory schema (Postgres + pgvector)
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memories (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id      TEXT        NOT NULL,
  kind            TEXT        NOT NULL CHECK (kind IN ('episodic','semantic','reflection','diary')),
  content         TEXT        NOT NULL,
  embedding       VECTOR(1536),
  importance      REAL        NOT NULL DEFAULT 5,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_accessed   TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to        TIMESTAMPTZ,                       -- NULL = currently true
  supersedes      UUID REFERENCES memories(id),
  reasoning       TEXT,                              -- thoughts-on-thoughts trace
  sources         UUID[]      NOT NULL DEFAULT '{}',
  processed       BOOLEAN     NOT NULL DEFAULT FALSE,-- consumed by reflect/consolidate
  meta            JSONB       NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS memories_subject_kind  ON memories (subject_id, kind);
CREATE INDEX IF NOT EXISTS memories_unprocessed   ON memories (subject_id, processed) WHERE processed = FALSE;
CREATE INDEX IF NOT EXISTS memories_valid         ON memories (subject_id, valid_to);
-- Approximate nearest-neighbour over the memory stream.
CREATE INDEX IF NOT EXISTS memories_embedding_hnsw
  ON memories USING hnsw (embedding vector_cosine_ops);
