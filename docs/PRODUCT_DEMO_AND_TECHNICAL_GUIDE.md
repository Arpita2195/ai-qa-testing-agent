# QA Control: Product Demo and Technical Guide

This guide is a manager-ready walkthrough of QA Control: what it does, how a user demonstrates it, and how the main technical pieces work together. It describes the implementation in this repository; it does not imply that every external integration is configured in every environment.

## 1. Product summary

QA Control is a project-based quality assurance platform. It brings test discovery, test case review, web/API/mobile automation, visual comparison, scheduled runs, reports, bug triage, team access, and operational monitoring into one dashboard.

The central workflow is:

1. Create a project for an application or API you are authorized to test.
2. Discover test ideas from the running site, or derive them from a requirements document.
3. Review and approve the generated cases.
4. Convert approved cases into web, API, or mobile automation; inspect and edit the generated instructions.
5. Run tests individually, as a group, through a suite, or on a schedule.
6. Review results and evidence, investigate failures, and compare runs.
7. Track system health, background work, users, permissions, and audit events.

AI assists with drafting test cases, converting cases into executable instructions, and analyzing failures. QA staff remain responsible for review, approval, test data, and deciding whether an observed change is a defect. The application does not promise that generated tests are correct or that a green test run proves an application is defect-free.

## 2. Suggested 12–15 minute demo

### Before the meeting

- Start the application and verify that the dashboard, backend, and database are healthy.
- Sign in with an account whose role permits the screens you plan to show.
- Have one demo project with an authorized, reachable target URL.
- Prefer a disposable/staging app and seeded test data. Do not demonstrate destructive actions against production.
- If showing AI generation, verify `GEMINI_API_KEY` and the configured model are available.
- If showing mobile, verify Appium is reachable and an Android emulator/device is online. Otherwise explain the requirement and show the status screen rather than implying mobile execution is available.
- If showing scheduled jobs, have a suite containing approved cases/endpoints. A schedule with an empty suite has nothing useful to execute.
- If using Docker Compose, the dashboard/API defaults are normally `http://localhost:5173` and `http://localhost:3000`; use the ports configured for the current environment.

### Walkthrough

| Time | Screen/action | Suggested explanation |
|---|---|---|
| 1 min | Sign in, open **Projects** | “Work is organized by project. Each project identifies a target application and has its own cases, runs, suites, schedules, and team.” |
| 1 min | Open a project | Point out the target URL, authorization declaration, and project tabs. Project creation requires the user to confirm they own the target or have permission to test it. |
| 2 min | **Requirements** or **Test Cases** | Upload/paste a small requirements document or show existing cases. Explain that AI output is a draft and must be reviewed before approval. |
| 2 min | **Automations** | Show a generated web/API automation, inspect the steps, and explain the safe, constrained instruction format. Run one small, non-destructive test. |
| 1 min | **API Endpoints** | Show an endpoint or imported OpenAPI operation, its expected status/fields, approval status, then run approved endpoints. |
| 1 min | **Suites** | Show how approved cases/endpoints are grouped for a coordinated run. |
| 1 min | **Runs** | Open a run and explain pass/fail/inconclusive/skipped, duration, retry/flaky history, and evidence. |
| 1 min | **Visual** | Explain screenshot baseline creation, review/approval, and subsequent pixel-difference review. |
| 1 min | **Schedules** and **Jobs & Monitoring** | Show a suite schedule and distinguish the schedule trigger from the background job and from the test result. |
| 1 min | **Bug reports**, **Team**, or **Observability** | Show failure triage, project access, or health/telemetry, depending on manager interest. |
| 1 min | Explain CI/CD and architecture | CI is available as a manually dispatched GitHub Actions workflow. Explain what it checks and what data/setup it needs. |

### A concise opening

> “QA Control helps a team turn requirements and application behavior into reviewable test cases, execute approved web/API/mobile checks, retain results and evidence, and monitor the testing system. AI speeds up drafting and analysis, while people control approval and release decisions.”

