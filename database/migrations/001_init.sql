CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  base_url text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE test_cases (
  id uuid PRIMARY KEY,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  steps jsonb NOT NULL,
  expected_result text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE test_runs (
  id uuid PRIMARY KEY,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE test_results (
  id uuid PRIMARY KEY,
  run_id uuid REFERENCES test_runs(id) ON DELETE CASCADE,
  test_case_id uuid REFERENCES test_cases(id) ON DELETE CASCADE,
  status text NOT NULL,
  error_message text,
  duration_ms integer,
  screenshot_path text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE bug_reports (
  id uuid PRIMARY KEY,
  result_id uuid REFERENCES test_results(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  severity text DEFAULT 'medium',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX test_cases_project_id_idx ON test_cases(project_id);
CREATE INDEX test_runs_project_id_idx ON test_runs(project_id);
CREATE INDEX test_results_run_id_idx ON test_results(run_id);
CREATE INDEX test_results_test_case_id_idx ON test_results(test_case_id);
CREATE INDEX bug_reports_result_id_idx ON bug_reports(result_id);
