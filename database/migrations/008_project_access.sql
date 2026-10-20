CREATE TABLE IF NOT EXISTS project_access (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  username_enc TEXT,
  password_enc TEXT,
  session_enc TEXT,
  session_saved_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS owner_confirmed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS access_status TEXT NOT NULL DEFAULT 'unknown';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_access_status_check'
  ) THEN
    ALTER TABLE projects ADD CONSTRAINT projects_access_status_check
      CHECK (access_status IN ('unknown', 'public', 'login_required', 'ready', 'failed'));
  END IF;
END $$;