### A concise close

> “The value is a traceable loop from requirement to approved test, execution, evidence, and triage. The next steps for a production rollout are to connect a stable staging environment, define safe test data, validate permissions and secrets, and wire a seeded dataset into CI.”

## 3. Application layout and feature guide

The global sidebar provides Projects, Bug reports, Observability, and (for platform administrators) User management. Inside a project, the dashboard provides the following tabs.

### Projects

A project stores the target base URL and project-specific QA assets. Creating one records an explicit authorization declaration; the project creator is assigned project QA Manager access. The URL is checked by the target URL security guard. Use targets you own or are explicitly authorized to test.

### Test Cases

This area contains cases discovered from the target website or created for a project. Website discovery reads pages and asks the configured Gemini model to propose cases. Generated cases are saved as **pending**, duplicates are skipped, and reviewers can approve or reject them. Approved cases can be run with the web runner.

Test cases describe steps and expected outcomes. A case is not an executable script until it is converted into an automation (or otherwise run through the web-case path). Reviewing selectors, navigation, credentials, and data-changing steps before approval is important.

### Requirements

Requirements can be uploaded as PDF, DOCX, or TXT, or supplied as text. The backend extracts text, stores the document record, and asks Gemini for structured cases covering positive, negative, boundary, and edge-case scenarios. The generated cases can be filtered, edited, reviewed, and approved. Approved cases can then be converted into automation.

For the demo, use a short synthetic or non-confidential requirements sample. Do not upload sensitive company documents unless the organization has approved the AI service and its data handling.

### Automations

Automations are generated from cases and divided into target types:

- **Web:** ordered steps executed by Playwright in a headless Chromium browser.
- **API:** HTTP method/path, optional headers/body, expected status and response assertions. Multi-step API automation can extract a value from a response and reuse it in a later request.
- **Mobile:** Android/iOS metadata and mobile DSL steps; execution requires its external device/Appium environment.

Generated instructions can be edited and validated. Web automation accepts a limited command language such as `goto`, `click`, `fill`, `select`, `expect`, `wait`, and `screenshot`; it is not intended to run arbitrary generated JavaScript or shell commands. Run an individual automation to inspect its outcome, or run the approved batch.

AI output is a starting point: incorrect selectors, wrong assumptions, missing test data, or inaccessible pages can still cause failure. Use the result evidence and error details to refine the automation.

### API Endpoints

Add a simple endpoint or import an OpenAPI JSON/YAML specification. Imported operations are pending and should be reviewed before approval. An endpoint contains the HTTP method/path and assertions such as expected status, expected response fields, or response-time limit. **Run approved** executes approved endpoints relative to the project’s base URL and saves an API run with per-endpoint results.

Endpoint runs send real HTTP requests to the configured target. POST/PUT/PATCH/DELETE may modify data; use safe test fixtures and a disposable environment.

### Mobile Testing

This tab reports Appium/driver/device status, lists mobile automations and mobile runs, and supports authoring/validating mobile DSL instructions. A configured Android device/emulator and Appium server are required for an actual run. iOS status is shown separately; real iOS automation also depends on the host/device infrastructure and drivers being installed.

### Suites

A suite is a reusable group of **approved** web cases and/or approved API endpoints. A QA Manager (or Administrator) creates the suite and adds its members. Running the suite records a suite run and result details. The suite executor supports bounded concurrency and retries; a retry that eventually passes can still be marked flaky, so inspect its attempt history.

Unapproved or missing members are not valid suite inputs. In a demo, build and approve the suite before scheduling it.

### Schedules

A schedule associates a suite with an enabled/paused recurring trigger. The form supports hourly, daily, weekly, or a basic five-field custom cron expression, plus concurrency and retry settings. It records next and last execution metadata and has a **Run now** action.

