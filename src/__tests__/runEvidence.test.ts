import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

const mocked = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../config/db", () => ({ pool: { query: mocked.query } }));

import runEvidenceRoutes from "../routes/runEvidence";
import { classifyRunStatus, classifyWebStatus, scrubEvidence } from "../services/runner";
import { buildRunReport, renderRunReportHtml } from "../services/runReport";

afterEach(() => {
  vi.clearAllMocks();
});

describe("web result classification", () => {
  it("classifies an assertion failure as failed", () => {
    expect(classifyWebStatus("Assertion failed: expected text", "expect text missing", 1)).toBe("failed");
  });

  it("classifies a DNS/network failure as inconclusive", () => {
    expect(classifyWebStatus("net::ERR_NAME_NOT_RESOLVED", "goto /", 0)).toBe("inconclusive");
  });

  it("uses the shared run status precedence", () => {
    expect(classifyRunStatus(["passed", "failed"])).toBe("failed");
    expect(classifyRunStatus(["passed", "passed"])).toBe("passed");
    expect(classifyRunStatus(["passed", "inconclusive"])).toBe("inconclusive");
  });
});

describe("evidence and report scrubbing", () => {
  const credentials = { email: "private-user@example.invalid", password: "private-password-fixture" };

  it("removes credential values and sensitive header fields from evidence", () => {
    const evidence = scrubEvidence({
      errorMessage: "Failed for private-user@example.invalid",
      headers: { Cookie: "private-password-fixture", accept: "text/html" },
    }, credentials);
    expect(JSON.stringify(evidence)).not.toContain(credentials.email);
    expect(JSON.stringify(evidence)).not.toContain(credentials.password);
    expect(JSON.stringify(evidence).toLowerCase()).not.toContain("cookie");
    expect(evidence).toMatchObject({ errorMessage: "Failed for [hidden]", headers: { accept: "text/html" } });
  });

  it("scrubs report content and renders totals plus a marked failing step", async () => {
    const report = buildRunReport({
      runId: "run-1",
      projectName: "StockFlow",
      baseUrl: "https://example.invalid",
      startedAt: "2026-10-18T08:00:00.000Z",
      finishedAt: "2026-10-18T08:00:02.000Z",
      tests: [{
        id: "result-1",
        title: "A private-user@example.invalid case",
        steps: ["goto /", "fill #email | {{STOCKFLOW_TEST_EMAIL}}", "expect text missing"],
        status: "failed",
        duration_ms: 2000,
        error_message: "Failed for private-password-fixture",
        evidence: {
          status: "failed",
          durationMs: 2000,
          failureStep: "expect text missing",
          failureStepIndex: 2,
          errorMessage: "Failed for private-password-fixture",
          browserErrors: [],
          failedRequests: [],
          httpErrors: [],
          finalUrl: "https://example.invalid/",
          finalTitle: "Page",
          screenshotPath: null,
          tracePath: null,
          traceNote: null,
          evidencePath: null,
        },
      }],
    }, credentials);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(credentials.email);
    expect(serialized).not.toContain(credentials.password);
    expect(report.totals).toMatchObject({ passed: 0, failed: 1, skipped: 0, inconclusive: 0, successRate: 0 });
    const html = await renderRunReportHtml(report);
    expect(html).toContain("Failed 1");
    expect(html).toContain("FAILED STEP:");
    expect(html).toContain("expect text missing");
    expect(html).not.toContain(credentials.email);
    expect(html).not.toContain(credentials.password);
  });
});

