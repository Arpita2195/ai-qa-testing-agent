-- Migration 009: Add build metadata, regression tracking, and test case versioning/priority/module

ALTER TABLE test_runs
  ADD COLUMN IF NOT EXISTS commit_sha TEXT,
  ADD COLUMN IF NOT EXISTS build_id TEXT,
  ADD COLUMN IF NOT EXISTS branch TEXT,
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test',
  ADD COLUMN IF NOT EXISTS trigger_source TEXT NOT NULL DEFAULT 'manual';

CREATE INDEX IF NOT EXISTS test_runs_commit_sha_idx ON test_runs(commit_sha);
CREATE INDEX IF NOT EXISTS test_runs_branch_idx ON test_runs(branch);
CREATE INDEX IF NOT EXISTS test_runs_environment_idx ON test_runs(environment);

ALTER TABLE test_cases
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS module TEXT NOT NULL DEFAULT 'frontend';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'test_cases_priority_check'
  ) THEN
    ALTER TABLE test_cases ADD CONSTRAINT test_cases_priority_check
      CHECK (priority IN ('low', 'medium', 'high', 'critical'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS test_cases_module_idx ON test_cases(module);
CREATE INDEX IF NOT EXISTS test_cases_priority_idx ON test_cases(priority);

ALTER TABLE test_results
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_flaky BOOLEAN NOT NULL DEFAULT FALSE;
