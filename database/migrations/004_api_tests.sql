CREATE TABLE api_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  method text NOT NULL CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  path text NOT NULL,
  headers jsonb DEFAULT '{}',
  body jsonb,
  expected_status integer NOT NULL,
  expected_fields jsonb DEFAULT '{}',
  max_response_ms integer,
  review_status text NOT NULL DEFAULT 'approved'
    CHECK (review_status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE api_test_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES test_runs(id) ON DELETE CASCADE,
  endpoint_id uuid REFERENCES api_endpoints(id) ON DELETE CASCADE,
  status text NOT NULL,
  actual_status integer,
  response_ms integer,
  error_message text,
  response_snippet text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX api_endpoints_project_id_idx ON api_endpoints(project_id);
CREATE INDEX api_test_results_run_id_idx ON api_test_results(run_id);
CREATE INDEX api_test_results_endpoint_id_idx ON api_test_results(endpoint_id);
