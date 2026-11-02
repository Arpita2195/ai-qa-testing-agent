import Fastify from "fastify";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { pool } from "../config/db";
import { createApiKeyHook } from "../services/auth";
import regressionRoutes from "../routes/regression";
import * as regressionService from "../services/regressionService";

vi.mock("../config/db", () => ({
  pool: {
    query: vi.fn(),
  },
}));

vi.mock("../services/regressionService", async () => {
  const actual = await vi.importActual<typeof regressionService>("../services/regressionService");
  return {
    ...actual,
    compareRuns: vi.fn(),
    detectFlakyTests: vi.fn(),
    recommendTestsForChanges: vi.fn(),
  };
});

describe("regression routes", () => {
  let app: ReturnType<typeof Fastify> | undefined;
  const testApiKey = "test-platform-api-key";
  const validProjectId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const validBaseRunId = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22";
  const validTargetRunId = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33";

  beforeEach(() => {
    vi.clearAllMocks();
    // Default pool.query mock: project exists
    vi.mocked(pool.query).mockImplementation(async (sql: string) => {
      if (sql.includes("FROM projects WHERE id = $1")) {
        return { rowCount: 1, rows: [{ id: validProjectId, name: "StockFlow" }] } as any;
      }
      return { rowCount: 0, rows: [] } as any;
    });

    app = Fastify();
    app.addHook("onRequest", createApiKeyHook(testApiKey));
    app.register(regressionRoutes);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("requires platform API key", async () => {
    const res = await app!.inject({
      method: "GET",
      url: `/projects/${validProjectId}/flaky-tests`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("compares two runs with valid UUID query params and enforces project scope", async () => {
    vi.mocked(regressionService.compareRuns).mockResolvedValueOnce({
      summary: {
        base_run_id: validBaseRunId,
        target_run_id: validTargetRunId,
        total_tests: 10,
        passed_count: 9,
        failed_count: 1,
        new_failures_count: 1,
        recurring_failures_count: 0,
        fixed_tests_count: 0,
        stable_passes_count: 9,
        added_tests_count: 0,
        removed_tests_count: 0,
        duration_delta_ms: 150,
        regression_detected: true,
      },
      items: [],
    });

    const res = await app!.inject({
      method: "GET",
      url: `/projects/${validProjectId}/runs/compare?baseRunId=${validBaseRunId}&targetRunId=${validTargetRunId}`,
      headers: { "x-api-key": testApiKey },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary.regression_detected).toBe(true);
    expect(body.summary.new_failures_count).toBe(1);
    expect(regressionService.compareRuns).toHaveBeenCalledWith(
      validBaseRunId,
      validTargetRunId,
      validProjectId,
    );
  });

  it("returns 400 for invalid UUIDs in compare query params", async () => {
    const res = await app!.inject({
      method: "GET",
      url: `/projects/${validProjectId}/runs/compare?baseRunId=invalid&targetRunId=${validTargetRunId}`,
      headers: { "x-api-key": testApiKey },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("baseRunId and targetRunId must be UUIDs");
  });

  it("returns 400 when comparing a run with itself", async () => {
    const res = await app!.inject({
      method: "GET",
      url: `/projects/${validProjectId}/runs/compare?baseRunId=${validBaseRunId}&targetRunId=${validBaseRunId}`,
      headers: { "x-api-key": testApiKey },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("must be distinct");
  });

  it("returns 404 when the project does not exist in the database", async () => {
    vi.mocked(pool.query).mockImplementation(async (sql: string) => {
      if (sql.includes("FROM projects WHERE id = $1")) {
        return { rowCount: 0, rows: [] } as any;
      }
      return { rowCount: 0, rows: [] } as any;
    });

    const res = await app!.inject({
      method: "GET",
      url: `/projects/${validProjectId}/runs/compare?baseRunId=${validBaseRunId}&targetRunId=${validTargetRunId}`,
      headers: { "x-api-key": testApiKey },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("Project");
    expect(res.json().error).toContain("not found");
  });

  it("returns 404 when a run is not found", async () => {
    vi.mocked(regressionService.compareRuns).mockRejectedValueOnce(
      new regressionService.NonexistentRunError(`Base run ${validBaseRunId} not found`),
    );

    const res = await app!.inject({
      method: "GET",
      url: `/projects/${validProjectId}/runs/compare?baseRunId=${validBaseRunId}&targetRunId=${validTargetRunId}`,
      headers: { "x-api-key": testApiKey },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("not found");
  });

  it("returns 403 when cross-project comparison is attempted", async () => {
    vi.mocked(regressionService.compareRuns).mockRejectedValueOnce(
      new regressionService.CrossProjectComparisonError(
        "Cross-project comparison is prohibited: runs belong to different projects",
      ),
    );

    const res = await app!.inject({
      method: "GET",
      url: `/projects/${validProjectId}/runs/compare?baseRunId=${validBaseRunId}&targetRunId=${validTargetRunId}`,
      headers: { "x-api-key": testApiKey },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("Cross-project comparison is prohibited");
  });

  it("returns 403 when a run does not belong to the requested project", async () => {
    vi.mocked(regressionService.compareRuns).mockRejectedValueOnce(
      new regressionService.CrossProjectComparisonError(
        `Run does not belong to project ${validProjectId}`,
      ),
    );

    const res = await app!.inject({
      method: "GET",
      url: `/projects/${validProjectId}/runs/compare?baseRunId=${validBaseRunId}&targetRunId=${validTargetRunId}`,
      headers: { "x-api-key": testApiKey },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("does not belong to project");
  });

  it("returns flaky tests list for valid project", async () => {
    vi.mocked(regressionService.detectFlakyTests).mockResolvedValueOnce([
      {
        id: "tc-1",
        type: "web",
        title: "Flaky modal test",
        module: "frontend",
        total_runs: 10,
        passed_runs: 5,
        failed_runs: 5,
        flakiness_score: 1.0,
        last_status: "passed",
        last_run_at: "2026-10-27T10:00:00.000Z",
      },
    ]);

    const res = await app!.inject({
      method: "GET",
      url: `/projects/${validProjectId}/flaky-tests?limit=20`,
      headers: { "x-api-key": testApiKey },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.flaky_tests_count).toBe(1);
    expect(body.flaky_tests[0].title).toBe("Flaky modal test");
    expect(regressionService.detectFlakyTests).toHaveBeenCalledWith(validProjectId, 20);
  });

  it("recommends tests based on changed files for valid project", async () => {
    vi.mocked(regressionService.recommendTestsForChanges).mockResolvedValueOnce({
      changed_files: ["src/auth/login.ts"],
      matched_keywords: ["auth", "login"],
      recommended_test_cases: [
        {
          id: "tc-auth",
          title: "Sign in workflow",
          module: "auth",
          priority: "high",
          matched_reasons: ['Matches keyword "auth"'],
        },
      ],
      recommended_api_endpoints: [],
    });

    const res = await app!.inject({
      method: "POST",
      url: `/projects/${validProjectId}/recommend-tests`,
      headers: { "x-api-key": testApiKey },
      payload: {
        changed_files: ["src/auth/login.ts"],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.recommended_test_cases).toHaveLength(1);
    expect(body.recommended_test_cases[0].id).toBe("tc-auth");
  });
});

