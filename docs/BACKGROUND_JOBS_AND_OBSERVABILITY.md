# Background Jobs, S3 Artifact Storage & Observability Guide
**Tasks 12, 13 & 14 Implementation Documentation**

---

## 1. Executive Summary

This document details the architecture and operational guidelines for **Background Jobs Processing (Task 12)**, **S3-Compatible Artifact Storage (Task 13)**, and **Monitoring, Logging & Observability (Task 14)** in the AI QA Testing Agent platform.

All components have been implemented natively in Node.js/TypeScript and integrated into the containerized Docker stack with zero breaking changes to existing web automation, API testing, RBAC, regression testing, or schedules.

---

## 2. Task 12 — Background Job Processing

### 2.1 Redis + BullMQ Justification & Architectural Decision

| Evaluation Criterion | PostgreSQL-Backed Worker Engine | Redis + BullMQ Queue |
| :--- | :--- | :--- |
| **Current Architectural Need** | **Sufficient & Recommended**. Single-node Docker deployment with 1–20 concurrent jobs. Uses `FOR UPDATE SKIP LOCKED` for strict ACID consistency. | **Optional / Dual-Mode**. Needed when scaling to horizontally distributed worker pods. |
| **Operational Overhead** | Zero extra services. PostgreSQL is already the source of truth for test runs and results. | Requires managing Redis container, memory sizing, evictions, and connection pools. |
| **Duplicate Prevention** | Native unique constraint / deduplication index in `background_jobs` table. | BullMQ deduplication IDs stored in Redis hashes. |
| **Data Loss Risk** | Zero (ACID WAL persistence). | Risk if Redis memory persistence (RDB/AOF) is misconfigured. |

#### When Should Redis Be Introduced?
Redis and BullMQ are fully supported via the built-in dual-engine adapter (`USE_REDIS_QUEUE=true` or `REDIS_URL=redis://...`). Redis should be enabled when:
1. **Horizontally Distributed Worker Fleets:** Deploying decoupled worker pools across multiple Kubernetes nodes or ECS tasks where polling PostgreSQL creates connection overhead.
2. **High-Frequency Job Throughput:** Sustaining > 500 jobs per second (e.g. distributed micro-assertions or webhook ingestion).
3. **Complex BullMQ Workflows:** Parent-child job flows, rate-limited delayed chains, or job priority preemption.

### 2.2 Worker Processing & Failure Handling
- **Database Table:** `background_jobs` (Migration 014) tracks job lifecycle (`pending` → `active` → `completed` / `retrying` / `failed` / `cancelled`).
- **Locking & Concurrency:** Employs `SELECT ... FOR UPDATE SKIP LOCKED` to ensure competing worker threads never process duplicate jobs.
- **Exponential Backoff & Retries:** Failed jobs retry up to `max_retries` (default 3, configurable up to 5) with exponential backoff before being marked as `failed`.
- **Deduplication:** Prevents duplicate job creation if a pending or active job with matching `deduplicationId` exists.
- **Job Handlers Registered:**
  - `web_execution`: Headless Playwright test runs with retries, evidence scrubbing, screenshot upload, and report generation.
  - `api_execution`: Multi-step API tests with parameter extraction and response assertions.
  - `regression_run`: Comparison of base and target run baselines.
  - `ai_generation`: AI test case and requirements generation with token telemetry.

### 2.3 Job Management HTTP Endpoints
- `GET /jobs/:id` — Inspect job status, queue delay, duration, error message, and results.
- `GET /projects/:projectId/jobs` — Paginated list of background jobs for a project.
- `POST /jobs/:id/cancel` — Cancels a pending or retrying background job.
- `POST /projects/:projectId/jobs/web-execution` — Asynchronously enqueues a web test execution job.
- `POST /projects/:projectId/jobs/api-execution` — Asynchronously enqueues an API test execution job.
- `POST /projects/:projectId/jobs/regression-run` — Asynchronously enqueues a regression comparison job.
- `POST /projects/:projectId/jobs/ai-generation` — Asynchronously enqueues an AI test generation job.