The backend scheduler polls for due schedules every 30 seconds in the running process. For hourly/daily/weekly options, the implementation computes the next timestamp as an interval after the current time. Custom cron currently supports a limited set of field patterns; it is not a complete cron implementation with full timezone and syntax support. Confirm the next-run display in the target environment before presenting a custom schedule as a precise calendar-time commitment.

### Runs

Runs is the execution history for the selected project. It includes run status, result counts, trends, comparisons, and flaky-test information. Opening a run shows individual test results and, where available, screenshots, traces, API response details, and reports.

- **Passed:** all evaluated assertions passed.
- **Failed:** at least one test/assertion failed.
- **Inconclusive:** execution could not establish a test outcome, for example due to an infrastructure issue.
- **Skipped:** the item was not executed under the selected run conditions.
- **Flaky:** outcome varied across attempts/runs. A pass after retry is not equivalent to a consistently passing test.

“Compare latest builds” or selected runs helps identify new, recurring, or fixed failures and duration changes. A comparison is only meaningful when the two runs are comparable in target, test data, and environment.

### Visual

Create a check by giving it a name and a project-relative path. A visual run captures a full-page screenshot at the configured viewport and compares it with the most recent **approved** baseline:

1. If no approved baseline exists, the first capture creates a pending baseline.
2. A reviewer approves or rejects that baseline.
3. Later captures are pixel-compared against the approved image. The default allowed difference is 1% of pixels.
4. Review the screenshot and diff. Accept a deliberate design change or mark an unexpected difference as a confirmed bug.

Visual differences can be caused by dynamic data, fonts, browser/environment changes, viewport changes, or genuine UI regressions. A pixel diff is evidence for review, not a diagnosis by itself.

### Jobs & Monitoring (project)

This view shows background jobs associated with the project, including type, lifecycle status, retries, queue delay, duration, errors, and links to related runs. “Completed” means the worker completed the job handler; the linked test run tells whether the tests passed.

The default queue is PostgreSQL-backed. Redis/BullMQ support is optional for deployments that configure it. A job may be pending, active, completed, failed, retrying, or cancelled, depending on its lifecycle.

### Team

Team membership gives a user a project-scoped role. Platform administrators have global access; QA Managers can manage project members and review/approve; QA Engineers create and execute tests; Viewers have read-only access. Exact actions are enforced by backend authorization, not only by hiding UI buttons.

### Bug reports

Failed web results can be analyzed to create a suspected bug report with severity, classification, probable cause, and reproduction steps. Reports can be reviewed and moved through status. AI analysis is a hypothesis to help triage; validate it against the failure evidence before calling it a confirmed defect.

### User management

Platform Administrators can create users, change platform roles, deactivate/reactivate accounts, and inspect security audit logs. Passwords are hashed; the UI/API does not return stored password hashes.

### Observability

The system-level Observability page presents subsystem health, test/job/API metrics, latency percentiles, AI usage/cost estimates, alerts, and external telemetry endpoints. Metrics are environment-wide unless a project filter is used by the API.

- `/health` is the lightweight container health check.
- `/api/monitoring/health` reports database, storage, worker, and process health.
- `/api/monitoring/metrics` is authenticated JSON metrics for the dashboard.
- `/metrics` exposes Prometheus text-format metrics for external scraping.

The health endpoint being green means the monitored dependencies are responding; it does not mean all tests are passing.

## 4. Technical architecture and request flow

```text
Browser (React + Vite build)
        │ HTTP/JSON, session cookie, CSRF header
        ▼
Fastify API (Node.js + TypeScript)
  ├─ Auth hook → session / role / project checks
  ├─ Zod request & AI-output validation
  ├─ Feature routes → services
  ├─ Playwright / HTTP / AI / Appium integrations
  ├─ Background job worker + schedule poller
  └─ Reports, logs, metrics, artifact references
        │
        ├── PostgreSQL: projects, users, cases, runs, results, jobs, schedules
        ├── Artifact storage: local disk or S3-compatible MinIO/AWS
        ├── Gemini API: generation and failure analysis
        ├── Target application/API: test traffic
        └── Optional Redis/BullMQ and mobile Appium/device infrastructure
```

