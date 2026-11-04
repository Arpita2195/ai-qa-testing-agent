-- Migration 015: Mobile Application Testing (Android & iOS Architecture)

-- 1. Update test_runs run_type constraint to allow 'mobile'
ALTER TABLE test_runs
  DROP CONSTRAINT IF EXISTS test_runs_run_type_check;

ALTER TABLE test_runs
  ADD CONSTRAINT test_runs_run_type_check
  CHECK (run_type IN ('web', 'api', 'suite', 'visual', 'mobile'));

-- 2. Update test_case_automations target_type constraint to allow 'mobile'
ALTER TABLE test_case_automations
  DROP CONSTRAINT IF EXISTS test_case_automations_target_type_check;

ALTER TABLE test_case_automations
  ADD CONSTRAINT test_case_automations_target_type_check
  CHECK (target_type IN ('web', 'api', 'mobile'));

-- 3. Add mobile automation columns to test_case_automations
ALTER TABLE test_case_automations
  ADD COLUMN IF NOT EXISTS mobile_steps JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS app_package TEXT,
  ADD COLUMN IF NOT EXISTS app_activity TEXT,
  ADD COLUMN IF NOT EXISTS device_udid TEXT,
  ADD COLUMN IF NOT EXISTS platform VARCHAR(20) DEFAULT 'android' CHECK (platform IN ('android', 'ios'));

-- 4. Add device_info and mobile_evidence to test_results
ALTER TABLE test_results
  ADD COLUMN IF NOT EXISTS device_info JSONB DEFAULT '{}'::jsonb;

-- 5. Mobile devices configuration table
CREATE TABLE IF NOT EXISTS mobile_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  platform VARCHAR(20) NOT NULL DEFAULT 'android' CHECK (platform IN ('android', 'ios')),
  udid VARCHAR(100) NOT NULL,
  os_version VARCHAR(50),
  appium_url VARCHAR(255) NOT NULL DEFAULT 'http://127.0.0.1:4723',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mobile_devices_project ON mobile_devices(project_id);
CREATE INDEX IF NOT EXISTS idx_mobile_devices_platform ON mobile_devices(platform);