---

## 3. Task 13 — S3-Compatible Artifact Storage

### 3.1 Storage Abstraction (`IStorageService`)
The storage layer decouples application logic from the underlying storage mechanism:
- **`LocalStorageProvider`:** Persists artifacts to disk with path traversal protection and HMAC-SHA256 signed URL verification.
- **`S3StorageProvider`:** Integrates with AWS S3 and local MinIO instances using `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`.
- **Automated Fallback:** If MinIO or AWS S3 is unreachable or returns a network error, `S3StorageProvider` automatically falls back to local disk storage, guaranteeing that test runs never fail due to transient cloud storage issues.

### 3.2 Time-Limited Signed URLs & Security
- **No Public Access:** Storage buckets and artifact directories are private. Direct public access is strictly blocked.
- **Time-Limited Signed URLs:** Artifact downloads require a cryptographically signed URL (`/api/artifacts/download?key=...&expires=...&sig=...`). Signatures are computed using HMAC-SHA256 with `COOKIE_SECRET` and expire after 15 minutes (900 seconds).
- **Access Control:** Generation of signed URLs via `GET /artifacts/signed-url` enforces project-level RBAC (`viewer` or higher) and verifies project tenancy.

### 3.3 MinIO Local Development Setup
Inside `docker-compose.yml`, MinIO is pre-configured on internal container network `ai_qa_network`:
```yaml
minio:
  image: minio/minio:latest
  container_name: ai_qa_minio
  command: server /data --console-address ":9001"
  environment:
    MINIO_ROOT_USER: ${S3_ACCESS_KEY:-minioadmin}
    MINIO_ROOT_PASSWORD: ${S3_SECRET_KEY:-miniopassword123}
  volumes:
    - minio_data:/data
  networks:
    - qa_network
```

### 3.4 AWS S3 Production Deployment Guide
To switch from local MinIO to AWS S3 in production:
1. Create an AWS S3 bucket (e.g. `company-ai-qa-artifacts`).
2. Block all public access on the S3 bucket settings.
3. Configure IAM credentials with `s3:PutObject`, `s3:GetObject`, and `s3:DeleteObject` permissions.
4. Set the following environment variables:
```bash
STORAGE_PROVIDER=s3
S3_ENDPOINT=                        # Leave blank for standard AWS S3
S3_BUCKET=company-ai-qa-artifacts
S3_REGION=us-east-1
S3_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE
S3_SECRET_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
S3_FORCE_PATH_STYLE=false           # false for AWS S3 virtual-hosted buckets
```

---

## 4. Task 14 — Monitoring, Logging & Observability

### 4.1 Structured Logging & Correlation IDs
- **Structured JSON Logs:** All logs are emitted as single-line parseable JSON containing `timestamp`, `level`, `message`, `correlationId`, `executionId`, `jobId`, `userId`, `projectId`, `service`, and `category`.
- **`x-correlation-id` Header:** Captured on incoming requests or generated via `randomUUID()`, then propagated ambiently across all downstream logs and async handlers using Node.js `AsyncLocalStorage`.
- **Distinguishing Test Failures from Application Errors:**
  - Actual test failures are categorized as `category: "test_execution"` with `isTestFailure: true` and logged with `logger.testFailure()`.
  - Application/system errors (e.g., database connection drops, unhandled exceptions) are categorized as `category: "application"` with `level: "error"`.

### 4.2 Credential & Secret Redaction
Sensitive information is recursively scrubbed from all log entries, error messages, and URL parameters:
- **Redacted Object Keys:** `password`, `secret`, `authorization`, `cookie`, `apiKey`, `api_key`, `access_token`, `refresh_token`, `private_key`, `session_token`, `credentials`.
- **Telemetry Protection:** Telemetry counts (`totalTokens`, `promptTokens`, `completionTokens`) are preserved and never mistaken for secret tokens.
- **Redacted String Patterns:**
  - Bearer tokens: `Bearer [REDACTED_TOKEN]`
  - Session cookies: `ai_qa_sess=[REDACTED_COOKIE]`
  - Google / Gemini API keys: `AIzaSy[REDACTED_API_KEY]`
  - Basic auth in URLs: `https://user:[REDACTED_AUTH]@host`