### Typical web test request

1. The dashboard sends an HTTP request to the API with the project/test identifiers and input.
2. The Fastify auth hook resolves the user from a server-side session (or a service API key for automation). State-changing cookie-authenticated requests include a CSRF token.
3. The route validates parameters/body, checks project access, and loads the project base URL plus approved cases.
4. The runner parses each web instruction and performs allowed browser actions in Playwright. URL checks guard the target and browser navigation against disallowed internal/private destinations.
5. Results, status, duration, errors, and evidence references are persisted. Artifacts such as screenshots and traces are stored in the configured artifact storage.
6. The dashboard renders the saved result and provides follow-up views such as run detail, comparisons, and bug analysis.

### Typical requirement-to-automation flow

1. File/text input is checked for allowed format and size.
2. PDF/DOCX/TXT text extraction creates the requirement document record.
3. Gemini is prompted to return structured scenarios.
4. JSON parsing and Zod schema validation reject malformed or incomplete AI output; valid cases are stored as pending.
5. A reviewer edits/approves cases.
6. The converter creates a web/API/mobile automation shape and validates its type and DSL.
7. A human reviews or edits the instructions before execution.

## 5. Technology explained in plain language

| Technology/concept | What it is | How QA Control uses it |
|---|---|---|
| **React** | UI library for building interactive browser screens from components. | Implements the dashboard tabs, forms, tables, run views, and monitoring panels. |
| **Vite** | Front-end development server and production asset bundler. | Serves the local dashboard during development and builds static files for Nginx/Docker. |
| **TypeScript** | JavaScript with compile-time types. | Defines API/UI data structures and catches many integration mistakes during builds. Types complement, but do not replace, runtime validation. |
| **Node.js** | JavaScript runtime outside the browser. | Runs the backend API, test workers, scheduling loop, and command-line CI runner. |
| **Fastify** | Node.js web framework for HTTP APIs. | Routes requests, runs hooks, returns responses, and organizes API plugins. |
| **Zod** | Runtime schema validation and type inference library. | Validates environment variables, request bodies/parameters, generated AI JSON, and automation structures. For example, a UUID field, role enum, and string length can be enforced before database or service logic runs. `safeParse` returns structured validation errors rather than trusting untyped input. |
| **PostgreSQL** | Relational SQL database. | Stores projects, membership, requirements, test cases, endpoints, suites, schedules, jobs, run results, and audit events. Parameterized queries keep user values separate from SQL text. |
| **SQL migrations** | Versioned database schema changes. | Files `001`–`015` create and evolve tables/indexes/constraints. Docker’s entrypoint applies pending migrations at startup when enabled. |
| **Gemini / Google GenAI SDK** | Remote large-language-model API. | Drafts cases, helps convert natural-language scenarios into structured automation, and assists with failure analysis. Requires an API key and network access. Outputs are treated as untrusted until parsed/validated and reviewed. |
| **Playwright + Chromium** | Browser automation framework and browser engine. | Opens target pages, performs the approved web DSL steps, checks assertions, and captures evidence. Chromium is installed in the backend Docker image. |
| **Vitest** | JavaScript/TypeScript unit and integration test runner. | Tests backend services, route behavior, security/validation logic, and execution flows. |
| **Docker Compose** | Local multi-container application orchestration. | Starts PostgreSQL, MinIO, backend, and dashboard with a private network, health checks, and persistent volumes. |
| **MinIO / S3** | Object storage API and compatible implementation. | Stores artifacts independently of database rows. MinIO is the local Compose option; S3-compatible storage can be configured for deployment. Local storage is also supported. |
| **Redis + BullMQ** | Optional queue technology for distributed background workers. | Can be enabled for deployments that need a separate/distributed queue. PostgreSQL remains the default job record/source of truth in this project. |
| **Appium** | Mobile automation server/protocol. | Connects mobile instructions to Android/iOS devices. It is an external runtime dependency; the dashboard does not itself provide an emulator. |
| **GitHub Actions** | Git-hosted workflow automation. | The repository workflow can run migration, Vitest, QA runner, evidence upload, and reporting when manually dispatched. |
| **CI/CD** | Continuous Integration / Continuous Delivery or Deployment. | CI automatically checks changes; CD automates packaging/release. This repo includes a manually started CI workflow; it should not be described as automatic-on-every-push deployment. |
| **RBAC** | Role-Based Access Control. | Maps platform and project roles to allowed actions and project scope. |
| **CSRF protection** | Defense against forged state-changing browser requests. | Cookie-authenticated writes require the session’s CSRF token in a request header. |
| **SSRF protection** | Defense against a server being tricked into requesting internal services. | Target URLs and browser navigation are checked to block private/loopback/metadata destinations, subject to the configured environment policy. |
| **Prometheus metrics** | Standard text format that monitoring systems periodically scrape. | `/metrics` exports counters/gauges; Prometheus/Grafana Agent can collect them. Grafana itself is not included in the Compose stack. |

