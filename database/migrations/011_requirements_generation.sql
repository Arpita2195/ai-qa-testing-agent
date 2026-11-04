-- Migration 011: Requirements-Based AI Test Case Generation
-- Supports uploading PDF, DOCX, TXT requirements and tracking requirement-based test cases

CREATE TABLE IF NOT EXISTS requirement_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    filename TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    extracted_text TEXT NOT NULL,
    generated_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_req_docs_project ON requirement_documents(project_id);

ALTER TABLE test_cases
    ADD COLUMN IF NOT EXISTS preconditions TEXT,
    ADD COLUMN IF NOT EXISTS test_type TEXT NOT NULL DEFAULT 'positive',
    ADD COLUMN IF NOT EXISTS requirement_doc_id UUID REFERENCES requirement_documents(id) ON DELETE SET NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'test_cases_test_type_check'
    ) THEN
        ALTER TABLE test_cases ADD CONSTRAINT test_cases_test_type_check
            CHECK (test_type IN ('positive', 'negative', 'boundary', 'edge_case'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_test_cases_req_doc ON test_cases(requirement_doc_id);
CREATE INDEX IF NOT EXISTS idx_test_cases_test_type ON test_cases(test_type);
