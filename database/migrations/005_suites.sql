CREATE TABLE suites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE suite_members (
  suite_id uuid REFERENCES suites(id) ON DELETE CASCADE,
  test_case_id uuid REFERENCES test_cases(id) ON DELETE CASCADE,
  endpoint_id uuid REFERENCES api_endpoints(id) ON DELETE CASCADE,
  CONSTRAINT suite_members_one_item CHECK (
    (test_case_id IS NOT NULL AND endpoint_id IS NULL)
    OR (test_case_id IS NULL AND endpoint_id IS NOT NULL)
  )
);

CREATE INDEX suites_project_id_idx ON suites(project_id);
CREATE INDEX suite_members_suite_id_idx ON suite_members(suite_id);
CREATE INDEX suite_members_test_case_id_idx ON suite_members(test_case_id);
CREATE INDEX suite_members_endpoint_id_idx ON suite_members(endpoint_id);

ALTER TABLE test_runs
  ADD COLUMN suite_id uuid REFERENCES suites(id) ON DELETE SET NULL,
  ADD COLUMN run_type text NOT NULL DEFAULT 'web'
    CHECK (run_type IN ('web', 'api', 'suite'));

CREATE INDEX test_runs_suite_id_idx ON test_runs(suite_id);