### Why Zod matters

TypeScript types are erased when the program runs. A network client can send arbitrary JSON, and an AI model can return malformed JSON. Zod checks actual runtime values:

```ts
const body = createScheduleSchema.safeParse(request.body);
if (!body.success) {
  return reply.code(400).send({ error: "Validation error" });
}
```

This prevents invalid values (such as a bad UUID, unsupported role, negative concurrency, or malformed automation object) from flowing into business logic. A Zod schema can also infer the matching TypeScript type, reducing duplicated declarations.

## 6. Identity, access, and security model

- **Authentication:** users sign in with email/password. Passwords use Node.js `scrypt`; the database stores a password hash, not the clear-text password.
- **Sessions:** the server stores a hash of the session token and sends an HTTP-only session cookie. Session expiry and user-active status are checked.
- **CSRF:** state-changing requests made with the session cookie carry a CSRF token.
- **Service authentication:** CI/automation can use the `x-api-key` service credential. Keep it in a secret store/environment variable, never in dashboard source or a committed file.
- **Roles:** `admin`, `qa_manager`, `qa_engineer`, and `viewer`. A project assignment is separate from the platform role; project access is checked against project membership and required role.
- **Audit:** important user, project, authorization, and schedule actions can be recorded in audit logs.
- **Target safety:** projects require an authorization declaration. The URL guard blocks unsafe network targets to reduce SSRF risk. Keep `ALLOW_PRIVATE_TARGETS=false` for production unless a documented, controlled exception is required.
- **Secrets:** `.env` files are local configuration and must not be committed. Use `.env.example` only as a placeholder template and supply real secrets through approved secret management.

## 7. CI/CD: what is in this repository

The workflow is in [`.github/workflows/qa-agent.yml`](../.github/workflows/qa-agent.yml). Its trigger is `workflow_dispatch`, so a maintainer starts it from GitHub Actions; it is not configured to run automatically on every push or pull request.

When started, it:

1. Starts a temporary PostgreSQL service.
2. Checks out source and sets up Node.js.
3. Installs dependencies and Playwright Chromium.
4. Applies database migrations.
5. Runs `npm test`.
6. Runs `src/utils/ciRunner.ts`, which selects the configured/earliest project, runs approved web test cases and approved API endpoints, stores run results, compares against a prior run when available, and writes a Markdown report.
7. Uploads report/evidence artifacts. The workflow input can enable a failing exit on detected regression.

### CI demo caveats

