import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { pool } from "../config/db";
import bugReportRoutes from "../routes/bugReports";

describe("Bug report API failures", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("includes API check failures in the bug report list", async () => {
    const report = {
      id: "00000000-0000-4000-8000-000000000001",
      result_id: null,
      api_result_id: "00000000-0000-4000-8000-000000000002",
      title: "GET Inventory",
      description: "API check failed: expected HTTP 200, received 401",
      severity: "medium",
      classification: "unknown",
      probable_cause: null,
      status: "suspected",
      source: "api",
    };
    const query = vi.spyOn(pool, "query").mockResolvedValueOnce({
      rows: [report],
      rowCount: 1,
    } as never);
    const app = Fastify();
    app.register(bugReportRoutes);

    const response = await app.inject({ method: "GET", url: "/bug-reports" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject([report]);
    expect(query.mock.calls[0][0]).toContain("LEFT JOIN api_test_results ar");
    await app.close();
  });

  it("allows an API bug report to be reviewed", async () => {
    const query = vi.spyOn(pool, "query")
      .mockResolvedValueOnce({
        rows: [{ project_id: "00000000-0000-4000-8000-000000000003" }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({
        rows: [{ id: "00000000-0000-4000-8000-000000000001", status: "confirmed" }],
        rowCount: 1,
      } as never);
    const app = Fastify();
    app.register(bugReportRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/bug-reports/00000000-0000-4000-8000-000000000001/status",
      payload: { status: "confirmed" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("confirmed");
    expect(query.mock.calls[0][0]).toContain("LEFT JOIN api_test_results ar");
    await app.close();
  });
});
