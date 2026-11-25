-- Migration 019: Manual Project-Level AI Provider Configuration
-- Stores encrypted credentials, provider type, model, and Ollama endpoint per project

CREATE TABLE IF NOT EXISTS project_ai_configurations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider VARCHAR(30) NOT NULL DEFAULT 'gemini' CHECK (provider IN ('gemini', 'openai', 'ollama', 'groq')),
  model VARCHAR(100),
  api_key_enc TEXT,
  base_url VARCHAR(500),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_project_ai_configurations_project UNIQUE (project_id)
);

CREATE INDEX IF NOT EXISTS idx_project_ai_config_project ON project_ai_configurations(project_id);

-- Add provider column to ai_usage_logs to record telemetry per provider
ALTER TABLE ai_usage_logs ADD COLUMN IF NOT EXISTS provider VARCHAR(30) DEFAULT 'gemini';
CREATE INDEX IF NOT EXISTS idx_ai_usage_provider ON ai_usage_logs(provider);
