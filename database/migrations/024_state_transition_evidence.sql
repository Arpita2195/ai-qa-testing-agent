-- Migration 024: State Transition Evidence Foundation & Append-Only Conflict Auditing
-- Implements Stage 8A evidence foundation with project-scoped composite foreign keys,
-- transaction-isolated state transitions, and append-only conflict tracking.

-- 1. Ensure composite unique constraints exist on parent tables (schema- and table-specific)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'crawl_sessions'
      AND con.conname = 'uq_crawl_sessions_project_id_session_id'
  ) THEN
    ALTER TABLE crawl_sessions ADD CONSTRAINT uq_crawl_sessions_project_id_session_id UNIQUE (project_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'test_runs'
      AND con.conname = 'uq_test_runs_project_id_run_id'
  ) THEN
    ALTER TABLE test_runs ADD CONSTRAINT uq_test_runs_project_id_run_id UNIQUE (project_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'crawled_pages'
      AND con.conname = 'uq_crawled_pages_project_id_page_id'
  ) THEN
    ALTER TABLE crawled_pages ADD CONSTRAINT uq_crawled_pages_project_id_page_id UNIQUE (project_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'functionality_inventory'
      AND con.conname = 'uq_functionality_inventory_project_id_func_id'
  ) THEN
    ALTER TABLE functionality_inventory ADD CONSTRAINT uq_functionality_inventory_project_id_func_id UNIQUE (project_id, id);
  END IF;
END $$;

-- 2. State transition evidence table
CREATE TABLE IF NOT EXISTS state_transition_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  origin_type TEXT NOT NULL CHECK (origin_type IN ('crawler_session', 'test_execution')),
  crawl_session_id UUID,
  test_run_id UUID,
  source_page_id UUID NOT NULL,
  destination_page_id UUID,
  functionality_id UUID,
  source_path TEXT NOT NULL,
  destination_path TEXT NOT NULL,
  action_type TEXT NOT NULL,
  trigger_selector TEXT NOT NULL,
  trigger_action TEXT NOT NULL,
  action_fingerprint CHAR(64) NOT NULL,
  navigation_scope TEXT NOT NULL CHECK (navigation_scope IN ('same_page', 'cross_page', 'unknown')),
  expected_intent TEXT,
  auth_state_at_observation TEXT NOT NULL CHECK (auth_state_at_observation IN ('unauthenticated', 'authenticated', 'inconclusive')),
  outcome_status TEXT NOT NULL CHECK (outcome_status IN ('verified', 'unverified', 'inconclusive', 'error')),
  dom_fingerprint_at_observation CHAR(64) NOT NULL,
  transition_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempt_id UUID NOT NULL,
  attempt_number INT NOT NULL,
  canonical_observation_hash CHAR(64) NOT NULL,
  lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_status IN ('active', 'conflicted', 'superseded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Composite uniqueness on evidence for child conflict project isolation
  CONSTRAINT uq_ste_project_id_transition_id UNIQUE (project_id, id),

  -- Composite foreign keys enforcing strict project isolation
  CONSTRAINT fk_ste_crawl_session FOREIGN KEY (project_id, crawl_session_id)
    REFERENCES crawl_sessions(project_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_ste_test_run FOREIGN KEY (project_id, test_run_id)
    REFERENCES test_runs(project_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_ste_source_page FOREIGN KEY (project_id, source_page_id)
    REFERENCES crawled_pages(project_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_ste_destination_page FOREIGN KEY (project_id, destination_page_id)
    REFERENCES crawled_pages(project_id, id) ON DELETE SET NULL (destination_page_id),
  CONSTRAINT fk_ste_functionality FOREIGN KEY (project_id, functionality_id)
    REFERENCES functionality_inventory(project_id, id) ON DELETE SET NULL (functionality_id),

  -- Origin session consistency check
  CONSTRAINT chk_ste_origin_session CHECK (
    (origin_type = 'crawler_session' AND crawl_session_id IS NOT NULL AND test_run_id IS NULL) OR
    (origin_type = 'test_execution' AND test_run_id IS NOT NULL AND crawl_session_id IS NULL)
  )
);

-- Partial unique indexes enforcing attempt uniqueness and attempt_number uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS uq_ste_crawler_attempt
  ON state_transition_evidence (project_id, crawl_session_id, source_page_id, action_fingerprint, attempt_id)
  WHERE origin_type = 'crawler_session';

CREATE UNIQUE INDEX IF NOT EXISTS uq_ste_test_attempt
  ON state_transition_evidence (project_id, test_run_id, source_page_id, action_fingerprint, attempt_id)
  WHERE origin_type = 'test_execution';

CREATE UNIQUE INDEX IF NOT EXISTS uq_ste_crawler_attempt_number
  ON state_transition_evidence (project_id, crawl_session_id, source_page_id, action_fingerprint, attempt_number)
  WHERE origin_type = 'crawler_session';

CREATE UNIQUE INDEX IF NOT EXISTS uq_ste_test_attempt_number
  ON state_transition_evidence (project_id, test_run_id, source_page_id, action_fingerprint, attempt_number)
  WHERE origin_type = 'test_execution';

CREATE UNIQUE INDEX IF NOT EXISTS uq_ste_crawler_active
  ON state_transition_evidence (project_id, crawl_session_id, source_page_id, action_fingerprint)
  WHERE origin_type = 'crawler_session' AND lifecycle_status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS uq_ste_test_active
  ON state_transition_evidence (project_id, test_run_id, source_page_id, action_fingerprint)
  WHERE origin_type = 'test_execution' AND lifecycle_status = 'active';

CREATE INDEX IF NOT EXISTS idx_ste_project_func
  ON state_transition_evidence (project_id, functionality_id);

-- 3. Append-only conflicts audit table
CREATE TABLE IF NOT EXISTS state_transition_conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  transition_id UUID NOT NULL,
  attempt_id UUID NOT NULL,
  existing_observation_hash CHAR(64) NOT NULL,
  incoming_observation_hash CHAR(64) NOT NULL,
  incoming_observation JSONB NOT NULL,
  conflicting_fields TEXT[] NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Project isolation enforced on conflicts
  CONSTRAINT fk_stc_transition_project FOREIGN KEY (project_id, transition_id)
    REFERENCES state_transition_evidence(project_id, id) ON DELETE CASCADE,

  -- Scoped uniqueness prevents suppression across distinct transitions
  CONSTRAINT uq_conflict_trans_attempt_incoming UNIQUE (transition_id, attempt_id, incoming_observation_hash)
);

CREATE INDEX IF NOT EXISTS idx_stc_transition_id
  ON state_transition_conflicts (transition_id);

-- 4. Trigger enforcement for immutability
CREATE OR REPLACE FUNCTION trg_enforce_append_only_conflicts()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Audit violation: state_transition_conflicts records are strictly immutable and cannot be updated (record id: %)', OLD.id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() <= 1 THEN
      RAISE EXCEPTION 'Audit violation: state_transition_conflicts records are append-only and direct deletion is forbidden (record id: %)', OLD.id;
    END IF;
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_conflicts_append_only ON state_transition_conflicts;
CREATE TRIGGER trg_conflicts_append_only
BEFORE UPDATE OR DELETE ON state_transition_conflicts
FOR EACH ROW EXECUTE FUNCTION trg_enforce_append_only_conflicts();

-- 5. Revoke direct mutation permissions from public
REVOKE UPDATE, DELETE, TRUNCATE ON state_transition_conflicts FROM PUBLIC;
