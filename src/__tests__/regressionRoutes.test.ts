import Fastify from "fastify";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createApiKeyHook } from "../services/auth";
import regressionRoutes from "../routes/regression";
import * as regressionService from "../services/regressionService";

vi.mock("../services/regressionService");

describe("regression routes", () => {
  let app: ReturnType<typeof Fastify> | undefined;
  const testApiKey = "test-platform-api-key";

  beforeEach(() => {
    vi.clearAllMocks();
    app = Fastify();
    app.addHook("onRequest", createApiKeyHook(testApiKey));
    app.register(regressionRoutes);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const validProjectId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const validBaseRunId = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22";
  const validTargetRunId = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33";

  it("requires platform API key", async () => {
    const res = await app!.inject({
      method: "GET",
      url: `/projects/${validProjectId}/flaky-tests`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("compares two runs with valid UUID query params", async () => {
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
    expect(regressionService.compareRuns).toHaveBeenCalledWith(validBaseRunId, validTargetRunId);
  });

  it("returns 400 for invalid UUIDs in compare query params", async () => {
    const res = await app!.inject({
      method: "GET",
      url: `/projects/${validProjectId}/runs/compare?baseRunId=invalid&targetRunId=${validTargetRunId}`,
      headers: { "x-api-key": testApiKey },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error");
  });

  it("returns flaky tests list", async () => {
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

  it("recommends tests based on changed files", async () => {
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
