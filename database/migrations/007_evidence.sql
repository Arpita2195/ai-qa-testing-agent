ALTER TABLE test_results
  ADD COLUMN evidence jsonb,
  ADD COLUMN trace_path text;

ALTER TABLE test_results
  DROP CONSTRAINT IF EXISTS test_results_status_check;
ALTER TABLE test_results
  ADD CONSTRAINT test_results_status_check
  CHECK (status IN ('passed', 'failed', 'skipped', 'inconclusive'));

ALTER TABLE test_runs
  DROP CONSTRAINT IF EXISTS test_runs_status_check;
ALTER TABLE test_runs
  ADD CONSTRAINT test_runs_status_check
  CHECK (status IN ('pending', 'running', 'passed', 'failed', 'skipped', 'inconclusive'));
