-- Migration 023: Two-Stage AI Review with Gemini Primary and Groq Independent Reviewer
-- Supports separate provider credentials, two-stage configuration, and AI review metadata

-- 1. Create project-level provider credentials table supporting multiple providers per project
CREATE TABLE IF NOT EXISTS project_ai_provider_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider VARCHAR(30) NOT NULL CHECK (provider IN ('gemini', 'openai', 'ollama', 'groq')),
  api_key_enc TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_project_provider_credential UNIQUE (project_id, provider),
  CONSTRAINT chk_provider_key CHECK (provider = 'ollama' OR api_key_enc IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_project_ai_provider_credentials_project 
  ON project_ai_provider_credentials(project_id);

-- 2. Add two-stage review settings to project_ai_configurations
ALTER TABLE project_ai_configurations
  ADD COLUMN IF NOT EXISTS two_stage_review_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS review_model VARCHAR(100) DEFAULT 'openai/gpt-oss-120b';

-- 3. Add AI review metadata to test_cases
ALTER TABLE test_cases
  ADD COLUMN IF NOT EXISTS ai_review_metadata JSONB DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_test_cases_ai_review_status 
  ON test_cases ((ai_review_metadata->>'review_status'));
