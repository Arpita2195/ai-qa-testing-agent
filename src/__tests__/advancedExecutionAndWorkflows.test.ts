import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import {
  extractJsonValue,
  interpolateTemplate,
  runMultiStepApiTest,
  type ApiWorkflowStep,
} from "../services/apiRunner";
import {
  executeConcurrentPool,
  runWebTestWithRetries,
  runApiTestWithRetries,
} from "../services/executionManager";
import { computeNextRunDate } from "../services/scheduler";
import { validateAutomationInstructions } from "../services/automationConverter";
import { scheduleRoutes } from "../routes/schedules";
import runEvidenceRoutes from "../routes/runEvidence";
import * as apiRunnerModule from "../services/apiRunner";
import * as runnerModule from "../services/runner";
import { pool } from "../config/db";

describe("TASK 8: Advanced Test Execution & Workflow Management", () => {
  describe("1. Multi-Step API Testing & Context Chaining", () => {
    it("extractJsonValue extracts top-level and nested dot-notation fields", () => {
      const data = {
        token: "jwt_token_123",
        user: {
          id: "usr_456",
          profile: {
            role: "admin",
          },
        },
        items: [{ id: "item_1" }, { id: "item_2" }],
      };

      expect(extractJsonValue(data, "token")).toBe("jwt_token_123");
      expect(extractJsonValue(data, "user.id")).toBe("usr_456");
      expect(extractJsonValue(data, "user.profile.role")).toBe("admin");
      expect(extractJsonValue(data, "items.1.id")).toBe("item_2");
      expect(extractJsonValue(data, "nonexistent")).toBeUndefined();
      expect(extractJsonValue(null, "token")).toBeUndefined();
    });

    it("interpolateTemplate replaces placeholders in strings, headers, and bodies", () => {
      const context = {
        token: "secret_token_abc",
        userId: "9988",
        status: "active",
      };

      const path = "/api/users/{{userId}}";
      const headers = {
        Authorization: "Bearer {{token}}",
        "Content-Type": "application/json",
      };
      const body = {
        id: "{{userId}}",
        status: "{{status}}",
        count: 10,
      };

      expect(interpolateTemplate(path, context)).toBe("/api/users/9988");
      expect(interpolateTemplate(headers, context)).toEqual({
        Authorization: "Bearer secret_token_abc",
        "Content-Type": "application/json",
      });
      expect(interpolateTemplate(body, context)).toEqual({
        id: "9988",
        status: "active",
        count: 10,
      });
    });

    it("runMultiStepApiTest executes chained requests and reuses extracted variables", async () => {
      const mockRunApi = vi.fn();

      // Step 1: Login -> returns token
      mockRunApi.mockResolvedValueOnce({
        status: "passed",
        actualStatus: 200,
        responseMs: 80,
        errorMessage: null,
        responseSnippet: JSON.stringify({ token: "auth_token_xyz", userId: "u123" }),
      });

      // Step 2: Create User with extracted token
      mockRunApi.mockResolvedValueOnce({
        status: "passed",
        actualStatus: 201,
        responseMs: 110,
        errorMessage: null,
        responseSnippet: JSON.stringify({ id: "created_456" }),
      });

      const steps: ApiWorkflowStep[] = [
        {
          name: "Login",
          method: "POST",
          path: "/api/auth/login",
          body: { username: "tester", password: "pw" },
          expected_status: 200,
          extract: {
            authToken: "token",
            userId: "userId",
          },
        },
        {
          name: "Get User Profile",
          method: "GET",
          path: "/api/users/{{userId}}",
          headers: {
            Authorization: "Bearer {{authToken}}",
          },
          expected_status: 201,
        },
      ];

      const result = await runMultiStepApiTest("https://api.example.test", steps, { runner: mockRunApi });

      expect(result.status).toBe("passed");
      expect(result.stepResults).toHaveLength(2);
      expect(result.extractedContext).toEqual({
        authToken: "auth_token_xyz",
        userId: "u123",
      });

      // Verify step 2 used interpolated variables
      expect(mockRunApi).toHaveBeenLastCalledWith(
        "https://api.example.test",
        expect.objectContaining({
          path: "/api/users/u123",
          headers: { Authorization: "Bearer auth_token_xyz" },
        }),
      );
    });

    it("runMultiStepApiTest halts workflow immediately upon step failure", async () => {
      const mockRunApi = vi.fn();

      // Step 1 fails
      mockRunApi.mockResolvedValueOnce({
        status: "failed",
        actualStatus: 401,
        responseMs: 50,
        errorMessage: "Unauthorized",
        responseSnippet: '{"error": "invalid credentials"}',
      });

      const steps: ApiWorkflowStep[] = [
        {
          name: "Step 1",
          method: "POST",
          path: "/api/login",
          expected_status: 200,
          extract: { token: "token" },
        },
        {
          name: "Step 2",
          method: "GET",
          path: "/api/protected",
          headers: { Authorization: "Bearer {{token}}" },
        },
      ];

      const result = await runMultiStepApiTest("https://api.example.test", steps, { runner: mockRunApi });

      expect(result.status).toBe("failed");
      expect(result.stepResults).toHaveLength(1);
      expect(mockRunApi).toHaveBeenCalledTimes(1);
      expect(result.errorMessage).toContain("Step 1");
    });
  });

  describe("2. Advanced Playwright Automation DSL Validation", () => {
    it("accepts advanced DSL commands: wait, wait for selector, wait for navigation, check, uncheck, screenshot, upload, frame, dialog", () => {
      const webInstructions = {
        target_type: "web" as const,
        web_steps: [
          "goto /login",
          "fill input#username | admin@example.com",
          "fill input#password | secret123",
          "click button#submit",
          "wait 1000",
          "wait for selector div#dashboard",
          "wait for navigation",
          "check input#terms",
          "uncheck input#newsletter",
          "screenshot",
          "upload input#file-upload | test.pdf",
          "frame iframe#embed | click button#confirm",
          "dialog accept",
          "expect visible div#dashboard",
        ],
      };

      const validation = validateAutomationInstructions(webInstructions);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("rejects malicious script attempts and code injection inside advanced commands", () => {
      const maliciousInstructions = {
        target_type: "web" as const,
        web_steps: [
          "goto /login",
          "frame iframe#malicious | eval(process.exit(1))",
        ],
      };

      const validation = validateAutomationInstructions(maliciousInstructions);
      expect(validation.valid).toBe(false);
      expect(validation.errors.some((e) => e.includes("forbidden executable expression"))).toBe(true);
    });
  });

  describe("3. Parallel Test Execution & Concurrency Limit", () => {
    it("executeConcurrentPool limits max active concurrent workers", async () => {
      let activeWorkers = 0;
      let maxActiveWorkers = 0;

      const items = [1, 2, 3, 4, 5];
      const concurrencyLimit = 2;

      const results = await executeConcurrentPool(
        items,
        async (num) => {
          activeWorkers++;
          if (activeWorkers > maxActiveWorkers) {
            maxActiveWorkers = activeWorkers;
          }
          await new Promise((r) => setTimeout(r, 20));
          activeWorkers--;
          return num * 2;
        },
        concurrencyLimit,
      );

      expect(results).toEqual([2, 4, 6, 8, 10]);
      expect(maxActiveWorkers).toBeLessThanOrEqual(concurrencyLimit);
    });
  });

  describe("4. Automatic Retry & Flaky Test Detection", () => {
    it("flags test as flaky when it fails on attempt 1 and passes on attempt 2", async () => {
      const mockRunTestCase = vi.fn();

      // Attempt 1 fails
      mockRunTestCase.mockResolvedValueOnce({
        status: "failed",
        errorMessage: "Assertion failed: element not found",
        durationMs: 150,
        screenshotPath: "fail.png",
        evidence: {} as any,
      });

      // Attempt 2 passes
      mockRunTestCase.mockResolvedValueOnce({
        status: "passed",
        durationMs: 130,
        screenshotPath: "pass.png",
        evidence: {} as any,
      });

      const result = await runWebTestWithRetries(
        "https://example.test",
        ["goto /", "click #btn"],
        { runId: "r1", resultId: "res1" },
        { retries: 2, backoffMs: 5, runner: mockRunTestCase },
      );

      expect(result.status).toBe("passed");
      expect(result.flaky).toBe(true);
      expect(result.retryCount).toBe(1);
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0].status).toBe("failed");
      expect(result.attempts[0].errorType).toBe("assertion");
      expect(result.attempts[1].status).toBe("passed");
    });

    it("marks test as genuinely failed if all retries fail", async () => {
      const mockRunTestCase = vi.fn();

      mockRunTestCase.mockResolvedValue({
        status: "failed",
        errorMessage: "Element timed out",
        durationMs: 100,
        screenshotPath: "fail.png",
        evidence: {} as any,
      });

      const result = await runWebTestWithRetries(
        "https://example.test",
        ["goto /", "click #btn"],
        { runId: "r1", resultId: "res1" },
        { retries: 1, backoffMs: 5, runner: mockRunTestCase },
      );

      expect(result.status).toBe("failed");
      expect(result.flaky).toBe(false);
      expect(result.retryCount).toBe(1);
      expect(result.attempts).toHaveLength(2);
    });

    it("flags API test as flaky when passing on retry", async () => {
      const mockRunApi = vi.fn();

      mockRunApi.mockResolvedValueOnce({
        status: "failed",
        actualStatus: 500,
        responseMs: 100,
        errorMessage: "Internal server error",
        responseSnippet: "{}",
      });

      mockRunApi.mockResolvedValueOnce({
        status: "passed",
        actualStatus: 200,
        responseMs: 80,
        errorMessage: null,
        responseSnippet: "{}",
      });

      const result = await runApiTestWithRetries(
        "https://example.test",
        {
          method: "GET",
          path: "/health",
          headers: {},
          body: null,
          expected_status: 200,
          expected_fields: {},
          max_response_ms: 1000,
        },
        { retries: 1, backoffMs: 5, runner: mockRunApi },
      );

      expect(result.status).toBe("passed");
      expect(result.flaky).toBe(true);
      expect(result.retryCount).toBe(1);
      expect(result.attempts).toHaveLength(2);
    });
  });

  describe("5. Test Execution Scheduling & Cron Calculator", () => {
    it("computes next run dates accurately for hourly, daily, and weekly schedules", () => {
      const base = new Date("2026-11-03T10:00:00.000Z");

      const nextHourly = computeNextRunDate("hourly", null, base);
      expect(nextHourly.getTime()).toBe(base.getTime() + 60 * 60 * 1000);

      const nextDaily = computeNextRunDate("daily", null, base);
      expect(nextDaily.getTime()).toBe(base.getTime() + 24 * 60 * 60 * 1000);

      const nextWeekly = computeNextRunDate("weekly", null, base);
      expect(nextWeekly.getTime()).toBe(base.getTime() + 7 * 24 * 60 * 60 * 1000);
    });

    it("computes next run dates for custom cron expressions", () => {
      // 0 2 * * * (At 02:00 every day)
      const base = new Date("2026-11-03T01:30:00.000Z");
      const nextCron = computeNextRunDate("custom_cron", "0 2 * * *", base);

      expect(nextCron.getHours()).toBe(2);
      expect(nextCron.getMinutes()).toBe(0);
      expect(nextCron.getTime()).toBeGreaterThan(base.getTime());
    });
  });

  describe("6. Schedules HTTP API & RBAC", () => {
    let app: ReturnType<typeof Fastify>;

    beforeEach(() => {
      app = Fastify();
      app.setErrorHandler((error, request, reply) => {
        if (error.name === "AccessDeniedError" || (error as any).statusCode === 403) {
          return reply.code(403).send({ error: error.message });
        }
        reply.code((error as any).statusCode || 500).send({ error: error.message });
      });
      app.register(scheduleRoutes);
    });

    it("requires QA Engineer or Admin role to create schedules, rejecting viewers", async () => {
      // Inject viewer user into request
      app.addHook("onRequest", async (request) => {
        (request as any).user = {
          id: "00000000-0000-4000-8000-000000000099",
          email: "viewer@example.com",
          role: "viewer",
        };
      });

      const response = await app.inject({
        method: "POST",
        url: "/projects/00000000-0000-4000-8000-000000000001/schedules",
        payload: {
          name: "Nightly Regression",
          suite_id: "00000000-0000-4000-8000-000000000002",
          schedule_type: "daily",
        },
      });

      // Assert viewer is denied
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toContain("Access denied");
    });
  });

  describe("7. Execution Export API (JSON & CSV)", () => {
    let app: ReturnType<typeof Fastify>;

    beforeEach(() => {
      app = Fastify();
      app.register(runEvidenceRoutes);
    });

    it("returns 400 for invalid run UUID on export", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/runs/invalid-uuid/export?format=csv",
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain("Invalid run id");
    });

    it("generates formatted CSV export with flaky and retry counts", async () => {
      const mockQuery = vi.spyOn(pool, "query");
      const validRunId = "c0000000-0000-4000-8000-000000000001";
      const validProjectId = "c0000000-0000-4000-8000-000000000002";

      // 1. Mock run
      mockQuery.mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: validRunId,
            project_id: validProjectId,
            project_name: "Test Project",
            base_url: "https://app.test",
            status: "passed",
            concurrency: 2,
            retries: 1,
            flaky_count: 1,
            inconclusive_count: 0,
            skipped_count: 0,
            total_count: 2,
            started_at: new Date(),
            finished_at: new Date(),
          },
        ],
      } as any);

      // 2. Mock web results
      mockQuery.mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: "w1",
            test_case_id: "tc1",
            title: "Login Flow",
            status: "passed",
            error_message: null,
            duration_ms: 1200,
            retry_count: 1,
            flaky: true,
            attempts: [],
            screenshot_path: "screenshot.png",
          },
        ],
      } as any);

      // 3. Mock API results
      mockQuery.mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: "a1",
            endpoint_id: "ep1",
            endpoint_name: "Health Endpoint",
            method: "GET",
            path: "/health",
            status: "passed",
            actual_status: 200,
            response_ms: 95,
            error_message: null,
            retry_count: 0,
            flaky: false,
            attempts: [],
            step_results: [],
          },
        ],
      } as any);

      const response = await app.inject({
        method: "GET",
        url: `/runs/${validRunId}/export?format=csv`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/csv");
      const csv = response.body;

      expect(csv).toContain("Test Type,ID,Name/Title,Method/Path,Status,Flaky,Retries,Duration (ms),Error");
      expect(csv).toContain('"Web UI","w1","Login Flow","","passed","YES","1","1200",""');
      expect(csv).toContain('"REST API","a1","Health Endpoint","GET /health","passed","NO","0","95",""');

      mockQuery.mockRestore();
    });
  });
});
