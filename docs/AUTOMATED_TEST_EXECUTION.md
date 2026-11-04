# Automated Execution of AI-Generated Test Cases

This document details the architecture, security model, database schema, AI conversion engine, execution runners, and dashboard experience for **Task 7: Automated Execution of AI-Generated Test Cases** in the AI QA Testing Agent.

---

## 1. Overview & Objectives

In Task 6, requirements documents (PDF, DOCX, TXT) were analyzed by Gemini AI to produce structured, reviewable test cases classified into positive, negative, boundary, and edge-case scenarios.

**Task 7** bridges the critical gap between conceptual requirements test cases and concrete, automated execution:
1. Allows QA engineers to select approved requirements-based test cases for automation.
2. Automatically classifies test cases as **Web UI** or **REST API** tests using heuristics and AI analysis.
3. Uses Gemini AI (with a deterministic fallback) to translate natural-language preconditions, steps, and expected results into structured, machine-executable automation models.
4. For Web UI tests, generates safe Playwright-compatible command DSL steps (`goto`, `click`, `fill`, `select`, `expect text`, `expect visible`, `expect not visible`, `expect invalid`).
5. For API tests, generates structured HTTP requests (method, path, headers, payload) and assertion suites (expected status code, required response keys, latency thresholds).
6. Enforces strict command validation: **never evaluates or executes arbitrary AI-generated JavaScript, TypeScript, or shell scripts**.
7. Enforces a **Human-in-the-Loop** model: tests are never run automatically upon generation; QA engineers can review, customize, and edit the automation steps before execution.
8. Reuses the existing Playwright browser runner (`executePageStep`, `runTestCase`) and API runner (`runApiTest`), recording execution logs, screenshots, response snapshots, and test run history.
9. Enforces multi-tenant project isolation, SSRF protection via `urlGuard`, credential redaction, and Role-Based Access Control (RBAC).

---

## 2. Architecture & Design Principles

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Requirements-Based Test Cases                         │
│                    (Status: "approved", linked to Project)                  │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                 Test Classification & AI Conversion Engine                  │
│                   (src/services/automationConverter.ts)                     │
│  - Heuristic & Gemini Target Classifier (Web UI vs REST API)                │
│  - Gemini AI Instruction Generator                                          │
│  - Deterministic Fallback Engine (for offline / test reliability)           │
│  - Strict Whitelist DSL Validator (blocks eval, JS, shell, dangerous URLs)   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                   test_case_automations Database Record                     │
│  - target_type: 'web' | 'api'                                               │
│  - status: 'ready' | 'needs_review'                                         │
│  - web_steps / api_method, api_path, api_body, api_expected_status          │
│  - confidence, reasoning, last_run_id, last_run_status                      │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                    ┌──────────────────┴──────────────────┐
                    ▼                                     ▼
        ┌───────────────────────┐             ┌───────────────────────┐
        │ Human Review & Edit   │             │ Manual Run / Batch    │
        │ (Dashboard Modal UI)  │             │ Execution Trigger     │
        └───────────────────────┘             └───────────┬───────────┘
                                                          │
                    ┌─────────────────────────────────────┘
                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Existing Execution Infrastructure                       │
│                                                                             │
│   Web UI Runner (src/services/runner.ts):                                   │
│     - Headless Chromium (Playwright)                                        │
│     - URL Guard (blocks private IPs, AWS/GCP metadata, loopback)            │
│     - executePageStep (goto, click, fill, select, expect assertions)        │
│     - Artifact storage (evidence screenshots, action traces, console logs)  │
│                                                                             │
│   REST API Runner (src/services/apiRunner.ts):                              │
│     - Outbound HTTP agent with SSRF protection & DNS pin                    │
│     - Status code, latency, and JSON path/field assertions                  │
│     - Response snapshot & timing logs                                       │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                   Test Results & Dashboard Reporting                        │
│  - test_runs (type: 'requirements_web' | 'requirements_api')                │
│  - test_results (Web step logs, error message, screenshot URL)               │
│  - api_test_results (Method, status, response time, assertion passes/fails) │
│  - Audit log entries (action: test_case_automated, test_case_run)           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Web UI vs REST API Classification

