# Requirements-Based AI Test Case Generation

This document describes the architecture, database schema, AI prompting pipeline, REST API endpoints, security controls, and dashboard user experience for **Task 6: Requirements-Based AI Test Case Generation** in the AI QA Testing Agent.

---

## 1. Overview & Objectives

In modern agile software teams, QA engineers and developers frequently receive functional specifications, Product Requirement Documents (PRDs), user stories, and acceptance criteria in various document formats (PDF, Word DOCX, and TXT). Manually translating these documents into exhaustive test suites covering positive, negative, boundary, and edge-case scenarios is time-consuming and prone to human omission.

Task 6 introduces an end-to-end requirements ingestion and test generation pipeline that:
1. Accepts requirements documents in **PDF**, **DOCX**, and **TXT** formats (up to 10 MB) or direct textual input.
2. Extracts, normalizes, and sanitizes document text.
3. Leverages Google Gemini AI to analyze functional requirements and generate structured test scenarios.
4. Categorizes every generated test case into **positive**, **negative**, **boundary**, and **edge-case** types with prioritized severity.
5. Ingests test cases in `pending` review status linked to both the project and the originating requirement document.
6. Provides an interactive dashboard UI for reviewing, editing, approving, rejecting, and batch-approving test cases.
7. Enforces project-level Role-Based Access Control (RBAC), multi-tenant data isolation, secret redaction, and security audit logging.

---

## 2. Document Processing & Text Extraction Pipeline

The document parser (`src/services/documentParser.ts`) handles file processing with strict security boundaries:

```
Uploaded File (PDF / DOCX / TXT)
      │
      ▼
Size & Extension Validation (<= 10 MB, allowed mime/ext)
      │
      ▼
Format-Specific Extractor
  ├── PDF: pdf-parse / PDFParse engine
  ├── DOCX: mammoth raw text extractor
  └── TXT: utf-8 buffer normalization
      │
      ▼
Sanitization & Normalization (strip control chars, collapse whitespace, redact credentials)
      │
      ▼
Minimum Content Check (>= 20 characters)
      │
      ▼
Requirement Text Ready for Gemini Analysis
```

