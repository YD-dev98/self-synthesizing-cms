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

-- Version registry — one row per snapshot, even if the surface is empty
CREATE TABLE site_versions (
  version INTEGER PRIMARY KEY,
  intent_id UUID REFERENCES user_intents(id),  -- NULL for system-initiated (e.g. TTL sweep)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Block-level snapshot data, keyed to a version
CREATE TABLE site_state_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_version INTEGER NOT NULL REFERENCES site_versions(version),
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
CREATE INDEX idx_versions_intent ON site_versions(intent_id);

-- 2. Row Level Security
-- ---------------------------------------------------------

ALTER TABLE user_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE processing_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_versions ENABLE ROW LEVEL SECURITY;
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

-- Atomically claim pending intents (CTE + FOR UPDATE SKIP LOCKED)
CREATE OR REPLACE FUNCTION claim_pending_intents(batch_size integer DEFAULT 5)
RETURNS SETOF user_intents
LANGUAGE sql
SECURITY DEFINER
AS $$
  WITH claimed AS (
    SELECT id FROM user_intents
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT batch_size
    FOR UPDATE SKIP LOCKED
  )
  UPDATE user_intents
  SET status = 'processing', processed_at = now()
  FROM claimed
  WHERE user_intents.id = claimed.id
  RETURNING user_intents.*;
$$;

REVOKE ALL ON FUNCTION claim_pending_intents(integer) FROM public;
REVOKE ALL ON FUNCTION claim_pending_intents(integer) FROM anon;
GRANT EXECUTE ON FUNCTION claim_pending_intents(integer) TO service_role;

-- *** SITE STATE MUTATION LOCK ***
-- All functions that mutate site_state and/or snapshot to site_state_history
-- MUST acquire this advisory lock at the start of their transaction.
-- This serializes state writers so snapshots are always consistent.
-- Lock ID: 42 (arbitrary constant, shared across all mutation RPCs).
-- Phase 5's apply_mutations_and_snapshot() must use the same lock.

-- Atomic sweep: delete expired blocks and snapshot in one transaction.
-- Returns the number of expired blocks deleted (0 means no-op, no snapshot).
CREATE OR REPLACE FUNCTION sweep_expired_blocks()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count integer;
  new_version integer;
BEGIN
  -- Serialize against other state writers (sweep, future mutation RPCs)
  PERFORM pg_advisory_xact_lock(42);

  -- Delete expired blocks
  WITH deleted AS (
    DELETE FROM site_state
    WHERE expires_at IS NOT NULL AND expires_at < now()
    RETURNING *
  )
  SELECT count(*) INTO deleted_count FROM deleted;

  -- Only snapshot if something changed
  IF deleted_count = 0 THEN
    RETURN 0;
  END IF;

  -- Allocate version
  new_version := nextval('site_version_seq');

  -- Register the version (intent_id NULL = system sweep)
  INSERT INTO site_versions (version, intent_id)
  VALUES (new_version, NULL);

  -- Snapshot surviving blocks (may be zero rows — that's valid)
  INSERT INTO site_state_history
    (site_version, semantic_key, block_type, title, content, display_order, expires_at)
  SELECT
    new_version, semantic_key, block_type, title, content, display_order, expires_at
  FROM site_state;

  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION sweep_expired_blocks() FROM public;
REVOKE ALL ON FUNCTION sweep_expired_blocks() FROM anon;
GRANT EXECUTE ON FUNCTION sweep_expired_blocks() TO service_role;

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
