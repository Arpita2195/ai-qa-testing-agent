import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../config/db";
import { runApiTestWithRetries } from "../services/executionManager";
import apiRunRoutes from "../routes/apiRuns";

vi.mock("../config/db", () => ({
  pool: {
    query: vi.fn(),
  },
}));

vi.mock("../services/executionManager", () => ({
  runApiTestWithRetries: vi.fn(),
}));

describe("API endpoint runs", () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const endpointId = "22222222-2222-4222-8222-222222222222";
  const runId = "33333333-3333-4333-8333-333333333333";
  let app: ReturnType<typeof Fastify>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = Fastify();
    app.register(apiRunRoutes);
    vi.mocked(runApiTestWithRetries).mockResolvedValue({
      status: "passed",
      actualStatus: 200,
      responseMs: 12,
      errorMessage: null,
      responseSnippet: "{}",
      flaky: false,
      retryCount: 0,
      attempts: [],
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("runs only the selected approved endpoint", async () => {
    const endpoint = {
      id: endpointId,
      name: "Get customer",
      method: "GET",
      path: "/customers/1",
      headers: {},
      body: null,
      expected_status: 200,
      expected_fields: {},
      max_response_ms: null,
    };
    vi.mocked(pool.query).mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, base_url FROM projects")) {
        return { rowCount: 1, rows: [{ id: projectId, base_url: "https://example.com" }] } as never;
      }
      if (sql.includes("FROM api_endpoints")) {
        return { rowCount: 1, rows: [endpoint] } as never;
      }
      if (sql.includes("INSERT INTO test_runs")) {
        return { rowCount: 1, rows: [{ id: runId, project_id: projectId }] } as never;
      }
      if (sql.includes("INSERT INTO api_test_results")) {
        return { rowCount: 1, rows: [{ id: "44444444-4444-4444-8444-444444444444" }] } as never;
      }
      if (sql.includes("UPDATE test_runs")) {
        return { rowCount: 1, rows: [{ id: runId, project_id: projectId, status: "passed" }] } as never;
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const response = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/api-runs`,
      payload: { endpointId },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().id).toBe(runId);
    const endpointQuery = vi.mocked(pool.query).mock.calls.find(([sql]) =>
      String(sql).includes("FROM api_endpoints"),
    );
    expect(endpointQuery?.[0]).toContain("id = $2");
    expect(endpointQuery?.[1]).toEqual([projectId, endpointId]);
    expect(runApiTestWithRetries).toHaveBeenCalledWith(
      "https://example.com",
      endpoint,
      expect.objectContaining({ projectId }),
    );
  });

  it("does not create a run for a pending or out-of-project endpoint", async () => {
    vi.mocked(pool.query).mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, base_url FROM projects")) {
        return { rowCount: 1, rows: [{ id: projectId, base_url: "https://example.com" }] } as never;
      }
      if (sql.includes("FROM api_endpoints")) {
        return { rowCount: 0, rows: [] } as never;
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const response = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/api-runs`,
      payload: { endpointId },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toContain("Approved API endpoint not found");
    expect(pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO test_runs"),
      expect.anything(),
    );
    expect(runApiTestWithRetries).not.toHaveBeenCalled();
  });
});