The system determines whether a test case exercises a browser interface or an API endpoint using a two-stage approach:

1. **Heuristic Pre-Classifier (`classifyTestType`)**:
   - Inspects test case title, requirement description, preconditions, steps, and expected results.
   - **API Indicators**: Terms like `endpoint`, `request`, `response`, `status code`, `json`, `payload`, `header`, `token`, `bearer`, `200 ok`, `201 created`, `400 bad request`, `401 unauthorized`, `403 forbidden`, `404 not found`, `500 internal`, `get /`, `post /`, `put /`, `delete /`, `patch /`, `rest api`, `query param`, `graphql`.
   - **Web UI Indicators**: Terms like `click`, `button`, `input`, `form`, `page`, `screen`, `modal`, `dialog`, `navbar`, `dropdown`, `select`, `enter`, `fill`, `navigate`, `browser`, `url`, `view`, `render`, `visible`, `checkbox`, `link`.
   - If clear API markers dominate, sets target to `api`; if UI markers dominate, sets target to `web`.

2. **Gemini AI Classification & Conversion**:
   - When Gemini is queried, the prompt passes the target classification hypothesis and requests explicit reasoning and confidence score (`0.0`–`1.0`).
   - If confidence is below `0.70`, the automation record is flagged with status `needs_review` to alert the user that human verification is recommended before execution.

---

## 4. Playwright Web UI DSL & Security Validation

To completely eliminate the risk of remote code execution (RCE) or arbitrary script injection from AI outputs, the runner **does not evaluate JavaScript or execute raw `.spec.ts` files**.

Instead, it generates and executes a strict, declarative Domain-Specific Language (DSL) that maps 1-to-1 to verified Playwright actions:

### Supported Command Grammar:
| Command Syntax | Playwright Mapping | Description |
|---|---|---|
| `goto <url_or_path>` | `page.goto(targetUrl)` | Navigates to a relative path or absolute verified URL. |
| `click <selector>` | `page.click(selector)` | Clicks a button, link, checkbox, or DOM element. |
| `fill <selector> <value>` | `page.fill(selector, value)` | Fills a text input or textarea with the provided value. |
| `select <selector> <value>` | `page.selectOption(selector, value)` | Selects an option in a `<select>` dropdown. |
| `expect visible <selector>` | `expect(locator).toBeVisible()` | Asserts that an element is present and visible. |
| `expect not visible <selector>`| `expect(locator).toBeHidden()` | Asserts that an element is hidden or detached. |
| `expect text <selector> <text>`| `expect(locator).toHaveText()` | Asserts that an element contains expected text. |
| `expect invalid <selector>` | `expect(locator.evaluate(...))` | Asserts HTML5 form validation failure or invalid state. |

### Validation Rules (`validateAutomationInstructions`):
1. **Command Whitelist**: Every line must strictly begin with one of the allowed action keywords.
2. **Disallowed Keywords**: Explicitly blocks any presence of `eval`, `process`, `child_process`, `import`, `require`, `exec`, `spawn`, `fs`, `global`, `function`, `=>`, `<script>`, `document.cookie`, `localStorage`.
3. **Selector Sanitization**: Selectors must not contain `javascript:`, `data:`, or unescaped injection markers.
4. **URL Safety**: Relative paths must start with `/`. Absolute URLs must start with `http://` or `https://` and pass `urlGuard` host and IP checks.

---

## 5. REST API Automation Model & Assertion Suite

For API test cases, the converter outputs structured HTTP request configurations and assertion criteria:

### Request Model:
- **HTTP Method**: `GET`, `POST`, `PUT`, `PATCH`, or `DELETE`.
- **API Path**: Relative path (e.g. `/api/v1/auth/login`) or absolute path within project target scope.
- **Headers**: Key-value dictionary (e.g. `{"Content-Type": "application/json"}`).
- **Body**: Optional structured JSON payload.

