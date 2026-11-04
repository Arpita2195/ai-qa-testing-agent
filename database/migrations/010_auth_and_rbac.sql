-- Migration 010: Authentication, RBAC, Website Authorizations, and Security Audit Logging

-- 1. Users Table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'qa_manager', 'qa_engineer', 'viewer')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_email_idx ON users(email);
CREATE INDEX IF NOT EXISTS users_role_idx ON users(role);

-- 2. Sessions Table (Server-managed sessions with hashed tokens and CSRF protection)
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sessions_token_hash_idx ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

-- 3. Project Memberships Table (User-to-project role assignments)
CREATE TABLE IF NOT EXISTS project_members (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'qa_engineer' CHECK (role IN ('qa_manager', 'qa_engineer', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS project_members_user_id_idx ON project_members(user_id);
CREATE INDEX IF NOT EXISTS project_members_project_id_idx ON project_members(project_id);

-- 4. Projects Schema Enhancement (Metadata for Website Authorization Confirmation)
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS owner_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS owner_confirmed_by UUID REFERENCES users(id) ON DELETE SET NULL;

UPDATE projects
SET owner_confirmed_at = created_at
WHERE owner_confirmed = TRUE AND owner_confirmed_at IS NULL;

-- 5. Website Authorizations Table (Immutable record of user declarations)
CREATE TABLE IF NOT EXISTS website_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  target_url TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  declaration_text TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS website_authorizations_project_id_idx ON website_authorizations(project_id);
CREATE INDEX IF NOT EXISTS website_authorizations_user_id_idx ON website_authorizations(user_id);

-- 6. Audit Logs Table
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  target_resource TEXT,
  outcome TEXT NOT NULL DEFAULT 'success' CHECK (outcome IN ('success', 'failure', 'denied')),
  details JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_logs_actor_id_idx ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS audit_logs_project_id_idx ON audit_logs(project_id);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs(action);
CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs(created_at DESC);

-- 7. Seed Initial Platform Admin if users table is empty
DO $$
DECLARE
  admin_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin') THEN
    INSERT INTO users (email, password_hash, full_name, role)
    VALUES (
      'admin@qa-testing.local',
      'scrypt:N=16384,r=8,p=1$5cda14656a7bfe796f9b9cf07a40f1be$1b743fa977962b15bb4418eec6b4cf8a8d603638cf034b795ec7baf68b024d78f3989f8377a6e7e9be204ffd66a9288cb01bc7d6d84b6c79b17669426fa921c2',
      'Platform Administrator',
      'admin'
    )
    RETURNING id INTO admin_id;

    -- Add admin to all existing projects as QA Manager
    INSERT INTO project_members (project_id, user_id, role)
    SELECT id, admin_id, 'qa_manager'
    FROM projects
    ON CONFLICT (project_id, user_id) DO NOTHING;
  END IF;
END $$;