- The workflow requires valid GitHub secrets for Gemini/target credentials if those paths are used.
- The CI runner needs a project and approved test data in its database. The workflow’s fresh PostgreSQL instance runs migrations but the migrations do not seed a demo project or approved tests. Without an explicit seed step/project data, the runner will have no target project and cannot perform the intended QA comparison. This needs to be addressed before presenting the workflow as a ready-to-run end-to-end demo.
- The workflow includes pull-request-comment code, but because its configured trigger is manual dispatch, do not claim that it automatically comments on pull requests in the current setup.
- CI is not the same as CD: this workflow evaluates tests and produces a report; it does not deploy the application.

## 8. Local development and Docker setup

### Docker Compose (recommended for the demo)

1. Copy `.env.example` to `.env`.
2. Replace placeholders with approved local secrets (especially `GEMINI_API_KEY`, `PLATFORM_API_KEY`, and `COOKIE_SECRET`). Do not share or commit `.env`.
3. Start services:

```powershell
docker compose up -d --build
```

4. Confirm health:

```powershell
docker compose ps
Invoke-WebRequest http://localhost:3000/health
```

5. Open the dashboard using `DASHBOARD_PORT` (defaults to `http://localhost:5173`).

Compose includes PostgreSQL and MinIO on an internal Docker network; the database port is not exposed to the host by default. PostgreSQL data, MinIO objects, and test artifacts use named volumes. Do not run `docker compose down -v` on a demo environment unless you intend to delete its persisted data.

### Development mode

Install dependencies with `npm ci` in the repository root and in `dashboard/`. Configure environment variables, start the backend with `npm run dev`, and start the dashboard from `dashboard/` with `npm run dev`. The exact dashboard/API ports depend on Vite and environment configuration; make sure the dashboard's `VITE_API_URL` points to the backend.

### Useful project commands

| Command | Purpose |
|---|---|
| `npm run build` | Compile backend TypeScript into `dist/`. |
| `npm test` | Run backend Vitest tests. |
| `npm run test:e2e` | Run configured Playwright end-to-end tests, if their target/environment is prepared. |
| `npm run migrate` | Apply pending database migrations. |
| `npm run smoke:api` | Run API smoke utility, subject to its environment prerequisites. |
| `npm run smoke:visual` | Run visual smoke utility, subject to its environment prerequisites. |
| `npm run test:ci` | Run the application CI QA runner locally, requiring a prepared database/project. |
| `cd dashboard; npm run build` | Type-check and build dashboard assets. |

## 9. Data and persistence at a glance

| Data | Main storage |
|---|---|
| Users, sessions, projects, project memberships, authorization declarations, audit events | PostgreSQL |
| Requirement document metadata and extracted text | PostgreSQL |
| Test cases, automations, API endpoints, suites, schedules | PostgreSQL |
| Runs, per-case/API/visual results, job state, telemetry logs | PostgreSQL and in-process metrics/logging as appropriate |
| Screenshots, traces, visual baselines/diffs, reports | Artifact files or configured S3-compatible storage |
| Session cookie | Browser cookie; server-side token hash/session data in PostgreSQL |

Schema evolution is managed by `database/migrations/001_init.sql` through `015_mobile_testing.sql`. The migration runner records applied migrations so existing databases do not reapply the same migration.

## 10. Known boundaries to explain honestly

1. **AI is assistive, not authoritative.** Generated steps may need correction, and model availability/rate limits can add delay.
2. **Target access is a dependency.** Login-protected sites need correct test credentials or an appropriate signed-in test session. A crawler cannot invent account permissions or test fixtures.
3. **Automation is environment-sensitive.** Selectors, dynamic content, permissions, and data state can cause tests to fail even when the application is healthy.
4. **Runs can change data.** Use a controlled test tenant and cleanup/reset strategy for write actions.
5. **Visual tests need a reviewed baseline.** The first capture is pending; diffs need human interpretation.
6. **A schedule is a trigger, not a result.** The suite and its approved members determine what executes. A job may finish while its linked tests report failures.
7. **Mobile execution needs infrastructure.** Appium/device connectivity cannot be inferred merely from the dashboard being available.
8. **CI needs data seeding.** A new CI database with migrations alone does not provide an application project and approved cases/endpoints.
9. **Observability is not a full external monitoring deployment.** The app exposes health/metrics endpoints; Prometheus/Grafana servers and alert delivery integrations must be configured separately.
10. **Deployment is separate.** Docker Compose is a local/self-hosted stack definition, not an automatically provisioned production service or a configured cloud CI/CD release.

