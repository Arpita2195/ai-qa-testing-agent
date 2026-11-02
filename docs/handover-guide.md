# AI QA Testing Agent — Platform Handover Guide
**Deliverable 15 | Version 1.0 | Initial Web & API Pilot Handover**

---

## 1. System Overview

The **AI QA Testing Agent** is an automated quality assurance platform built with Node.js, TypeScript, Playwright, and Fastify.

### Core Architectural Principle
> **Deterministic tests decide results.** Automated execution workers (Playwright and API test runners) execute explicit assertions that determine `passed` or `failed`.
>
> The AI (Google Gemini) is strictly used for **test planning**, **test case generation with human review**, **failure diagnostics**, and **root cause analysis**. It **never** decides or modifies test pass/fail outcomes.

---

## 2. Quick Start & Commands

| Task | Command | Description |
| :--- | :--- | :--- |
| **Start Backend Server** | `npm run dev` | Runs Fastify API server with hot reloading on port 3000 |
| **Start QA Dashboard** | `cd dashboard && npm run dev` | Runs React Vite dashboard on port 5173 |
| **Run Database Migrations** | `npm run migrate` | Applies PostgreSQL migrations (001 to 009) |
| **Run Unit & Integration Tests** | `npm test` | Runs all Vitest test suites |
| **Run CI Pipeline Locally** | `npm run test:ci` | Executes automated regression run and generates Markdown report |
| **Deliberate Bug Demonstration** | `npm run demo:bugs` | Executes Deliverable 14 demonstration detecting introduced bugs |

---

## 3. Adding New Applications

### Via React Dashboard
1. Open `http://localhost:5173` and navigate to **Projects**.
2. Click **Create Project** or use **Test New App**:
   - Provide the Project Name (e.g. `StockFlow`, `MyStore`).
   - Enter the Base URL (e.g. `https://stockflow-vert-two.vercel.app`).
   - Check the owner confirmation checkbox.
3. If login is required:
   - Provide test account credentials (stored encrypted with AES-256-GCM in PostgreSQL), OR
   - Click **Start login in browser** to log in manually and save session storage/cookies.

### Via Platform API
```bash
curl -X POST http://localhost:3000/projects \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_PLATFORM_API_KEY" \
  -d '{
    "name": "My New Application",
    "base_url": "https://myapp.test-environment.com",
    "owner_confirmed": true
  }'
```

---

## 4. Test Case Generation & Approval Flow

### Step 1: AI Test Generation
To generate pending tests for an application page:
```bash
curl -X POST http://localhost:3000/projects/{projectId}/generate \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_PLATFORM_API_KEY" \
  -d '{"page_path": "/inventory"}'
```
The AI inspects the page DOM, interactive inputs, and navigation elements, generating positive, negative, and boundary scenarios.

### Step 2: Human Review Gate
- Generated test cases remain with status `pending`.
- **Only approved test cases are executed in the regression suite.**
- Review and approve via Dashboard or API:
```bash
curl -X PATCH http://localhost:3000/test-cases/{testCaseId}/review \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_PLATFORM_API_KEY" \
  -d '{"review_status": "approved"}'
```

---

## 5. Adding Backend API Endpoints

### Option A: Import OpenAPI Specifications
You can import OpenAPI 3.0 / Swagger JSON or YAML files directly:
```bash
curl -X POST http://localhost:3000/projects/{projectId}/api-endpoints/import-openapi \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_PLATFORM_API_KEY" \
  -d '{
    "spec": "{\"openapi\":\"3.0.0\", ...}"
  }'
```

### Option B: Define Endpoints Manually
```bash
curl -X POST http://localhost:3000/projects/{projectId}/api-endpoints \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_PLATFORM_API_KEY" \
  -d '{
    "name": "Get User Profile",
    "method": "GET",
    "path": "/api/users/me",
    "expected_status": 200,
    "expected_fields": { "id": "string", "email": "string" },
    "max_response_ms": 500
  }'
```

---

## 6. Build History, Regressions & Flaky Test Detection

### Compare Two Runs
```bash
GET /projects/{projectId}/runs/compare?baseRunId={baseRunId}&targetRunId={targetRunId}
```
The response computes:
- `regression_detected`: `true` if any tests broke between base and target.
- `new_failures_count`: Tests that previously passed but now fail.
- `fixed_tests_count`: Tests that previously failed and are now fixed.
- `duration_delta_ms`: Execution speed differences.

### Flaky Test Detection
```bash
GET /projects/{projectId}/flaky-tests
```
Aggregates recent runs to identify non-deterministic tests oscillating between pass and fail without code changes, scoring them from `0%` to `100%`.

---

## 7. CI/CD & GitHub Actions Setup

The automated workflow is configured at `.github/workflows/qa-agent.yml`:
1. Add the following repository secrets to your GitHub repository:
   - `GEMINI_API_KEY`: Google Gemini API key.
   - `STOCKFLOW_TEST_EMAIL` / `STOCKFLOW_TEST_PASSWORD`: Credentials for the test account.
2. In pull requests:
   - Tests run automatically in headless Chromium against PostgreSQL.
   - The agent publishes a formatted summary comment on the PR detailing results and AI diagnostics.
   - Defaults to **Report-Only mode**. To block releases on detected regressions, set input `block_release: true` or environment variable `BLOCK_ON_REGRESSION=true`.

---

## 8. Transition to Advanced Phase: Mobile Testing (Weeks 7 to 9)

With the Web and API Pilot (Weeks 1 to 6) complete, the platform is ready for the Advanced Phase:
- **Week 7–8: Android Automation (Appium)**
  - Android emulator workflow support.
  - Taps, scrolling, login, form validation.
  - Background/resume and offline network simulation.
  - Device crash capture and coverage logging.
- **Week 9: iOS Simulator & Final Dashboard Trend Extensions**
  - iOS Simulator workflows (runs on macOS).
  - Cross-platform results in Dashboard and CI.
