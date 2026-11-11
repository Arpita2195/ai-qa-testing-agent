import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../config/db";
import {
  enqueueJob,
  getJob,
  listJobs,
  cancelJob,
  processJob,
  registerJobHandler,
  isRedisQueueEnabled,
} from "../services/jobs/jobQueue";
import { LocalStorageProvider } from "../services/storage/localStorageProvider";
import { S3StorageProvider } from "../services/storage/s3StorageProvider";
import { storageService, recordStoredArtifact } from "../services/storage/storageService";
import {
  redactSensitiveData,
  logger,
  asyncLogStorage,
  runWithLogContext,
} from "../services/observability/logger";
import {
  inMemoryMetrics,
  calculateEstimatedCostUsd,
  recordAiUsage,
  getSystemMetrics,
  getPrometheusMetrics,
} from "../services/observability/metricsService";
import { monitoringRoutes } from "../routes/monitoringRoutes";
import { jobRoutes } from "../routes/jobRoutes";
import { artifactRoutes } from "../routes/artifactRoutes";
import { createAuthHook } from "../services/auth";

vi.mock("../config/db", () => ({
  pool: {
    query: vi.fn(),
    connect: vi.fn(),
  },
  checkDbConnection: vi.fn().mockResolvedValue(true),
}));

describe("TASKS 12, 13 & 14: Background Jobs, Artifact Storage & Observability", () => {
  let app: ReturnType<typeof Fastify> | undefined;
  const testApiKey = "test-platform-api-key-16chars";
  const testCookieSecret = "test-cookie-secret-with-at-least-32-characters";

  beforeEach(() => {
    vi.clearAllMocks();
    inMemoryMetrics.reset();

    app = Fastify();
    app.register(cookie, { secret: testCookieSecret });
    app.addHook("onRequest", createAuthHook(testApiKey));
    app.register(monitoringRoutes);
    app.register(jobRoutes);
    app.register(artifactRoutes);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  // ===========================================================================
  // TASK 12: Background Job Processing
  // ===========================================================================
  describe("Task 12: Background Job Processing", () => {
    const mockProjectId = "11111111-1111-1111-1111-111111111111";
    const mockJobId = "22222222-2222-2222-2222-222222222222";

    it("enqueues a job into PostgreSQL and returns the job record", async () => {
      // Mock deduplication check query (no existing job)
      (pool.query as any).mockResolvedValueOnce({ rowCount: 0, rows: [] });

      // Mock insert query returning created job
      (pool.query as any).mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: mockJobId,
            project_id: mockProjectId,
            queue_name: "test_queue",
            job_type: "test_type",
            status: "pending",
            payload: { foo: "bar" },
            result: null,
            error_message: null,
            retries: 0,
            max_retries: 3,
            concurrency_key: null,
            deduplication_id: "dedup-123",
            enqueued_at: new Date().toISOString(),
            started_at: null,
            completed_at: null,
            queue_delay_ms: null,
            duration_ms: null,
            created_by: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      });

      const job = await enqueueJob({
        projectId: mockProjectId,
        queueName: "test_queue",
        jobType: "test_type" as any,
        payload: { foo: "bar" },
        deduplicationId: "dedup-123",
      });

      expect(job.id).toBe(mockJobId);
      expect(job.status).toBe("pending");
      expect(job.deduplicationId).toBe("dedup-123");
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO background_jobs"),
        expect.arrayContaining([mockProjectId, "test_queue", "test_type"]),
      );
    });

    it("prevents duplicate job enqueueing when an identical deduplicationId is active", async () => {
      // Mock deduplication check finding existing active job
      (pool.query as any).mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: mockJobId,
            project_id: mockProjectId,
            queue_name: "test_queue",
            job_type: "test_type",
            status: "active",
            payload: { foo: "bar" },
            deduplication_id: "dedup-existing",
            enqueued_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      });

      const job = await enqueueJob({
        projectId: mockProjectId,
        queueName: "test_queue",
        jobType: "test_type" as any,
        payload: { foo: "bar" },
        deduplicationId: "dedup-existing",
      });

      expect(job.id).toBe(mockJobId);
      expect(job.status).toBe("active");
      // Verify no INSERT was issued
      expect(pool.query).toHaveBeenCalledTimes(1);
    });

    it("processes job with registered handler, marks completed, and tracks duration", async () => {
      const mockHandler = vi.fn().mockResolvedValue({ success: true, count: 5 });
      registerJobHandler("mock_worker_job" as any, mockHandler);

      const mockClient = {
        query: vi.fn(),
        release: vi.fn(),
      };
      (pool.connect as any).mockResolvedValue(mockClient);

      // 1. Transaction BEGIN
      mockClient.query.mockResolvedValueOnce({});
      // 2. Claim job with FOR UPDATE SKIP LOCKED
      mockClient.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: mockJobId,
            project_id: mockProjectId,
            queue_name: "test_queue",
            job_type: "mock_worker_job",
            status: "pending",
            payload: { action: "run" },
            enqueued_at: new Date(Date.now() - 500).toISOString(),
            retries: 0,
            max_retries: 3,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      });
      // 3. UPDATE status = 'active'
      mockClient.query.mockResolvedValueOnce({});
      // 4. Transaction COMMIT
      mockClient.query.mockResolvedValueOnce({});
      // 5. UPDATE status = 'completed' in pool
      (pool.query as any).mockResolvedValueOnce({});

      const success = await processJob(mockJobId);

      expect(success).toBe(true);
      expect(mockHandler).toHaveBeenCalledWith({ action: "run" }, expect.anything());
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'completed'"),
        expect.arrayContaining([expect.any(Number), JSON.stringify({ success: true, count: 5 }), mockJobId]),
      );
      expect(mockClient.release).toHaveBeenCalled();
    });

    it("handles worker failure, increments retry count, and sets retrying status", async () => {
      const mockFailingHandler = vi.fn().mockRejectedValue(new Error("Transient connection timeout"));
      registerJobHandler("failing_job" as any, mockFailingHandler);

      const mockClient = {
        query: vi.fn(),
        release: vi.fn(),
      };
      (pool.connect as any).mockResolvedValue(mockClient);

      mockClient.query.mockResolvedValueOnce({}); // BEGIN
      mockClient.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: mockJobId,
            project_id: mockProjectId,
            queue_name: "test_queue",
            job_type: "failing_job",
            status: "pending",
            payload: {},
            retries: 0,
            max_retries: 3,
            enqueued_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      }); // CLAIM
      mockClient.query.mockResolvedValueOnce({}); // ACTIVE
      mockClient.query.mockResolvedValueOnce({}); // COMMIT
      (pool.query as any).mockResolvedValueOnce({}); // RETRY UPDATE

      const success = await processJob(mockJobId);

      expect(success).toBe(false);
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'retrying'"),
        expect.arrayContaining([1, "Transient connection timeout", expect.any(Number), mockJobId]),
      );
      expect(inMemoryMetrics.getWorkerStats().retries).toBe(1);
    });

    it("marks job permanently failed when max retries are exceeded", async () => {
      const mockPermanentFail = vi.fn().mockRejectedValue(new Error("Fatal syntax error"));
      registerJobHandler("fatal_job" as any, mockPermanentFail);

      const mockClient = {
        query: vi.fn(),
        release: vi.fn(),
      };
      (pool.connect as any).mockResolvedValue(mockClient);

      mockClient.query.mockResolvedValueOnce({}); // BEGIN
      mockClient.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: mockJobId,
            project_id: mockProjectId,
            queue_name: "test_queue",
            job_type: "fatal_job",
            status: "retrying",
            payload: {},
            retries: 2,
            max_retries: 3, // next attempt 3 >= maxRetries
            enqueued_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      });
      mockClient.query.mockResolvedValueOnce({}); // ACTIVE
      mockClient.query.mockResolvedValueOnce({}); // COMMIT
      (pool.query as any).mockResolvedValueOnce({}); // FAILED UPDATE

      const success = await processJob(mockJobId);

      expect(success).toBe(false);
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'failed'"),
        expect.arrayContaining([3, expect.any(Number), "Fatal syntax error", mockJobId]),
      );
      expect(inMemoryMetrics.getWorkerStats().failures).toBe(1);
    });

    it("cancels a pending job successfully", async () => {
      (pool.query as any).mockResolvedValueOnce({ rowCount: 1, rows: [{ id: mockJobId }] });
      const cancelled = await cancelJob(mockJobId);
      expect(cancelled).toBe(true);
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'cancelled'"),
        [mockJobId],
      );
    });
  });

  // ===========================================================================
  // TASK 13: S3-Compatible Artifact Storage
  // ===========================================================================
  describe("Task 13: Artifact Storage & Local Fallback", () => {
    it("LocalStorageProvider stores artifact, creates signed URL, and verifies HMAC signature", async () => {
      const provider = new LocalStorageProvider();
      const testBuffer = Buffer.from("test-evidence-screenshot-png-data");
      const key = "runs/test-run-123/screenshot.png";

      // 1. Upload
      const uploadRes = await provider.upload(key, testBuffer, "image/png");
      expect(uploadRes.key).toBe(key);
      expect(uploadRes.provider).toBe("local");

      // 2. Generate signed URL
      const signedUrl = await provider.getSignedUrl(key, 900);
      expect(signedUrl).toContain("sig=");
      expect(signedUrl).toContain("expires=");

      // 3. Parse query params from signed URL
      const urlObj = new URL(signedUrl, "http://localhost:3000");
      const expires = Number(urlObj.searchParams.get("expires"));
      const sig = urlObj.searchParams.get("sig")!;

      // 4. Valid signature verification
      expect(provider.verifySignature(key, expires, sig)).toBe(true);

      // 5. Tampered signature fails verification
      expect(provider.verifySignature(key, expires, "tampered-invalid-sig")).toBe(false);

      // 6. Expired URL fails verification
      const pastTime = Math.floor(Date.now() / 1000) - 100;
      expect(provider.verifySignature(key, pastTime, sig)).toBe(false);

      // 7. Download
      const downloaded = await provider.download(key);
      expect(downloaded.buffer.toString()).toBe("test-evidence-screenshot-png-data");
      expect(downloaded.contentType).toBe("image/png");
    });

    it("LocalStorageProvider prevents path traversal attacks", async () => {
      const provider = new LocalStorageProvider();
      await expect(provider.upload("../../../etc/passwd", Buffer.from("hack"), "text/plain")).rejects.toThrow(
        /Path traversal attempt blocked/,
      );
      await expect(provider.download("../../secret.env")).rejects.toThrow(/Path traversal attempt blocked/);
    });

    it("S3StorageProvider transparently falls back to local storage on S3 failure", async () => {
      const s3Provider = new S3StorageProvider({
        bucket: "unreachable-test-bucket",
        endpoint: "http://127.0.0.1:19999", // dead endpoint
        region: "us-east-1",
        accessKeyId: "mock",
        secretAccessKey: "mock",
      });

      const testBuffer = Buffer.from("fallback-artifact-data");
      const key = "runs/fallback-run/trace.zip";

      // Upload should catch S3 network error and gracefully fall back to local disk
      const uploadRes = await s3Provider.upload(key, testBuffer, "application/zip");
      expect(uploadRes.provider).toBe("local");
      expect(uploadRes.key).toBe(key);

      // Download retrieves the fallback local artifact
      const downloaded = await s3Provider.download(key);
      expect(downloaded.buffer.toString()).toBe("fallback-artifact-data");
    });

    it("recordStoredArtifact persists artifact metadata to PostgreSQL", async () => {
      (pool.query as any).mockResolvedValueOnce({ rowCount: 1 });

      await recordStoredArtifact({
        projectId: "33333333-3333-3333-3333-333333333333",
        runId: "44444444-4444-4444-4444-444444444444",
        artifactType: "screenshot",
        storageKey: "runs/4444/result-1/screenshot.png",
        contentType: "image/png",
        sizeBytes: 1024,
      });

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO stored_artifacts"),
        expect.arrayContaining([
          "33333333-3333-3333-3333-333333333333",
          "44444444-4444-4444-4444-444444444444",
          null,
          "screenshot",
          expect.any(String),
          "runs/4444/result-1/screenshot.png",
          "image/png",
          1024,
        ]),
      );
    });
  });

  // ===========================================================================
  // TASK 14: Monitoring, Logging & Observability
  // ===========================================================================
  describe("Task 14: Monitoring, Logging & Observability", () => {
    it("redactSensitiveData recursively masks secrets, passwords, cookies, and tokens", () => {
      const sensitiveInput = {
        username: "qa_tester",
        password: "MySuperSecretPassword!",
        cookie: "session=xyz123",
        apiKey: "AIzaSyD-1234567890abcdefghijklmnopqrst",
        authHeader: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token123",
        nested: {
          secret_key: "top-secret-val",
          safeData: "safe-value",
          url: "https://user:mypassword@internal.company.com/api",
        },
      };

      const sanitized = redactSensitiveData(sensitiveInput);

      expect(sanitized.password).toBe("[REDACTED]");
      expect(sanitized.cookie).toBe("[REDACTED]");
      expect(sanitized.apiKey).toBe("[REDACTED]");
      expect(sanitized.authHeader).toBe("Bearer [REDACTED_TOKEN]");
      expect(sanitized.nested.secret_key).toBe("[REDACTED]");
      expect(sanitized.nested.safeData).toBe("safe-value");
      expect(sanitized.nested.url).toContain("[REDACTED_AUTH]");
      expect(sanitized.nested.url).not.toContain("mypassword");

      // Test raw string token pattern redaction
      const rawStringWithBearer = redactSensitiveData("Headers: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token123");
      expect(rawStringWithBearer).toBe("Headers: Bearer [REDACTED_TOKEN]");

      const rawStringWithApiKey = redactSensitiveData("Config: AIzaSyD-1234567890abcdefghijklmnopqrst");
      expect(rawStringWithApiKey).toBe("Config: AIzaSy[REDACTED_API_KEY]");
    });

    it("calculates accurate Gemini AI token costs", () => {
      // 1M prompt + 1M completion on flash: (1 * 0.075) + (1 * 0.30) = $0.375
      const flashCost = calculateEstimatedCostUsd("gemini-2.5-flash", 1_000_000, 1_000_000);
      expect(flashCost).toBe(0.375);

      // 100k prompt + 10k completion on pro: (0.1 * 3.5) + (0.01 * 10.5) = 0.35 + 0.105 = $0.455
      const proCost = calculateEstimatedCostUsd("gemini-1.5-pro", 100_000, 10_000);
      expect(proCost).toBe(0.455);
    });

    it("records AI usage telemetry to PostgreSQL ai_usage_logs", async () => {
      (pool.query as any).mockResolvedValueOnce({ rowCount: 1 });

      await recordAiUsage({
        projectId: "55555555-5555-5555-5555-555555555555",
        feature: "test_generation",
        model: "gemini-2.5-flash",
        promptTokens: 500,
        completionTokens: 250,
        durationMs: 1200,
      });

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO ai_usage_logs"),
        expect.arrayContaining([
          "55555555-5555-5555-5555-555555555555",
          "test_generation",
          "gemini-2.5-flash",
          500,
          250,
          750, // total tokens
          expect.any(Number), // estimated cost
          1200,
        ]),
      );
    });

    it("tracks in-memory test executions and calculates duration percentiles", () => {
      inMemoryMetrics.trackTestExecution({ status: "passed", durationMs: 100 });
      inMemoryMetrics.trackTestExecution({ status: "passed", durationMs: 200 });
      inMemoryMetrics.trackTestExecution({ status: "failed", durationMs: 500 });
      inMemoryMetrics.trackTestExecution({ status: "passed", durationMs: 1000 });

      const stats = inMemoryMetrics.getExecutionDurationStats();
      expect(stats.count).toBe(4);
      expect(stats.minMs).toBe(100);
      expect(stats.maxMs).toBe(1000);
      expect(stats.avgMs).toBe(450);
      expect(stats.p50Ms).toBe(200);
      expect(stats.p95Ms).toBe(1000);
    });

    it("keeps execution and worker telemetry isolated by project", async () => {
      const projectA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const projectB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      inMemoryMetrics.trackTestExecution({
        status: "passed",
        durationMs: 120,
        projectId: projectA,
      });
      inMemoryMetrics.trackTestExecution({
        status: "failed",
        durationMs: 900,
        projectId: projectB,
      });
      inMemoryMetrics.trackQueueDelay(30, projectA);
      inMemoryMetrics.trackQueueDelay(700, projectB);
      inMemoryMetrics.trackWorkerRetry(projectB);
      inMemoryMetrics.trackWorkerFailure(projectB);

      (pool.query as any)
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ total: 1, passed: 1, failed: 0, skipped: 0, inconclusive: 0, flaky: 0 }],
        })
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ total: 1, pending: 0, active: 0, completed: 1, failed: 0, retrying: 0, cancelled: 0 }],
        })
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ total_requests: 0, total_tokens: 0, prompt_tokens: 0, completion_tokens: 0, total_cost_usd: 0 }],
        })
        .mockResolvedValueOnce({ rowCount: 0, rows: [] });

      const metrics = await getSystemMetrics(projectA);

      expect(pool.query).toHaveBeenNthCalledWith(1, expect.stringContaining("WHERE r.project_id = $1"), [projectA]);
      expect(pool.query).toHaveBeenNthCalledWith(2, expect.stringContaining("WHERE project_id = $1"), [projectA]);
      expect(pool.query).toHaveBeenNthCalledWith(3, expect.stringContaining("WHERE project_id = $1"), [projectA]);
      expect(metrics.tests.duration.count).toBe(1);
      expect(metrics.tests.duration.avgMs).toBe(120);
      expect(metrics.jobs.queueDelay.count).toBe(1);
      expect(metrics.jobs.queueDelay.avgMs).toBe(30);
      expect(metrics.jobs.worker.retries).toBe(0);
      expect(metrics.jobs.worker.failures).toBe(0);
    });

    it("generates Prometheus scrapable metrics exposition format", async () => {
      (pool.query as any)
        // 1. test counts
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ total: 10, passed: 8, failed: 2, skipped: 0, inconclusive: 0, flaky: 1 }],
        })
        // 2. job counts
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ total: 5, pending: 1, active: 1, completed: 3, failed: 0, retrying: 0, cancelled: 0 }],
        })
        // 3. ai totals
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ total_requests: 4, total_tokens: 12000, prompt_tokens: 8000, completion_tokens: 4000, total_cost_usd: 0.0021 }],
        })
        // 4. ai breakdown
        .mockResolvedValueOnce({ rowCount: 0, rows: [] });

      const prometheusOutput = await getPrometheusMetrics();

      expect(prometheusOutput).toContain("# TYPE aiqa_test_executions_total counter");
      expect(prometheusOutput).toContain('aiqa_test_executions_total{status="passed"} 8');
      expect(prometheusOutput).toContain('aiqa_test_executions_total{status="failed"} 2');
      expect(prometheusOutput).toContain("aiqa_ai_tokens_total 12000");
      expect(prometheusOutput).toContain("aiqa_jobs_status_count{status=\"active\"} 1");
    });

    it("GET /api/monitoring/health returns detailed health checks", async () => {
      (pool.query as any).mockResolvedValueOnce({ rowCount: 1, rows: [{ "?column?": 1 }] });

      const res = await app!.inject({
        method: "GET",
        url: "/api/monitoring/health",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe("healthy");
      expect(body.checks.database.status).toBe("up");
      expect(body.checks.storage.status).toBe("up");
      expect(body.checks.worker.status).toBe("up");
      expect(body.system).toHaveProperty("heapUsedMb");
      expect(body.system).toHaveProperty("uptimeSeconds");
    });

    it("GET /metrics returns 200 with text/plain Prometheus format", async () => {
      (pool.query as any)
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ total: 1, passed: 1, failed: 0, skipped: 0, inconclusive: 0, flaky: 0 }] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ total: 0, pending: 0, active: 0, completed: 0, failed: 0, retrying: 0, cancelled: 0 }] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ total_requests: 0, total_tokens: 0, prompt_tokens: 0, completion_tokens: 0, total_cost_usd: 0 }] })
        .mockResolvedValueOnce({ rowCount: 0, rows: [] });

      const res = await app!.inject({
        method: "GET",
        url: "/metrics",
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");
      expect(res.body).toContain("aiqa_test_executions_total");
    });
  });
});