### Assertion Model:
- **Expected Status Code**: Integer HTTP status (e.g., `200`, `201`, `400`, `401`, `404`).
- **Required Response Fields**: Array of property paths expected to be present in the JSON response (e.g., `["token", "user.id", "status"]`).
- **Max Latency**: Execution SLA threshold in milliseconds (default: `5000ms`).

The existing `runApiTest` service executes the request using an SSRF-hardened HTTP client, validates DNS resolution against SSRF blacklists, measures response duration, checks assertions, and saves detailed results.

---

## 6. Database Schema & Migration 012

Migration `database/migrations/012_test_case_automations.sql` introduces the `test_case_automations` table and links all downstream test execution artifacts:

```sql
CREATE TABLE test_case_automations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    test_case_id UUID NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    target_type VARCHAR(10) NOT NULL CHECK (target_type IN ('web', 'api')),
    status VARCHAR(20) NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'needs_review', 'disabled')),
    
    -- Web UI automation steps (JSON array of DSL strings)
    web_steps JSONB DEFAULT '[]'::jsonb,
    
    -- API automation parameters
    api_method VARCHAR(10) CHECK (api_method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
    api_path TEXT,
    api_headers JSONB DEFAULT '{}'::jsonb,
    api_body JSONB,
    api_expected_status INTEGER,
    api_expected_fields JSONB DEFAULT '[]'::jsonb,
    api_max_response_ms INTEGER DEFAULT 5000,
    
    -- AI metadata
    confidence NUMERIC(3, 2) NOT NULL DEFAULT 1.0,
    reasoning TEXT,
    
    -- Execution tracking
    last_run_id UUID REFERENCES test_runs(id) ON DELETE SET NULL,
    last_run_status VARCHAR(20),
    last_run_at TIMESTAMP WITH TIME ZONE,
    last_error_message TEXT,
    
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    CONSTRAINT uq_test_case_automation UNIQUE (test_case_id)
);

-- Link automations and requirements to test results and test runs
ALTER TABLE test_results ADD COLUMN automation_id UUID REFERENCES test_case_automations(id) ON DELETE SET NULL;
ALTER TABLE api_test_results ADD COLUMN test_case_id UUID REFERENCES test_cases(id) ON DELETE SET NULL;
ALTER TABLE api_test_results ADD COLUMN automation_id UUID REFERENCES test_case_automations(id) ON DELETE SET NULL;
ALTER TABLE test_runs ADD COLUMN requirement_doc_id UUID REFERENCES requirement_documents(id) ON DELETE SET NULL;
ALTER TABLE test_runs ADD COLUMN test_case_id UUID REFERENCES test_cases(id) ON DELETE SET NULL;
ALTER TABLE test_runs ADD COLUMN automation_id UUID REFERENCES test_case_automations(id) ON DELETE SET NULL;
```

---

## 7. Review & Human-in-the-Loop Workflow

To maintain absolute control over production testing:
1. **Only Approved Test Cases Can Be Automated**: Test cases in `pending` or `rejected` status cannot be converted into automations.
2. **Never Auto-Run**: Conversion creates automation records in `ready` or `needs_review` status without triggering execution.
3. **Visual Review & In-Place Editing**:
   - The dashboard provides a dedicated **"Automations"** tab.
   - Clicking **"Edit Steps"** opens a modal dialog where QA engineers can adjust Web DSL steps or modify API request methods, paths, headers, payloads, and expected status codes.
   - Any manual edit is strictly re-validated through `validateAutomationInstructions` before saving.
4. **Execution Triggers**: Tests run only when a user explicitly clicks **"Run Test"** or **"Run All Ready Automations"**.

---

## 8. REST API Reference

All automation endpoints require JWT authentication and project-level authorization.