### 4.3 AI Token Usage & Cost Telemetry
The `ai_usage_logs` table (Migration 014) tracks token usage per feature.
Estimated costs are calculated dynamically based on Google Gemini pricing:
$$\text{Cost}_{\text{Flash}} = \frac{\text{Prompt Tokens}}{1,000,000} \times \$0.075 + \frac{\text{Completion Tokens}}{1,000,000} \times \$0.30$$
$$\text{Cost}_{\text{Pro}} = \frac{\text{Prompt Tokens}}{1,000,000} \times \$3.50 + \frac{\text{Completion Tokens}}{1,000,000} \times \$10.50$$

### 4.4 Health Check & Observability Endpoints
1. `GET /health` — Fast container healthcheck probe.
2. `GET /api/monitoring/health` — Comprehensive multi-subsystem status check:
   - Database connectivity and latency (ms)
   - Storage provider status and operational check
   - Background worker engine status
   - Process uptime and memory footprint (heap used, heap total, RSS in MB)
3. `GET /api/monitoring/metrics` — JSON telemetry endpoint for the dashboard UI (test counts, queue delays, worker retries, AI usage, active alerts).
4. `GET /metrics` — Prometheus exposition format for external scraping agents (Prometheus, Datadog, Grafana Agent).

### 4.5 Active Alert Rules
Built-in anomaly thresholds:
- `high_test_failure_rate`: Triggers when failure rate exceeds 25% with at least 5 test runs.
- `worker_failures_detected`: Triggers when worker encounters > 3 terminal failures.
- `high_queue_delay`: Triggers when average background job delay exceeds 15,000ms.

---

## 5. Environment Variables Reference

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `STORAGE_PROVIDER` | `local` | Storage provider (`local` or `s3`) |
| `S3_ENDPOINT` | `http://minio:9000` | S3 endpoint URL (MinIO container URL or AWS) |
| `S3_BUCKET` | `ai-qa-artifacts` | S3 bucket name |
| `S3_ACCESS_KEY` | `minioadmin` | S3 access key ID |
| `S3_SECRET_KEY` | `miniopassword123` | S3 secret access key |
| `S3_REGION` | `us-east-1` | AWS S3 region |
| `S3_FORCE_PATH_STYLE` | `true` | Set to `true` for MinIO path-style URLs |
| `USE_REDIS_QUEUE` | `false` | Enable BullMQ + Redis background worker engine |
| `REDIS_URL` | `redis://localhost:6379`| Redis connection URL |
| `LOG_LEVEL` | `info` | Logging verbosity (`debug`, `info`, `warn`, `error`) |

---

## 6. Verification & Test Results

- **Automated Tests:** `npm test` — **25 passed, 226 tests passed**.
- **Build Results:**
  - Backend TypeScript: `npm run build` compiled cleanly.
  - Dashboard Vite: `cd dashboard && npm run build` compiled cleanly (26 modules transformed, zero errors).
- **Docker Compose Stack:**
  - `ai_qa_postgres`: Healthy (Port 5432 internal).
  - `ai_qa_minio`: Healthy (Port 9000 internal).
  - `ai_qa_backend`: Healthy (Port 3000 published).
  - `ai_qa_dashboard`: Healthy (Port 5173 published).
- **End-to-End Verification:**
  - Database migration 014 applied on container startup.
  - Project created, background job enqueued, claimed by worker loop, and executed to completion.
  - S3 / MinIO health check verified (`Provider: minio`).
  - Prometheus metrics scraped from `/metrics`.
