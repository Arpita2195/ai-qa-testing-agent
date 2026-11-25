-- Migration 017: Functionality Inventory, Scenario Planning & Resumable Loop Generation
-- Creates structured tables for tracking discovered functionalities, planned scenarios, and completeness

CREATE TABLE IF NOT EXISTS functionality_inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category VARCHAR(50) NOT NULL DEFAULT 'functional',
  page_url TEXT NOT NULL,
  page_path TEXT NOT NULL,
  elements JSONB NOT NULL DEFAULT '[]'::jsonb,
  interaction_details JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(30) NOT NULL DEFAULT 'discovered' CHECK (status IN ('discovered', 'in_progress', 'completed', 'failed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_func_inventory_project ON functionality_inventory(project_id);
CREATE INDEX IF NOT EXISTS idx_func_inventory_path ON functionality_inventory(project_id, page_path);

CREATE TABLE IF NOT EXISTS scenario_checklists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  functionality_id UUID NOT NULL REFERENCES functionality_inventory(id) ON DELETE CASCADE,
  scenario_id VARCHAR(100) NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  category VARCHAR(30) NOT NULL CHECK (category IN ('positive', 'negative', 'boundary', 'edge_case')),
  priority VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  expected_behavior TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'generated', 'failed', 'skipped')),
  test_case_id UUID REFERENCES test_cases(id) ON DELETE SET NULL,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_scenario_checklists_project_scenario UNIQUE (project_id, scenario_id)
);

CREATE INDEX IF NOT EXISTS idx_scenario_checklists_proj_func ON scenario_checklists(project_id, functionality_id);
CREATE INDEX IF NOT EXISTS idx_scenario_checklists_status ON scenario_checklists(project_id, status);
CREATE INDEX IF NOT EXISTS idx_scenario_checklists_category ON scenario_checklists(category);

-- Add functionality and scenario linkage columns to test_cases
ALTER TABLE test_cases
  ADD COLUMN IF NOT EXISTS functionality_id UUID REFERENCES functionality_inventory(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS scenario_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'medium';

CREATE INDEX IF NOT EXISTS idx_test_cases_func_id ON test_cases(functionality_id);
CREATE INDEX IF NOT EXISTS idx_test_cases_scenario_id ON test_cases(project_id, scenario_id);

