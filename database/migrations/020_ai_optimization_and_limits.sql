-- Migration 020: AI Cost and Performance Optimization (Stage 3D)
-- Adds usage budget limits, response cache, and cache event metrics

-- 1. Add budget & optimization controls to project_ai_configurations
ALTER TABLE project_ai_configurations
  ADD COLUMN IF NOT EXISTS usage_limit_period VARCHAR(20) NOT NULL DEFAULT 'monthly' CHECK (usage_limit_period IN ('daily', 'monthly')),
  ADD COLUMN IF NOT EXISTS max_cost_limit_usd NUMERIC(10, 4) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS max_token_limit BIGINT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS warning_threshold_percent INT NOT NULL DEFAULT 80 CHECK (warning_threshold_percent >= 1 AND warning_threshold_percent <= 100),
  ADD COLUMN IF NOT EXISTS cache_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS cache_ttl_seconds INT NOT NULL DEFAULT 86400 CHECK (cache_ttl_seconds >= 60);

-- 2. AI Response Cache table for deterministic query reuse
CREATE TABLE IF NOT EXISTS ai_response_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cache_key VARCHAR(64) NOT NULL,
  provider VARCHAR(30) NOT NULL,
  model VARCHAR(100) NOT NULL,
  feature VARCHAR(50) NOT NULL,
  prompt_tokens INT NOT NULL DEFAULT 0,
  completion_tokens INT NOT NULL DEFAULT 0,
  total_tokens INT NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0,
  response_text TEXT NOT NULL,
  hit_count INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_hit_at TIMESTAMPTZ,
  CONSTRAINT uq_ai_response_cache_project_key UNIQUE (project_id, cache_key)
);

CREATE INDEX IF NOT EXISTS idx_ai_cache_project ON ai_response_cache(project_id);
CREATE INDEX IF NOT EXISTS idx_ai_cache_expires ON ai_response_cache(expires_at);

-- 3. Telemetry table for tracking cache hits and saved tokens/costs
CREATE TABLE IF NOT EXISTS ai_cache_savings_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cache_id UUID REFERENCES ai_response_cache(id) ON DELETE SET NULL,
  feature VARCHAR(50) NOT NULL,
  provider VARCHAR(30) NOT NULL,
  model VARCHAR(100) NOT NULL,
  saved_tokens INT NOT NULL DEFAULT 0,
  saved_cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_cache_savings_project ON ai_cache_savings_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_ai_cache_savings_created ON ai_cache_savings_logs(created_at);
