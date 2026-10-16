ALTER TABLE bug_reports
  ADD COLUMN test_case_id uuid REFERENCES test_cases(id) ON DELETE CASCADE,
  ADD COLUMN classification text DEFAULT 'unknown'
    CHECK (classification IN ('product_bug', 'test_issue', 'environment_issue', 'unknown')),
  ADD COLUMN probable_cause text,
  ADD COLUMN reproduction_steps jsonb,
  ADD COLUMN evidence_path text,
  ADD COLUMN status text NOT NULL DEFAULT 'suspected'
    CHECK (status IN ('suspected', 'confirmed', 'dismissed')),
  ADD CONSTRAINT bug_reports_result_id_unique UNIQUE (result_id);

CREATE INDEX bug_reports_test_case_id_idx ON bug_reports(test_case_id);
