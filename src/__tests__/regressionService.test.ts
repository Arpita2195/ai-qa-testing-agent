import { describe, expect, it, vi, beforeEach } from "vitest";
import { pool } from "../config/db";
import {
  compareRuns,
  detectFlakyTests,
  recommendTestsForChanges,
} from "../services/regressionService";

vi.mock("../config/db", () => ({
  pool: {
    query: vi.fn(),
  },
}));

describe("regressionService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("compareRuns", () => {
    it("accurately detects new failures, recurring failures, fixed tests, and stable passes", async () => {
      const baseRunId = "11111111-1111-1111-1111-111111111111";
      const targetRunId = "22222222-2222-2222-2222-222222222222";

      // Mock runs query
      vi.mocked(pool.query).mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes("FROM test_runs WHERE id IN")) {
          return {
            rowCount: 2,
            rows: [
              {
                id: baseRunId,
                project_id: "p1",
                status: "failed",
                commit_sha: "abc111",
                build_id: "b1",
                branch: "main",
                environment: "test",
                started_at: new Date("2026-10-27T10:00:00Z"),
                finished_at: new Date("2026-10-27T10:01:00Z"),
              },
              {
                id: targetRunId,
                project_id: "p1",
                status: "failed",
                commit_sha: "def222",
                build_id: "b2",
                branch: "main",
                environment: "test",
                started_at: new Date("2026-10-27T11:00:00Z"),
                finished_at: new Date("2026-10-27T11:01:10Z"),
              },
            ],
          } as any;
        }

        if (sql.includes("FROM test_results tr")) {
          return {
            rowCount: 8,
            rows: [
              // Test 1: passed in base, failed in target -> NEW FAILURE
              { run_id: baseRunId, test_case_id: "tc-1", title: "Login form", status: "passed", duration_ms: 1200 },
              { run_id: targetRunId, test_case_id: "tc-1", title: "Login form", status: "failed", duration_ms: 1500, error_message: "Button not clickable" },

              // Test 2: failed in base, passed in target -> FIXED
              { run_id: baseRunId, test_case_id: "tc-2", title: "Search products", status: "failed", duration_ms: 2000, error_message: "Network timeout" },
              { run_id: targetRunId, test_case_id: "tc-2", title: "Search products", status: "passed", duration_ms: 1800 },

              // Test 3: failed in base, failed in target -> RECURRING FAILURE
              { run_id: baseRunId, test_case_id: "tc-3", title: "Filter orders", status: "failed", duration_ms: 900, error_message: "500 Error" },
              { run_id: targetRunId, test_case_id: "tc-3", title: "Filter orders", status: "failed", duration_ms: 950, error_message: "500 Error" },

              // Test 4: passed in base, passed in target -> STABLE PASS
              { run_id: baseRunId, test_case_id: "tc-4", title: "Checkout page load", status: "passed", duration_ms: 500 },
              { run_id: targetRunId, test_case_id: "tc-4", title: "Checkout page load", status: "passed", duration_ms: 520 },
            ],
          } as any;
        }

        if (sql.includes("FROM api_test_results ar")) {
          return {
            rowCount: 2,
            rows: [
              // Endpoint 1: added in target, passed -> ADDED
              { run_id: targetRunId, endpoint_id: "ep-1", name: "POST /products", status: "passed", response_ms: 150 },
              // Endpoint 2: removed from target -> REMOVED
              { run_id: baseRunId, endpoint_id: "ep-2", name: "GET /legacy", status: "passed", response_ms: 200 },
            ],
          } as any;
        }

        return { rowCount: 0, rows: [] } as any;
      });

      const result = await compareRuns(baseRunId, targetRunId);

      expect(result.summary.base_run_id).toBe(baseRunId);
      expect(result.summary.target_run_id).toBe(targetRunId);
      expect(result.summary.base_commit_sha).toBe("abc111");
      expect(result.summary.target_commit_sha).toBe("def222");

      // Verify classification counts
      expect(result.summary.new_failures_count).toBe(1);
      expect(result.summary.recurring_failures_count).toBe(1);
      expect(result.summary.fixed_tests_count).toBe(1);
      expect(result.summary.stable_passes_count).toBe(1);
      expect(result.summary.added_tests_count).toBe(1);
      expect(result.summary.removed_tests_count).toBe(1);

      // Total target tests: tc-1, tc-2, tc-3, tc-4, ep-1 = 5
      expect(result.summary.total_tests).toBe(5);
      expect(result.summary.passed_count).toBe(3); // tc-2, tc-4, ep-1
      expect(result.summary.failed_count).toBe(2); // tc-1, tc-3
      expect(result.summary.regression_detected).toBe(true);

      // Verify specific items
      const newFailure = result.items.find((i) => i.id === "tc-1");
      expect(newFailure?.change_type).toBe("new_failure");
      expect(newFailure?.base_status).toBe("passed");
      expect(newFailure?.target_status).toBe("failed");
      expect(newFailure?.error_message).toBe("Button not clickable");

      const fixed = result.items.find((i) => i.id === "tc-2");
      expect(fixed?.change_type).toBe("fixed");

      const recurring = result.items.find((i) => i.id === "tc-3");
      expect(recurring?.change_type).toBe("recurring_failure");

      const added = result.items.find((i) => i.id === "ep-1");
      expect(added?.change_type).toBe("added");

      const removed = result.items.find((i) => i.id === "ep-2");
      expect(removed?.change_type).toBe("removed");
    });

    it("throws clear error when a run is not found", async () => {
      vi.mocked(pool.query).mockResolvedValueOnce({ rowCount: 0, rows: [] } as any);
      await expect(compareRuns("r1", "r2")).rejects.toThrow("Base run r1 not found");
    });

    it("throws clear error when target run is not found", async () => {
      vi.mocked(pool.query).mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: "r1", project_id: "p1" }],
      } as any);
      await expect(compareRuns("r1", "r2")).rejects.toThrow("Target run r2 not found");
    });

    it("rejects comparing a run with itself", async () => {
      await expect(compareRuns("r1", "r1")).rejects.toThrow("must be distinct");
    });

    it("throws when expected project does not exist", async () => {
      vi.mocked(pool.query).mockImplementation(async (sql: string) => {
        if (sql.includes("FROM projects WHERE id = $1")) {
          return { rowCount: 0, rows: [] } as any;
        }
        return { rowCount: 0, rows: [] } as any;
      });

      await expect(compareRuns("r1", "r2", "nonexistent-p")).rejects.toThrow(
        "Project nonexistent-p not found",
      );
    });

    it("rejects comparisons involving runs from different projects", async () => {
      vi.mocked(pool.query).mockImplementation(async (sql: string) => {
        if (sql.includes("FROM test_runs WHERE id IN")) {
          return {
            rowCount: 2,
            rows: [
              { id: "r1", project_id: "project-alpha" },
              { id: "r2", project_id: "project-beta" },
            ],
          } as any;
        }
        return { rowCount: 0, rows: [] } as any;
      });

      await expect(compareRuns("r1", "r2")).rejects.toThrow(
        "Cross-project comparison is prohibited",
      );
    });

    it("rejects comparison when run does not belong to expectedProjectId", async () => {
      vi.mocked(pool.query).mockImplementation(async (sql: string) => {
        if (sql.includes("FROM projects WHERE id = $1")) {
          return { rowCount: 1, rows: [{ id: "project-target" }] } as any;
        }
        if (sql.includes("FROM test_runs WHERE id IN")) {
          return {
            rowCount: 2,
            rows: [
              { id: "r1", project_id: "project-other" },
              { id: "r2", project_id: "project-other" },
            ],
          } as any;
        }
        return { rowCount: 0, rows: [] } as any;
      });

      await expect(compareRuns("r1", "r2", "project-target")).rejects.toThrow(
        "Run does not belong to project project-target",
      );
    });
  });

  describe("detectFlakyTests", () => {
    it("identifies tests that flip between passed and failed and computes score", async () => {
      const projectId = "p-1";
      vi.mocked(pool.query).mockImplementation(async (sql: string) => {
        if (sql.includes("FROM test_results tr")) {
          return {
            rowCount: 2,
            rows: [
              {
                test_case_id: "tc-flaky-1",
                title: "Payment submit button",
                module: "checkout",
                total_runs: "10",
                passed_runs: "5",
                failed_runs: "5",
                last_status: "passed",
                last_run_at: new Date("2026-10-27T12:00:00Z"),
                last_error: "Timed out waiting for selector",
              },
              {
                test_case_id: "tc-flaky-2",
                title: "Dropdown animation",
                module: "navigation",
                total_runs: "10",
                passed_runs: "8",
                failed_runs: "2",
                last_status: "failed",
                last_run_at: new Date("2026-10-27T12:05:00Z"),
                last_error: "Element not visible",
              },
            ],
          } as any;
        }

        if (sql.includes("FROM api_test_results ar")) {
          return {
            rowCount: 1,
            rows: [{
              endpoint_id: "api-inventory",
              name: "GET Inventory",
              total_runs: "9",
              passed_runs: "4",
              failed_runs: "5",
              last_status: "failed",
              last_run_at: new Date("2026-10-27T12:10:00Z"),
              last_error: "Status assertion failed: expected 200, actual 401",
            }],
          } as any;
        }

        return { rowCount: 0, rows: [] } as any;
      });

      const flakyList = await detectFlakyTests(projectId);
      expect(flakyList).toHaveLength(3);

      // Flakiness score: 2 * min(5, 5) / 10 = 1.0 (50/50 flaky)
      expect(flakyList[0].id).toBe("tc-flaky-1");
      expect(flakyList[0].flakiness_score).toBe(1.0);
      expect(flakyList[0].module).toBe("checkout");

      // Flakiness score: 2 * min(8, 2) / 10 = 0.4
      expect(flakyList.find((item) => item.id === "tc-flaky-2")?.flakiness_score).toBe(0.4);
      expect(flakyList.find((item) => item.id === "api-inventory")).toMatchObject({
        id: "api-inventory",
        type: "api",
        flakiness_score: 0.89,
        last_error: "Status assertion failed: expected 200, actual 401",
      });
    });
  });

  describe("recommendTestsForChanges", () => {
    it("recommends test cases and endpoints matching keywords from changed files", async () => {
      const projectId = "p-1";
      const changedFiles = [
        "src/features/auth/LoginForm.tsx",
        "backend/routes/inventory.ts",
      ];

      vi.mocked(pool.query).mockImplementation(async (sql: string) => {
        if (sql.includes("FROM test_cases")) {
          return {
            rowCount: 3,
            rows: [
              {
                id: "tc-1",
                title: "User login with valid email and password",
                description: "Verifies login auth flow",
                steps: ["goto /login", "fill email", "click submit"],
                module: "auth",
                priority: "critical",
              },
              {
                id: "tc-2",
                title: "View inventory items and stock count",
                description: "Verifies inventory table",
                steps: ["goto /inventory"],
                module: "inventory",
                priority: "high",
              },
              {
                id: "tc-3",
                title: "User settings profile picture upload",
                description: "Change avatar in settings",
                steps: ["goto /settings"],
                module: "settings",
                priority: "low",
              },
            ],
          } as any;
        }

        if (sql.includes("FROM api_endpoints")) {
          return {
            rowCount: 2,
            rows: [
              {
                id: "ep-1",
                name: "POST /auth/login",
                method: "POST",
                path: "/api/auth/login",
              },
              {
                id: "ep-2",
                name: "GET /inventory/items",
                method: "GET",
                path: "/api/inventory",
              },
            ],
          } as any;
        }

        return { rowCount: 0, rows: [] } as any;
      });

      const recommendation = await recommendTestsForChanges(projectId, changedFiles);

      expect(recommendation.changed_files).toEqual(changedFiles);
      expect(recommendation.matched_keywords).toEqual(
        expect.arrayContaining(["auth", "loginform", "inventory"]),
      );

      // tc-1 (auth/login) and tc-2 (inventory) should be recommended; tc-3 (settings) should not
      expect(recommendation.recommended_test_cases).toHaveLength(2);
      expect(recommendation.recommended_test_cases.map((t) => t.id)).toEqual(
        expect.arrayContaining(["tc-1", "tc-2"]),
      );

      // Both API endpoints matched keywords
      expect(recommendation.recommended_api_endpoints).toHaveLength(2);
      expect(recommendation.recommended_api_endpoints.map((e) => e.id)).toEqual(
        expect.arrayContaining(["ep-1", "ep-2"]),
      );
    });

    it("returns empty recommendations when no meaningful keywords exist", async () => {
      const result = await recommendTestsForChanges("p-1", ["src/index.ts", "lib/utils.js"]);
      expect(result.recommended_test_cases).toEqual([]);
      expect(result.recommended_api_endpoints).toEqual([]);
    });
  });
});
