-- Migration 013: Advanced Execution, Schedules, Multi-Step API, and Flaky Detection

-- 1. Multi-Step API Support in Automations
ALTER TABLE test_case_automations
  ADD COLUMN IF NOT EXISTS api_steps JSONB DEFAULT '[]'::jsonb;

-- 2. Retry, Flaky, and Step Tracking in Test Results
ALTER TABLE test_results
  ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS flaky BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS attempts JSONB DEFAULT '[]'::jsonb;

ALTER TABLE api_test_results
  ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS flaky BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS attempts JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS step_results JSONB DEFAULT '[]'::jsonb;

-- 3. Run Level Concurrency, Retries, and Flaky Aggregates
ALTER TABLE test_runs
  ADD COLUMN IF NOT EXISTS concurrency INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS retries INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS flaky_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS inconclusive_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skipped_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_count INTEGER DEFAULT 0;

-- 4. Test Schedules Table
CREATE TABLE IF NOT EXISTS test_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  suite_id UUID REFERENCES suites(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  schedule_type VARCHAR(20) NOT NULL CHECK (schedule_type IN ('hourly', 'daily', 'weekly', 'custom_cron')),
  cron_expression VARCHAR(100),
  concurrency INTEGER NOT NULL DEFAULT 2 CHECK (concurrency >= 1 AND concurrency <= 10),
  retries INTEGER NOT NULL DEFAULT 1 CHECK (retries >= 0 AND retries <= 5),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  next_run_at TIMESTAMP WITH TIME ZONE,
  last_run_at TIMESTAMP WITH TIME ZONE,
  last_run_status VARCHAR(20),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_test_schedules_project ON test_schedules(project_id);
CREATE INDEX IF NOT EXISTS idx_test_schedules_active_next ON test_schedules(is_active, next_run_at);

-- 5. Test Schedule Runs History Table
CREATE TABLE IF NOT EXISTS test_schedule_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID NOT NULL REFERENCES test_schedules(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id UUID REFERENCES test_runs(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  summary JSONB DEFAULT '{}'::jsonb,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_test_schedule_runs_schedule ON test_schedule_runs(schedule_id);
CREATE INDEX IF NOT EXISTS idx_test_schedule_runs_project ON test_schedule_runs(project_id);
