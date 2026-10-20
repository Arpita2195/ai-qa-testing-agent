CREATE TABLE visual_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  path text NOT NULL,
  viewport_width integer NOT NULL DEFAULT 1280,
  viewport_height integer NOT NULL DEFAULT 720,
  threshold numeric NOT NULL DEFAULT 0.01,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE visual_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id uuid REFERENCES visual_checks(id) ON DELETE CASCADE,
  image_path text NOT NULL,
  status text NOT NULL DEFAULT 'approved'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE visual_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES test_runs(id) ON DELETE CASCADE,
  check_id uuid REFERENCES visual_checks(id) ON DELETE CASCADE,
  baseline_id uuid REFERENCES visual_baselines(id),
  status text NOT NULL CHECK (status IN ('passed', 'failed', 'baseline_created')),
  diff_ratio numeric,
  screenshot_path text,
  diff_path text,
  review_status text NOT NULL DEFAULT 'none'
    CHECK (review_status IN ('none', 'pending', 'accepted_change', 'confirmed_bug')),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX visual_checks_project_id_idx ON visual_checks(project_id);
CREATE INDEX visual_baselines_check_id_idx ON visual_baselines(check_id);
CREATE INDEX visual_results_run_id_idx ON visual_results(run_id);
CREATE INDEX visual_results_check_id_idx ON visual_results(check_id);
CREATE INDEX visual_results_baseline_id_idx ON visual_results(baseline_id);

ALTER TABLE test_runs
  DROP CONSTRAINT IF EXISTS test_runs_run_type_check;
ALTER TABLE test_runs
  ADD CONSTRAINT test_runs_run_type_check
  CHECK (run_type IN ('web', 'api', 'suite', 'visual'));