describe("run evidence routes", () => {
  it("rejects invalid IDs and non-allowlisted evidence file names with 400", async () => {
    const app = Fastify();
    await app.register(runEvidenceRoutes);
    const badId = await app.inject({
      method: "GET",
      url: "/runs/not-a-uuid/evidence/11111111-1111-4111-8111-111111111111/screenshot.png",
    });
    const badFile = await app.inject({
      method: "GET",
      url: "/runs/11111111-1111-4111-8111-111111111111/evidence/22222222-2222-4222-8222-222222222222/not-allowed",
    });
    expect(badId.statusCode).toBe(400);
    expect(badFile.statusCode).toBe(400);
    expect(mocked.query).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("credential redaction in API responses and database", () => {
  it("redacts credentials from GET /runs/:id response", async () => {
    const { default: runRoutes } = await import("../routes/runs");
    const { env } = await import("../config/env");
    const app = Fastify();
    await app.register(runRoutes);

    const secretEmail = env.STOCKFLOW_TEST_EMAIL || "test-email@example.com";
    const secretPassword = env.STOCKFLOW_TEST_PASSWORD || "test-password";
    const runId = "33333333-3333-4333-8333-333333333333";

    mocked.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM test_runs")) {
        return {
          rows: [{ id: runId, project_id: "44444444-4444-4444-8444-444444444444", status: "failed" }],
        };
      }
      if (sql.includes("FROM test_results")) {
        return {
          rows: [{
            id: "55555555-5555-4555-8555-555555555555",
            run_id: runId,
            test_case_id: "66666666-6666-4666-8666-666666666666",
            status: "failed",
            error_message: `Login failed for ${secretEmail} with ${secretPassword}`,
            duration_ms: 100,
            screenshot_path: null,
            trace_path: null,
            evidence: {
              status: "failed",
              errorMessage: `Auth failed for ${secretEmail}`,
              browserErrors: [`Error containing ${secretPassword}`],
              failedRequests: [],
              httpErrors: [],
              finalUrl: "https://example.com",
              finalTitle: "App",
              screenshotPath: null,
              tracePath: null,
              traceNote: null,
              evidencePath: null,
              durationMs: 100,
              failureStep: null,
              failureStepIndex: null,
            },
            title: `Test for ${secretEmail}`,
            steps: [`fill #user | ${secretEmail}`, "fill #pass | {{STOCKFLOW_TEST_PASSWORD}}"],
          }],
        };
      }
      if (sql.includes("FROM api_test_results")) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const response = await app.inject({
      method: "GET",
      url: `/runs/${runId}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.body;
    expect(body).not.toContain(secretEmail);
    expect(body).not.toContain(secretPassword);
    expect(body).toContain("[hidden]");
    expect(body).toContain("{{STOCKFLOW_TEST_PASSWORD}}");
    await app.close();
  });

  it("preserves {{...}} placeholders and redacts real credentials when saving test cases", async () => {
    const { default: testCaseRoutes } = await import("../routes/testCases");
    const { env } = await import("../config/env");
    const app = Fastify();
    await app.register(testCaseRoutes);

    const secretEmail = env.STOCKFLOW_TEST_EMAIL || "test-email@example.com";
    const projectId = "77777777-7777-4777-8777-777777777777";

    let capturedQueryArgs: unknown[] = [];
    mocked.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT 1 FROM projects")) {
        return { rowCount: 1, rows: [{ exists: 1 }] };
      }
      if (sql.includes("INSERT INTO test_cases")) {
        capturedQueryArgs = params ?? [];
        return {
          rows: [{
            id: "88888888-8888-4888-8888-888888888888",
            project_id: projectId,
            title: "Test case",
            description: null,
            steps: JSON.parse((params?.[3] as string) ?? "[]"),
            expected_result: null,
            review_status: "approved",
          }],
        };
      }
      return { rows: [] };
    });

    const response = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/test-cases`,
      payload: {
        title: `Test with ${secretEmail}`,
        steps: [
          `fill #email | ${secretEmail}`,
          "fill #password | {{STOCKFLOW_TEST_PASSWORD}}",
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    // Real credential must not appear in saved DB steps JSON
    const savedStepsJson = capturedQueryArgs[3] as string;
    expect(savedStepsJson).not.toContain(secretEmail);
    expect(savedStepsJson).toContain("[hidden]");
    expect(savedStepsJson).toContain("{{STOCKFLOW_TEST_PASSWORD}}");

    // Real credential must not appear in response
    expect(response.body).not.toContain(secretEmail);
    expect(response.body).toContain("[hidden]");
    expect(response.body).toContain("{{STOCKFLOW_TEST_PASSWORD}}");
    await app.close();
  });
});