### Supported Formats & Extraction Engines:
- **PDF (`.pdf`, `application/pdf`)**: Processed using `pdf-parse`, extracting text across all document pages.
- **DOCX (`.docx`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`)**: Processed using `mammoth.extractRawText()`.
- **TXT / Markdown (`.txt`, `.md`, `text/plain`)**: Processed with standard UTF-8 string decoding.
- **Direct Text Input**: Clean string validation directly in JSON request payloads.

### Safeguards:
- **File Size Limit**: Enforces a strict 10 MB limit at both the Fastify multipart transport layer and service layer (`DocumentProcessingError`).
- **Secret Redaction**: Any credentials or sensitive tokens detected in extracted text are redacted before AI prompting.
- **Input Sanitization**: Control characters (except newlines and tabs) and excessive whitespace are stripped.

---

## 3. Gemini AI Prompting & Scenario Diversity

The generator (`src/services/requirementsGenerator.ts`) prompts Gemini with domain-aware guidelines to ensure complete coverage:

### Scenario Breakdown:
1. **Positive Scenarios (`positive`)**: Happy path functional flows where valid inputs and standard workflows produce expected business outcomes.
2. **Negative Scenarios (`negative`)**: Error-handling and validation flows where invalid inputs, missing fields, or unauthorized attempts produce appropriate errors and status codes.
3. **Boundary Scenarios (`boundary`)**: Testing input extremes, minimum/maximum lengths, zero values, off-by-one conditions, and thresholds.
4. **Edge-Case Scenarios (`edge_case`)**: Rare, concurrency, network timeout, special/Unicode characters, or unexpected state transitions.

### Output Schema (Zod Validated):
Every test case returned by Gemini must validate against `requirementTestCaseSchema`:
- `title` (string, 5–150 characters): Concise, descriptive test case title.
- `requirement_description` (string, min 5 chars): Reference to the requirement or user story.
- `preconditions` (string, min 3 chars): Required system setup, active accounts, or initial state.
- `steps` (string array, min 1 step): Actionable, sequential instructions.
- `expected_result` (string, min 3 chars): Concrete, verifiable outcome.
- `priority` (`"low"` | `"medium"` | `"high"` | `"critical"`).
- `test_type` (`"positive"` | `"negative"` | `"boundary"` | `"edge_case"`).

---

## 4. Database Schema & Migration 011

Migration `011_requirements_generation.sql` introduces document tracking and enhances the core `test_cases` table:

### `requirement_documents` Table
```sql
CREATE TABLE requirement_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    filename VARCHAR(255) NOT NULL,
    file_type VARCHAR(10) NOT NULL CHECK (file_type IN ('pdf', 'docx', 'txt')),
    file_size INTEGER NOT NULL,
    extracted_text TEXT NOT NULL,
    generated_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_requirement_documents_project_id ON requirement_documents(project_id);
```

### `test_cases` Table Enhancements
```sql
ALTER TABLE test_cases
  ADD COLUMN IF NOT EXISTS preconditions TEXT,
  ADD COLUMN IF NOT EXISTS test_type VARCHAR(20) CHECK (test_type IN ('positive', 'negative', 'boundary', 'edge_case')),
  ADD COLUMN IF NOT EXISTS requirement_doc_id UUID REFERENCES requirement_documents(id) ON DELETE SET NULL;

CREATE INDEX idx_test_cases_requirement_doc_id ON test_cases(requirement_doc_id);
CREATE INDEX idx_test_cases_test_type ON test_cases(test_type);
```

---

## 5. REST API Endpoints

### 1. `POST /projects/:projectId/requirements/generate`
Uploads a document or sends text, extracts content, queries Gemini AI, and inserts generated test cases with `review_status: 'pending'`.

- **RBAC**: Requires `qa_engineer`, `qa_manager`, or `admin` on the project.
- **Transports**:
  - `multipart/form-data`: Field `file` (PDF, DOCX, TXT).
  - `application/json`: Payload `{ filename: "requirements.txt", text: "..." }`.
- **Response `201 Created`**:
```json
{
  "document": {
    "id": "uuid",
    "filename": "requirements.pdf",
    "fileType": "pdf",
    "fileSize": 45120,
    "wordCount": 850,
    "characterCount": 5420,
    "createdAt": "2026-11-03T10:00:00.000Z"
  },
  "test_cases": [ ... ],
  "generated_count": 8
}
```

### 2. `GET /projects/:projectId/requirements/documents`
Lists all uploaded requirement documents for the project.
- **RBAC**: Requires `viewer`+ on the project.

### 3. `GET /projects/:projectId/requirements/documents/:documentId`
Retrieves a specific requirement document record and its associated test cases.
- **RBAC**: Requires `viewer`+ on the project.

### 4. `POST /projects/:projectId/requirements/batch-approve`
Approves all pending requirement test cases or test cases from a specific document.
- **RBAC**: Requires `qa_manager` or `admin`.
- **Request Body**: `{ "documentId": "uuid" }` or `{ "testCaseIds": ["uuid", ...] }` or `{}` (all pending requirement test cases).
- **Response `200 OK`**: `{ "approved_count": 8, "message": "Successfully approved 8 requirement test cases." }`

### 5. `PATCH /test-cases/:id`
Updates details of an existing test case (title, description, preconditions, steps, expected_result, priority, test_type, review_status).
- **RBAC**:
  - Editing test case details requires `qa_engineer`+.
  - Changing `review_status` requires `qa_manager` or `admin`.
- **Response `200 OK`**: Returns updated test case object with secret redaction.

---

## 6. Role-Based Access Control (RBAC) Summary

| Action | Viewer | QA Engineer | QA Manager | Admin |
| :--- | :---: | :---: | :---: | :---: |
| View Requirement Documents | ✓ | ✓ | ✓ | ✓ |
| View Generated Test Cases | ✓ | ✓ | ✓ | ✓ |
| Upload Documents / Paste Text | ✗ | ✓ | ✓ | ✓ |
| Generate Test Cases via AI | ✗ | ✓ | ✓ | ✓ |
| Edit Test Case Content | ✗ | ✓ | ✓ | ✓ |
| Approve / Reject Test Case | ✗ | ✗ | ✓ | ✓ |
| Batch Approve Test Cases | ✗ | ✗ | ✓ | ✓ |

---

## 7. Dashboard User Experience

Under **Project Detail -> "Requirements" Tab**:
1. **Document Ingest Box**:
   - Toggle between **Document Upload** (PDF, DOCX, TXT with drag-and-drop file picker) and **Paste Text** (textarea with live character count).
   - "Generate Test Cases with AI" button with real-time feedback and animated progress indicators.
2. **Interactive Filters**:
   - Filter by document origin: "All Documents" or a specific uploaded document.
   - Filter by test scenario type: "Positive", "Negative", "Boundary", "Edge Case".
   - Filter by review status: "Pending Review", "Approved", "Rejected".
3. **Test Case Review Cards**:
   - Colored pills for **Test Type** (Green for positive, Red for negative, Purple for boundary, Amber for edge case).
   - Priority indicators (Critical, High, Medium, Low).
   - Numbered steps and highlighted expected results.
   - Precondition callouts.
   - Inline Action Buttons: "Edit", "Approve", "Reject".
4. **Edit Test Case Modal Dialog**:
   - Full form to fine-tune Title, Scenario Type, Priority, Preconditions, Steps (line-delimited), and Expected Result.
   - Status dropdown available for QA Managers.
5. **Batch Approval**:
   - One-click "Batch Approve Pending (N)" button for QA Managers to rapidly approve generated suites.