## 11. Source map for follow-up questions

| Area | Key implementation |
|---|---|
| Main dashboard/routes | [`dashboard/src/App.tsx`](../dashboard/src/App.tsx) |
| Mobile dashboard | [`dashboard/src/components/MobileTestingTab.tsx`](../dashboard/src/components/MobileTestingTab.tsx) |
| Monitoring and job UI | [`dashboard/src/components/MonitoringViews.tsx`](../dashboard/src/components/MonitoringViews.tsx) |
| API bootstrap and hooks | [`src/server.ts`](../src/server.ts) |
| Environment validation | [`src/config/env.ts`](../src/config/env.ts) |
| Login, users, team | [`src/routes/auth.ts`](../src/routes/auth.ts), [`src/services/authService.ts`](../src/services/authService.ts) |
| Website test discovery | [`src/routes/generate.ts`](../src/routes/generate.ts), [`src/services/pageReader.ts`](../src/services/pageReader.ts), [`src/services/generator.ts`](../src/services/generator.ts) |
| Requirements-to-cases | [`src/routes/requirements.ts`](../src/routes/requirements.ts), [`src/services/requirementsGenerator.ts`](../src/services/requirementsGenerator.ts) |
| Automation conversion and validation | [`src/routes/automation.ts`](../src/routes/automation.ts), [`src/services/automationConverter.ts`](../src/services/automationConverter.ts) |
| Web/API execution | [`src/services/runner.ts`](../src/services/runner.ts), [`src/services/apiRunner.ts`](../src/services/apiRunner.ts), [`src/services/executionManager.ts`](../src/services/executionManager.ts) |
| Suites and run history | [`src/routes/suites.ts`](../src/routes/suites.ts), [`src/routes/runs.ts`](../src/routes/runs.ts) |
| Scheduling | [`src/routes/schedules.ts`](../src/routes/schedules.ts), [`src/services/scheduler.ts`](../src/services/scheduler.ts) |
| Visual checks | [`src/routes/visual.ts`](../src/routes/visual.ts), [`src/services/visualRunner.ts`](../src/services/visualRunner.ts) |
| Jobs, storage, monitoring | [`src/routes/jobRoutes.ts`](../src/routes/jobRoutes.ts), [`src/services/jobs/jobQueue.ts`](../src/services/jobs/jobQueue.ts), [`src/routes/monitoringRoutes.ts`](../src/routes/monitoringRoutes.ts) |
| CI runner/workflow | [`src/utils/ciRunner.ts`](../src/utils/ciRunner.ts), [`.github/workflows/qa-agent.yml`](../.github/workflows/qa-agent.yml) |
| Containers and schema | [`docker-compose.yml`](../docker-compose.yml), [`Dockerfile`](../Dockerfile), [`database/migrations/`](../database/migrations/) |
| Detailed existing docs | [`docs/AUTHENTICATION_AND_RBAC.md`](./AUTHENTICATION_AND_RBAC.md), [`docs/AUTOMATED_TEST_EXECUTION.md`](./AUTOMATED_TEST_EXECUTION.md), [`docs/ADVANCED_EXECUTION_AND_WORKFLOWS.md`](./ADVANCED_EXECUTION_AND_WORKFLOWS.md), [`docs/BACKGROUND_JOBS_AND_OBSERVABILITY.md`](./BACKGROUND_JOBS_AND_OBSERVABILITY.md), [`docs/DOCKER.md`](./DOCKER.md) |