| Method | Endpoint | Minimum Role | Description |
|---|---|---|---|
| `POST` | `/projects/:projectId/automations/generate` | `qa_engineer` | Converts one or more approved test cases into automation records. |
| `GET` | `/projects/:projectId/automations` | `viewer` | Lists all automations for a project with execution statistics and test case links. |
| `GET` | `/automations/:id` | `viewer` | Fetches a single automation record by UUID. |
| `PATCH` | `/automations/:id` | `qa_engineer` | Updates automation configuration, web steps, or API request parameters. |
| `POST` | `/automations/:id/run` | `qa_engineer` | Executes an individual automation test case via Playwright or API runner. |
| `POST` | `/projects/:projectId/automations/batch-run` | `qa_engineer` | Executes all ready automations for the project in sequence. |

---

## 9. Role-Based Access Control (RBAC) Matrix

| Action | Admin | QA Engineer | Developer | Viewer |
|---|:---:|:---:|:---:|:---:|
| View Automations List | Allowed | Allowed | Allowed | Allowed |
| View Automation Details & Logs | Allowed | Allowed | Allowed | Allowed |
| Generate Automation from Approved Test Case | Allowed | Allowed | Denied (403) | Denied (403) |
| Edit Automation Steps / API Payload | Allowed | Allowed | Denied (403) | Denied (403) |
| Execute Individual Test Case | Allowed | Allowed | Denied (403) | Denied (403) |
| Batch Execute Automations | Allowed | Allowed | Denied (403) | Denied (403) |

---

## 10. Dashboard User Experience

The dashboard includes a dedicated **Automations** tab alongside **Requirements**:

1. **Requirements Tab Integration**:
   - Displays a prominent `⚡ Automate with AI` button next to each approved test case.
   - A batch action `⚡ Automate Approved Test Cases` converts all approved cases in one click.
2. **Automations Tab Capabilities**:
   - **Target Filter**: Filter between `All`, `Web UI`, and `REST API`.
   - **Status & Results Filter**: Filter by `Passed`, `Failed`, or `Needs Review`.
   - **Review / Edit Modal**: Visual inspection of steps, validation error highlights, and live JSON payload editing.
   - **Direct Run**: One-click execution with immediate progress indication and result display (status, duration, error details, and links to screenshots).
   - **Batch Execution**: Run all ready automations with a summary of passes and failures.

---

## 11. Security & Safety Summary

- **No Code Execution (`eval` / `vm2` / `exec`)**: Test scripts are stored as structured DSL lines and executed via predefined Playwright driver calls.
- **SSRF & URL Whitelisting**: All endpoints and navigation URLs are passed through `urlGuard` to prevent attacks on loopback, private IPv4/IPv6, and cloud metadata services.
- **Input Sanitization**: Web steps and API parameters are validated against strict Zod schemas and regex rules.
- **Audit Logging**: Every generation, edit, and execution event is logged to `audit_logs` with the actor's user ID, IP address, and timestamp.
- **Multi-Tenant Isolation**: Project ownership checks and RBAC middleware guarantee that users can never access or run automations outside their authorized projects.

---

## 12. Verification & Test Suite

The automated test suite (`src/__tests__/automatedExecution.test.ts`) verifies 15 targeted scenarios:
- Target classification for Web UI test cases.
- Target classification for REST API test cases.
- Strict command DSL validation rejecting illegal keywords (`eval`, `child_process`).
- Validation of valid Web UI DSL instructions.
- Validation of valid REST API specifications.
- Deterministic fallback automation for Web UI test cases.
- Deterministic fallback automation for REST API test cases.
- Gemini AI conversion schema adherence.
- RBAC enforcement (blocking unauthenticated and unauthorized requests).
- Rejection of unapproved or rejected test cases.
- Safe review and editing of automation steps before execution.
- Rejection of malicious edits during automation updates.
- End-to-end execution of Web UI automations via `runTestCase`.
- End-to-end execution of REST API automations via `runApiTest`.
- Batch execution of project automations.

All 15 tests pass alongside the existing 156 project tests (171 passing in total across 21 test suites).
