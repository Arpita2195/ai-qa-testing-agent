-- Migration 022: Budget reservation heartbeat, ownership token, and uncertainty state
-- Supports long-running AI requests (>5m), distributed single-flight renewals (>60s),
-- and safe accounting for ambiguous timeouts without unmetered quota leaks.

ALTER TABLE ai_budget_reservations
  ADD COLUMN IF NOT EXISTS owner_token VARCHAR(64),
  ADD COLUMN IF NOT EXISTS uncertainty_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_ai_budget_reservations_owner 
  ON ai_budget_reservations(id, owner_token);

CREATE INDEX IF NOT EXISTS idx_ai_budget_reservations_status_expires 
  ON ai_budget_reservations(project_id, status, expires_at);
