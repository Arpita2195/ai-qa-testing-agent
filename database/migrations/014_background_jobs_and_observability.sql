-- Migration 014: Background Job Processing, Job Tracking, and AI Observability Telemetry

-- 1. Background Jobs Queue Table (Permanent source of truth for all async jobs)
CREATE TABLE IF NOT EXISTS background_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  queue_name VARCHAR(50) NOT NULL,
  job_type VARCHAR(50) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'completed', 'failed', 'retrying', 'cancelled')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB,
  error_message TEXT,
  retries INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  concurrency_key VARCHAR(100),
  deduplication_id VARCHAR(255),
  enqueued_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  queue_delay_ms INTEGER,
  duration_ms INTEGER,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_background_jobs_poll ON background_jobs (status, enqueued_at) WHERE status IN ('pending', 'retrying');
CREATE INDEX IF NOT EXISTS idx_background_jobs_queue_status ON background_jobs (queue_name, status);
CREATE INDEX IF NOT EXISTS idx_background_jobs_project ON background_jobs (project_id);
CREATE INDEX IF NOT EXISTS idx_background_jobs_dedup ON background_jobs (deduplication_id) WHERE deduplication_id IS NOT NULL;

-- 2. AI Usage & Token Tracking Table
CREATE TABLE IF NOT EXISTS ai_usage_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  feature VARCHAR(50) NOT NULL,
  model VARCHAR(100) NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_project ON ai_usage_logs (project_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_created_at ON ai_usage_logs (created_at);

-- 3. Artifact Storage Metadata Table (Tracks S3 / MinIO / Local storage location and keys)
CREATE TABLE IF NOT EXISTS stored_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  run_id UUID REFERENCES test_runs(id) ON DELETE CASCADE,
  result_id UUID,
  artifact_type VARCHAR(50) NOT NULL, -- 'screenshot', 'trace', 'report_html', 'report_json', 'evidence'
  storage_provider VARCHAR(20) NOT NULL DEFAULT 'local', -- 'local', 's3', 'minio'
  storage_key VARCHAR(500) NOT NULL,
  content_type VARCHAR(100) NOT NULL,
  size_bytes BIGINT DEFAULT 0,
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stored_artifacts_run ON stored_artifacts (run_id);
CREATE INDEX IF NOT EXISTS idx_stored_artifacts_key ON stored_artifacts (storage_key);
CREATE INDEX IF NOT EXISTS idx_stored_artifacts_project ON stored_artifacts (project_id);
