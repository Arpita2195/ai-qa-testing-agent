-- Migration 021: Atomic AI budget reservations and distributed in-flight coordination
-- Enables atomic reservation before provider dispatch to prevent concurrent budget overruns,
-- and distributed locking to deduplicate identical concurrent AI calls across multiple workers.

CREATE TABLE IF NOT EXISTS ai_budget_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  reserved_tokens INT NOT NULL DEFAULT 0,
  reserved_cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active', -- 'active' | 'reconciled' | 'released' | 'expired'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  reconciled_at TIMESTAMPTZ,
  feature VARCHAR(100),
  user_id UUID
);

CREATE INDEX IF NOT EXISTS idx_ai_budget_reservations_active 
  ON ai_budget_reservations(project_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_ai_budget_reservations_cleanup 
  ON ai_budget_reservations(status, expires_at);

CREATE TABLE IF NOT EXISTS ai_in_flight_locks (
  fingerprint VARCHAR(128) PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  locked_by VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_in_flight_locks_expires 
  ON ai_in_flight_locks(expires_at);
