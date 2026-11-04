-- Migration 012: Test Case Automation & Execution Links

CREATE TABLE IF NOT EXISTS test_case_automations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    test_case_id UUID NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    target_type VARCHAR(10) NOT NULL CHECK (target_type IN ('web', 'api')),
    status VARCHAR(20) NOT NULL DEFAULT 'ready' CHECK (status IN ('draft', 'ready', 'approved', 'archived')),
    -- Web automation steps
    web_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- API automation specification
    api_method VARCHAR(10) CHECK (api_method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
    api_path TEXT,
    api_headers JSONB DEFAULT '{}'::jsonb,
    api_body JSONB DEFAULT 'null'::jsonb,
    api_expected_status INTEGER,
    api_expected_fields JSONB DEFAULT '{}'::jsonb,
    api_max_response_ms INTEGER,
    -- AI classification metadata
    confidence NUMERIC(3, 2) DEFAULT 1.0,
    reasoning TEXT,
    -- Execution tracking
    last_run_id UUID REFERENCES test_runs(id) ON DELETE SET NULL,
    last_run_status VARCHAR(20),
    last_run_at TIMESTAMP WITH TIME ZONE,
    last_error_message TEXT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT uk_test_case_automations_test_case UNIQUE (test_case_id)
);

CREATE INDEX IF NOT EXISTS idx_test_case_automations_project ON test_case_automations(project_id);
CREATE INDEX IF NOT EXISTS idx_test_case_automations_test_case ON test_case_automations(test_case_id);
CREATE INDEX IF NOT EXISTS idx_test_case_automations_target_type ON test_case_automations(target_type);

-- Link test_results to automation_id
ALTER TABLE test_results
  ADD COLUMN IF NOT EXISTS automation_id UUID REFERENCES test_case_automations(id) ON DELETE SET NULL;

-- Make endpoint_id nullable in api_test_results and link to test_case_id and automation_id
ALTER TABLE api_test_results
  ALTER COLUMN endpoint_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS test_case_id UUID REFERENCES test_cases(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS automation_id UUID REFERENCES test_case_automations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_api_test_results_test_case ON api_test_results(test_case_id);
CREATE INDEX IF NOT EXISTS idx_api_test_results_automation ON api_test_results(automation_id);
CREATE INDEX IF NOT EXISTS idx_test_results_automation ON test_results(automation_id);

-- Link test_runs to requirement doc, test case, and automation script
ALTER TABLE test_runs
  ADD COLUMN IF NOT EXISTS requirement_doc_id UUID REFERENCES requirement_documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS test_case_id UUID REFERENCES test_cases(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS automation_id UUID REFERENCES test_case_automations(id) ON DELETE SET NULL;
