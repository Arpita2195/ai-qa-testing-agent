-- Migration 018: Autonomous Website Exploration & Recursive Crawler Engine
-- Creates tables for tracking crawl sessions, crawled pages, DOM fingerprints, and element categorization.

CREATE TABLE IF NOT EXISTS crawl_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status VARCHAR(30) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed', 'stopped')),
  start_url TEXT NOT NULL,
  max_depth INTEGER NOT NULL DEFAULT 3,
  max_pages INTEGER NOT NULL DEFAULT 25,
  pages_crawled INTEGER NOT NULL DEFAULT 0,
  pages_failed INTEGER NOT NULL DEFAULT 0,
  functionalities_discovered INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  error_message TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crawl_sessions_project ON crawl_sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_crawl_sessions_status ON crawl_sessions(status);

CREATE TABLE IF NOT EXISTS crawled_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id UUID REFERENCES crawl_sessions(id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  path TEXT NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(30) NOT NULL DEFAULT 'visited' CHECK (status IN ('queued', 'visited', 'failed', 'skipped')),
  title TEXT,
  page_type VARCHAR(50) NOT NULL DEFAULT 'general' CHECK (page_type IN ('auth', 'dashboard', 'list_table', 'form_editor', 'detail_view', 'settings', 'static', 'general')),
  element_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  dom_fingerprint VARCHAR(64),
  scraped_data JSONB,
  error_message TEXT,
  duration_ms INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_crawled_pages_project_url UNIQUE (project_id, url)
);

CREATE INDEX IF NOT EXISTS idx_crawled_pages_proj_url ON crawled_pages(project_id, url);
CREATE INDEX IF NOT EXISTS idx_crawled_pages_session ON crawled_pages(session_id);
CREATE INDEX IF NOT EXISTS idx_crawled_pages_type ON crawled_pages(project_id, page_type);
CREATE INDEX IF NOT EXISTS idx_crawled_pages_fingerprint ON crawled_pages(project_id, dom_fingerprint);

