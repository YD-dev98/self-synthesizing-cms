-- =============================================================
-- Self-Synthesizing CMS — Initial Schema
-- =============================================================

-- 1. Tables
-- ---------------------------------------------------------

-- Intent queue + historical record of all user requests
CREATE TABLE user_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  result_summary TEXT,
  error TEXT,
  CONSTRAINT valid_status CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
);

CREATE INDEX idx_intents_status ON user_intents(status) WHERE status = 'pending';
CREATE INDEX idx_intents_created ON user_intents(created_at DESC);

-- Current content surface — each row is a rendered block
CREATE TABLE site_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  semantic_key TEXT NOT NULL UNIQUE,
  block_type TEXT NOT NULL,
  title TEXT,
  content JSONB NOT NULL,
  source_intent_id UUID REFERENCES user_intents(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  display_order INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT valid_block_type CHECK (block_type IN ('trends', 'weather', 'summary')),
  CONSTRAINT valid_semantic_key CHECK (
    -- Must start with block_type + ':'
    semantic_key LIKE block_type || ':%'
    -- Slug part must be lowercase alphanumeric with hyphens
    AND substring(semantic_key FROM length(block_type) + 2) ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    -- Slug must be ≤40 chars
    AND length(substring(semantic_key FROM length(block_type) + 2)) <= 40
  )
);

CREATE INDEX idx_state_order ON site_state(display_order);
CREATE INDEX idx_state_expires ON site_state(expires_at) WHERE expires_at IS NOT NULL;

-- Audit trail of every tool call the LLM makes
CREATE TABLE processing_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id UUID REFERENCES user_intents(id),
  tool_name TEXT NOT NULL,
  tool_input JSONB,
  tool_output JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_logs_intent ON processing_logs(intent_id);

-- Versioned full-surface snapshots for point-in-time reconstruction
CREATE SEQUENCE site_version_seq START 1;

CREATE TABLE site_state_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_version INTEGER NOT NULL,
  intent_id UUID REFERENCES user_intents(id),
  semantic_key TEXT NOT NULL,
  block_type TEXT NOT NULL,
  title TEXT,
  content JSONB NOT NULL,
  display_order INTEGER NOT NULL,
  expires_at TIMESTAMPTZ,
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_version, semantic_key),
  CONSTRAINT valid_block_type CHECK (block_type IN ('trends', 'weather', 'summary')),
  CONSTRAINT valid_semantic_key CHECK (
    semantic_key LIKE block_type || ':%'
    AND substring(semantic_key FROM length(block_type) + 2) ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    AND length(substring(semantic_key FROM length(block_type) + 2)) <= 40
  )
);

CREATE INDEX idx_history_version ON site_state_history(site_version);
CREATE INDEX idx_history_intent ON site_state_history(intent_id);

-- 2. Row Level Security
-- ---------------------------------------------------------

ALTER TABLE user_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE processing_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_state_history ENABLE ROW LEVEL SECURITY;

-- Anon: can only read site_state (for Realtime subscriptions + initial page load)
CREATE POLICY "anon_select_site_state"
  ON site_state FOR SELECT
  TO anon
  USING (true);

-- Service role: full access on all tables (used by API routes + worker)
-- Note: service_role bypasses RLS by default in Supabase, so no explicit
-- policies needed. The security boundary is: anon gets read-only on
-- site_state, everything else requires service_role.

-- 3. Helper functions
-- ---------------------------------------------------------

-- Expose nextval for site_version_seq via RPC (service role only)
CREATE OR REPLACE FUNCTION nextval_site_version()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT nextval('site_version_seq');
$$;

REVOKE ALL ON FUNCTION nextval_site_version() FROM public;
REVOKE ALL ON FUNCTION nextval_site_version() FROM anon;
GRANT EXECUTE ON FUNCTION nextval_site_version() TO service_role;

-- Check if site_state is in the realtime publication (for testing)
CREATE OR REPLACE FUNCTION check_realtime_publication()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
    AND tablename = 'site_state'
  );
$$;

REVOKE ALL ON FUNCTION check_realtime_publication() FROM public;
REVOKE ALL ON FUNCTION check_realtime_publication() FROM anon;
GRANT EXECUTE ON FUNCTION check_realtime_publication() TO service_role;

-- 4. Realtime
-- ---------------------------------------------------------

-- Enable Realtime on site_state so frontend receives live updates
ALTER PUBLICATION supabase_realtime ADD TABLE site_state;
