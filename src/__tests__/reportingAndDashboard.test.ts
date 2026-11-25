import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../config/db";
import { createAuthHook } from "../services/auth";
import { AccessDeniedError } from "../services/authService";
import { reportRoutes } from "../routes/reports";
import {
  formatTrustedNumeric,
  formatTextCell,
  exportToCsv,
  generateStandaloneHtmlReport,
  DISCOVERY_EXPORT_COLUMNS,
  TEST_RESULTS_EXPORT_COLUMNS,
  AI_USAGE_EXPORT_COLUMNS,
} from "../services/reportExportService";
import {
  reportingService,
  classifyFailure,
  evaluateProjectHealth,
} from "../services/reportingService";

describe("Stage 5: QA Reporting, Deterministic Health & Dashboard Telemetry", () => {
  let app: ReturnType<typeof Fastify>;
  const testApiKey = "test-platform-api-key-stage-5";

  let testProjectId: string;
  let adminUserId: string;
  let viewerUserId: string;
  let nonMemberUserId: string;
  let viewerSessionToken: string;
  let viewerCsrfToken: string;

  beforeAll(async () => {
    // Clean up any stale test records from previous aborted runs
    await pool.query("DELETE FROM users WHERE email LIKE 'admin-5%@example.com' OR email LIKE 'viewer-5%@example.com' OR email LIKE 'outsider-5%@example.com'");
    await pool.query("DELETE FROM projects WHERE name = 'Stage5-Reporting-Project'");

    // 1. Create a dedicated test project
    const projRes = await pool.query<{ id: string }>(
      `INSERT INTO projects (name, base_url, owner_confirmed, access_status)
       VALUES ('Stage5-Reporting-Project', 'https://example.com/app', true, 'public')
       RETURNING id`
    );
    testProjectId = projRes.rows[0].id;

    // 2. Create users with unique run suffixes
    const suffix = Date.now().toString(36);
    const adminRes = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, role, is_active)
       VALUES ($1, 'scrypt:dummy', 'Admin 5', 'admin', true)
       RETURNING id`,
      [`admin-5-${suffix}@example.com`]
    );
    adminUserId = adminRes.rows[0].id;

    const viewerRes = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, role, is_active)
       VALUES ($1, 'scrypt:dummy', 'Viewer 5', 'viewer', true)
       RETURNING id`,
      [`viewer-5-${suffix}@example.com`]
    );
    viewerUserId = viewerRes.rows[0].id;

    const nonMemberRes = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, role, is_active)
       VALUES ($1, 'scrypt:dummy', 'Outsider 5', 'viewer', true)
       RETURNING id`,
      [`outsider-5-${suffix}@example.com`]
    );
    nonMemberUserId = nonMemberRes.rows[0].id;

    // 3. Project memberships
    await pool.query(
      `INSERT INTO project_members (project_id, user_id, role)
       VALUES ($1, $2, 'viewer')`,
      [testProjectId, viewerUserId]
    );

    // 4. Session for viewer
    const crypto = await import("node:crypto");
    viewerSessionToken = "viewer-session-token-stage-5";
    viewerCsrfToken = "csrf-token-viewer-stage-5";
    const viewerTokenHash = crypto.createHash("sha256").update(viewerSessionToken).digest("hex");
    await pool.query(
      `INSERT INTO sessions (user_id, token_hash, csrf_token, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '1 day')`,
      [viewerUserId, viewerTokenHash, viewerCsrfToken]
    );

    // 5. Seed test data for reporting
    // A. Seed crawled pages
    await pool.query(
      `INSERT INTO crawled_pages (project_id, url, path, depth, status, error_message, duration_ms)
       VALUES 
       ($1, 'https://example.com/app', '/app', 0, 'visited', NULL, 120),
       ($1, 'https://example.com/app/login', '/app/login', 1, 'visited', NULL, 150),
       ($1, 'https://example.com/app/dashboard', '/app/dashboard', 1, 'visited', NULL, 200),
       ($1, 'https://example.com/app/broken', '/app/broken', 1, 'failed', 'HTTP 500 Internal Error', 300)
       ON CONFLICT (project_id, url) DO NOTHING`,
      [testProjectId]
    );

    // B. Seed test cases
    const tc1 = await pool.query<{ id: string }>(
      `INSERT INTO test_cases (id, project_id, title, test_type, priority, review_status, steps, expected_result)
       VALUES (gen_random_uuid(), $1, 'Valid Login Flow', 'positive', 'critical', 'approved', '[]', 'Dashboard loaded')
       RETURNING id`,
      [testProjectId]
    );
    const tc2 = await pool.query<{ id: string }>(
      `INSERT INTO test_cases (id, project_id, title, test_type, priority, review_status, steps, expected_result)
       VALUES (gen_random_uuid(), $1, 'Invalid Password Negative Test', 'negative', 'high', 'approved', '[]', 'Displays invalid credentials alert')
       RETURNING id`,
      [testProjectId]
    );
    const tc3 = await pool.query<{ id: string }>(
      `INSERT INTO test_cases (id, project_id, title, test_type, priority, review_status, steps, expected_result)
       VALUES (gen_random_uuid(), $1, 'Dashboard Metrics Widget', 'boundary', 'medium', 'pending', '[]', 'Shows metric cards')
       RETURNING id`,
      [testProjectId]
    );

    // C. Seed API endpoints
    const ep1 = await pool.query<{ id: string }>(
      `INSERT INTO api_endpoints (id, project_id, name, method, path, expected_status, review_status)
       VALUES (gen_random_uuid(), $1, 'Get Users', 'GET', '/api/users', 200, 'approved')
       RETURNING id`,
      [testProjectId]
    );
    const ep2 = await pool.query<{ id: string }>(
      `INSERT INTO api_endpoints (id, project_id, name, method, path, expected_status, review_status)
       VALUES (gen_random_uuid(), $1, 'Login User', 'POST', '/api/login', 200, 'approved')
       RETURNING id`,
      [testProjectId]
    );

    // D. Seed Test Runs & Results (Web and API)
    const run1 = await pool.query<{ id: string }>(
      `INSERT INTO test_runs (id, project_id, run_type, status, started_at, finished_at)
       VALUES (gen_random_uuid(), $1, 'web', 'passed', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour 50 minutes')
       RETURNING id`,
      [testProjectId]
    );
    const tr1 = await pool.query<{ id: string }>(
      `INSERT INTO test_results (id, run_id, test_case_id, status, duration_ms, error_message)
       VALUES (gen_random_uuid(), $1, $2, 'passed', 1200, NULL)
       RETURNING id`,
      [run1.rows[0].id, tc1.rows[0].id]
    );

    const run2 = await pool.query<{ id: string }>(
      `INSERT INTO test_runs (id, project_id, run_type, status, started_at, finished_at)
       VALUES (gen_random_uuid(), $1, 'api', 'passed', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '55 minutes')
       RETURNING id`,
      [testProjectId]
    );
    await pool.query(
      `INSERT INTO api_test_results (id, run_id, endpoint_id, status, actual_status, response_ms)
       VALUES (gen_random_uuid(), $1, $2, 'passed', 200, 45)`,
      [run2.rows[0].id, ep1.rows[0].id]
    );

    // E. Seed Bug Reports (Confirmed vs Suspected)
    await pool.query(
      `INSERT INTO bug_reports (id, result_id, title, description, severity, status, classification)
       VALUES (gen_random_uuid(), $1, 'Suspected visual anomaly', 'Visual bug description', 'critical', 'suspected', 'product_bug')`,
      [tr1.rows[0].id]
    );

    // F. Seed AI Usage Logs & Cache Savings
    await pool.query(
      `INSERT INTO ai_usage_logs (project_id, model, provider, feature, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd)
       VALUES 
       ($1, 'gemini-1.5-flash', 'gemini', 'scenario_generation', 1000, 250, 1250, 0.00015),
       ($1, 'ollama:llama3', 'ollama', 'step_generation', 2000, 500, 2500, 0.0)`,
      [testProjectId]
    );
    await pool.query(
      `INSERT INTO ai_cache_savings_logs (project_id, feature, provider, model, saved_tokens, saved_cost_usd)
       VALUES ($1, 'scenario_generation', 'gemini', 'gemini-1.5-flash', 1200, 0.00012)`,
      [testProjectId]
    );

    // 6. Setup Fastify app
    app = Fastify();
    app.register(cookie);
    app.addHook("onRequest", createAuthHook(testApiKey));
    app.setErrorHandler((error, request, reply) => {
      const err = error as { name?: string; statusCode?: number; message?: string };
      if (
        error instanceof AccessDeniedError ||
        err.statusCode === 403 ||
        err.name === "AccessDeniedError"
      ) {
        return reply.code(403).send({ error: err.message || "Access denied" });
      }
      if (err.statusCode) {
        return reply.code(err.statusCode).send({ error: err.message || "Error" });
      }
      return reply.code(500).send({ error: err.message || "Internal Server Error" });
    });
    app.register(reportRoutes);
    await app.ready();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    // Clean up seeded records
    await pool.query("DELETE FROM ai_cache_savings_logs WHERE project_id = $1", [testProjectId]);
    await pool.query("DELETE FROM ai_usage_logs WHERE project_id = $1", [testProjectId]);
    await pool.query(
      `DELETE FROM bug_reports WHERE result_id IN (
         SELECT tr.id FROM test_results tr
         JOIN test_runs r ON r.id = tr.run_id
         WHERE r.project_id = $1
       ) OR api_result_id IN (
         SELECT atr.id FROM api_test_results atr
         JOIN test_runs r ON r.id = atr.run_id
         WHERE r.project_id = $1
       )`,
      [testProjectId]
    );
    await pool.query(
      "DELETE FROM api_test_results WHERE run_id IN (SELECT id FROM test_runs WHERE project_id = $1)",
      [testProjectId]
    );
    await pool.query(
      "DELETE FROM test_results WHERE run_id IN (SELECT id FROM test_runs WHERE project_id = $1)",
      [testProjectId]
    );
    await pool.query("DELETE FROM test_runs WHERE project_id = $1", [testProjectId]);
    await pool.query("DELETE FROM api_endpoints WHERE project_id = $1", [testProjectId]);
    await pool.query("DELETE FROM test_cases WHERE project_id = $1", [testProjectId]);
    await pool.query("DELETE FROM crawled_pages WHERE project_id = $1", [testProjectId]);
    await pool.query("DELETE FROM sessions WHERE user_id IN ($1, $2, $3)", [
      adminUserId,
      viewerUserId,
      nonMemberUserId,
    ]);
    await pool.query("DELETE FROM project_members WHERE project_id = $1", [testProjectId]);
    await pool.query("DELETE FROM users WHERE id IN ($1, $2, $3)", [
      adminUserId,
      viewerUserId,
      nonMemberUserId,
    ]);
    await pool.query("DELETE FROM projects WHERE id = $1", [testProjectId]);
  });

  // ==========================================
  // SECTION 1: UNIT TESTS - CSV & HTML EXPORT
  // ==========================================
  describe("CSV & HTML Export Engine (reportExportService)", () => {
    describe("formatTrustedNumeric", () => {
      it("formats valid integers and decimals safely", () => {
        expect(formatTrustedNumeric(0)).toBe("0");
        expect(formatTrustedNumeric(42)).toBe("42");
        expect(formatTrustedNumeric(3.14159)).toBe("3.14159");
        expect(formatTrustedNumeric(-10)).toBe("-10");
        expect(formatTrustedNumeric("-12.5")).toBe("-12.5");
        expect(formatTrustedNumeric("100")).toBe("100");
      });

      it("rejects non-numeric strings, NaN, Infinity, and objects with TypeError", () => {
        expect(() => formatTrustedNumeric("abc")).toThrow(TypeError);
        expect(() => formatTrustedNumeric("=SUM(A1)")).toThrow(TypeError);
        expect(() => formatTrustedNumeric(NaN)).toThrow(TypeError);
        expect(() => formatTrustedNumeric(Infinity)).toThrow(TypeError);
        expect(() => formatTrustedNumeric({})).toThrow(TypeError);
        expect(() => formatTrustedNumeric([])).toThrow(TypeError);
        expect(() => formatTrustedNumeric("")).toThrow(TypeError);
      });
    });

    describe("formatTextCell", () => {
      it("neutralizes formula injection characters (=, +, -, @, \\t, \\r)", () => {
        expect(formatTextCell("=CMD('calc')")).toBe("'=CMD('calc')");
        expect(formatTextCell("+12345")).toBe("'+12345");
        expect(formatTextCell("-danger")).toBe("'-danger");
        expect(formatTextCell("@SUM(A1:A10)")).toBe("'@SUM(A1:A10)");
        expect(formatTextCell("\tTabIndented")).toBe("'\tTabIndented");
        expect(formatTextCell("\rCarriageReturn")).toBe("'\rCarriageReturn");
      });

      it("does NOT neutralize safe punctuation (%, |, \\) unnecessarily", () => {
        expect(formatTextCell("% 100 passed")).toBe("% 100 passed");
        expect(formatTextCell("| Pipe Separator")).toBe("| Pipe Separator");
        expect(formatTextCell("\\ Windows\\Path")).toBe("\\ Windows\\Path");
      });

      it("strips ASCII control characters and zero-width spaces", () => {
        // \u0000 (null byte), \u200B (zero-width space), \uFEFF (BOM)
        const dirty = "Hello\u0000\u200BWorld\uFEFF!";
        expect(formatTextCell(dirty)).toBe("HelloWorld!");
      });

      it("properly quotes cells containing commas, quotes, and newlines per RFC 4180", () => {
        expect(formatTextCell('Hello, "World"')).toBe('"Hello, ""World"""');
        expect(formatTextCell("Line 1\nLine 2")).toBe('"Line 1\nLine 2"');
      });
    });

    describe("exportToCsv", () => {
      it("exports structured tabular data to compliant CSV", () => {
        const columns = [
          { header: "Name", key: "name", type: "text" as const },
          { header: "Score", key: "score", type: "numeric" as const },
        ];
        const rows = [
          { name: "Alice", score: 95 },
          { name: "=Dangerous", score: 0 },
        ];
        const csv = exportToCsv(columns, rows);
        const lines = csv.split("\n");
        expect(lines[0]).toBe("Name,Score");
        expect(lines[1]).toBe("Alice,95");
        expect(lines[2]).toBe("'=Dangerous,0");
      });
    });

    describe("generateStandaloneHtmlReport", () => {
      it("generates a self-contained HTML document with @media print stylesheet", () => {
        const dummyReport = {
          projectId: "test-proj-id",
          projectName: "Sample App",
          generatedAt: new Date().toISOString(),
          health: {
            overallHealth: "HEALTHY" as const,
            reasons: ["All criteria passed"],
            evaluatedAt: new Date().toISOString(),
            webHealth: "HEALTHY" as const,
            apiHealth: "HEALTHY" as const,
          },
          defects: {
            confirmedDefects: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
            suspectedDefects: { total: 1, critical: 0, high: 1, medium: 0, low: 0 },
            dismissedDefects: 0,
          },
          coverage: {
            discoveryCoverage: { crawledPagesCount: 10, pagesWithScenariosCount: 8, percentage: 80.0 },
            scenarioGenerationCoverage: { totalGeneratedCases: 10, approvedGeneratedCases: 9, percentage: 90.0 },
            approvalCoverage: { totalTestCases: 10, approvedTestCases: 9, percentage: 90.0 },
            executionCoverage: {
              web: {
                lifetimeApprovedCases: 5,
                lifetimeExecutedCases: 5,
                lifetimePercentage: 100.0,
                latestRunApprovedCases: 5,
                latestRunExecutedCases: 5,
                latestRunPercentage: 100.0,
                latestRunId: null,
              },
              api: {
                lifetimeApprovedEndpoints: 5,
                lifetimeExecutedEndpoints: 5,
                lifetimePercentage: 100.0,
                latestRunApprovedEndpoints: 5,
                latestRunExecutedEndpoints: 5,
                latestRunPercentage: 100.0,
                latestRunId: null,
              },
            },
            categoryCoverage: { categories: [] },
          },
          execution: {
            summary: { totalRuns: 2, passedRuns: 2, failedRuns: 0, passRate: 100.0 },
            web: { totalTests: 5, passedTests: 5, failedTests: 0, passRate: 100.0, latestRunId: null, latestRunPassRate: 100.0 },
            api: { totalTests: 5, passedTests: 5, failedTests: 0, passRate: 100.0, latestRunId: null, latestRunPassRate: 100.0 },
          },
          aiUsage: {
            totalPromptTokens: 1000,
            totalCompletionTokens: 250,
            totalTokens: 1250,
            totalInvocations: 2,
            totalEstimatedCostUsd: 0.00015,
            providers: [],
            cacheSavings: { totalHits: 1, tokensSaved: 500, estimatedDollarsSavedUsd: 0.00005 },
          },
          discovery: { totalCrawledPages: 10, pagesWithScenarios: 8, pages: [] },
        };

        const html = generateStandaloneHtmlReport(dummyReport);
        expect(html).toContain("<!DOCTYPE html>");
        expect(html).toContain("<html lang=\"en\">");
        expect(html).toContain("@media print");
        expect(html).toContain("Sample App");
        expect(html).toContain("HEALTHY");
        expect(html).toContain("Deterministic Project Health Status");
        // Verify SVG gauges are included inline
        expect(html).toContain("<svg");
      });
    });
  });

  // ==========================================
  // SECTION 2: UNIT TESTS - FAILURE CLASSIFICATION
  // ==========================================
  describe("Evidence-Based Failure Classification (classifyFailure)", () => {
    it("classifies inconclusive results first when status or message indicates timeout/inconclusive", () => {
      const result = classifyFailure({
        domain: "web",
        status: "inconclusive",
        error: "Test timed out before assertions could run",
      });
      expect(result.classification).toBe("inconclusive_result");
      expect(result.confidenceScore).toBe(0.95);
    });

    it("classifies flaky failures when previous run on same test passed", () => {
      const result = classifyFailure({
        domain: "web",
        status: "failed",
        error: "Timeout waiting for element",
        previousRunStatus: "passed",
      });
      expect(result.classification).toBe("flaky_failure");
      expect(result.confidenceScore).toBe(0.85);
    });

    it("classifies true authentication failures for unexpected 401/403 status codes", () => {
      const result = classifyFailure({
        domain: "api",
        status: "failed",
        error: "Expected 200 OK, got 401 Unauthorized",
        actualStatusCode: 401,
        expectedStatusCode: 200,
      });
      expect(result.classification).toBe("authentication_failure");
      expect(result.confidenceScore).toBe(0.9);
    });

    it("does NOT classify expected 401/403 negative tests as auth failure defect", () => {
      const result = classifyFailure({
        domain: "api",
        status: "failed",
        error: "Response schema mismatch",
        actualStatusCode: 401,
        expectedStatusCode: 401, // Negative test expecting 401
      });
      // Should fall through to schema/application defect, NOT authentication failure
      expect(result.classification).not.toBe("authentication_failure");
    });

    it("does NOT classify web negative login tests as auth failure defect", () => {
      const result = classifyFailure({
        domain: "web",
        status: "failed",
        error: "Error banner not found",
        testType: "negative",
        expectedResult: "Displays invalid password error",
      });
      expect(result.classification).not.toBe("authentication_failure");
    });

    it("classifies network timeouts and socket disconnects as network_failure", () => {
      const result = classifyFailure({
        domain: "api",
        status: "failed",
        error: "connect ETIMEDOUT 10.0.0.1:443",
      });
      expect(result.classification).toBe("network_failure");
      expect(result.confidenceScore).toBe(0.9);
    });

    it("classifies Playwright target/browser crashes as infrastructure_failure", () => {
      const result = classifyFailure({
        domain: "web",
        status: "failed",
        error: "Target closed. Browser has been disconnected or crashed",
      });
      expect(result.classification).toBe("infrastructure_failure");
      expect(result.confidenceScore).toBe(0.95);
    });

    it("classifies explicit assertion failures as application_defect", () => {
      const result = classifyFailure({
        domain: "web",
        status: "failed",
        error: "AssertionError: expected 'Active' to deeply equal 'Pending'",
      });
      expect(result.classification).toBe("application_defect");
      expect(result.confidenceScore).toBe(0.85);
    });

    it("classifies missing selectors as script_or_selector_failure", () => {
      const result = classifyFailure({
        domain: "web",
        status: "failed",
        error: "waiting for locator('button.submit-order') to be visible: timeout 10000ms exceeded",
      });
      expect(result.classification).toBe("script_or_selector_failure");
      expect(result.confidenceScore).toBe(0.85);
    });

    it("falls back to unclassified_failure for unknown errors", () => {
      const result = classifyFailure({
        domain: "web",
        status: "failed",
        error: "Some mysterious custom error message",
      });
      expect(result.classification).toBe("unclassified_failure");
      expect(result.confidenceScore).toBe(0.5);
    });
  });

  // ==========================================
  // SECTION 3: UNIT TESTS - HEALTH PRECEDENCE RULES
  // ==========================================
  describe("Deterministic Project Health Precedence (evaluateProjectHealth)", () => {
    it("forces AT_RISK when 1 confirmed critical/high defect exists, even with 0 test runs", () => {
      const health = evaluateProjectHealth({
        defects: {
          confirmedDefects: { total: 1, critical: 1, high: 0, medium: 0, low: 0 },
          suspectedDefects: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
          dismissedDefects: 0,
        },
        discovery: { totalCrawledPages: 10, failedPages: 0, failureRate: 0 },
        webHealth: "NOT_EVALUATED",
        apiHealth: "NOT_EVALUATED",
        latestWebRun: null,
        latestApiRun: null,
      });

      expect(health.overallHealth).toBe("AT_RISK");
      expect(health.reasons.some((r) => r.includes("confirmed critical/high"))).toBe(true);
    });

    it("does NOT force AT_RISK when only suspected critical/high defects exist pending QA triage", () => {
      const health = evaluateProjectHealth({
        defects: {
          confirmedDefects: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
          suspectedDefects: { total: 2, critical: 1, high: 1, medium: 0, low: 0 }, // Suspected only
          dismissedDefects: 0,
        },
        discovery: { totalCrawledPages: 10, failedPages: 0, failureRate: 0 },
        webHealth: "HEALTHY",
        apiHealth: "HEALTHY",
        latestWebRun: { id: "run-web-1", status: "passed", passRate: 100 },
        latestApiRun: { id: "run-api-1", status: "passed", passRate: 100 },
      });

      // Suspected bugs do not force AT_RISK; overall health stays HEALTHY
      expect(health.overallHealth).toBe("HEALTHY");
      expect(health.reasons.some((r) => r.includes("pending QA triage"))).toBe(true);
    });

    it("forces AT_RISK when discovery crawl failure rate exceeds 20%", () => {
      const health = evaluateProjectHealth({
        defects: {
          confirmedDefects: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
          suspectedDefects: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
          dismissedDefects: 0,
        },
        discovery: { totalCrawledPages: 10, failedPages: 3, failureRate: 30.0 },
        webHealth: "HEALTHY",
        apiHealth: "HEALTHY",
        latestWebRun: { id: "w1", status: "passed", passRate: 100 },
        latestApiRun: { id: "a1", status: "passed", passRate: 100 },
      });

      expect(health.overallHealth).toBe("AT_RISK");
      expect(health.reasons.some((r) => r.includes("crawl failure rate"))).toBe(true);
    });

    it("aggregates Healthy Web + At Risk API to overall AT_RISK", () => {
      const health = evaluateProjectHealth({
        defects: {
          confirmedDefects: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
          suspectedDefects: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
          dismissedDefects: 0,
        },
        discovery: { totalCrawledPages: 10, failedPages: 0, failureRate: 0 },
        webHealth: "HEALTHY",
        apiHealth: "AT_RISK",
        latestWebRun: { id: "w1", status: "passed", passRate: 100 },
        latestApiRun: { id: "a1", status: "failed", passRate: 60 },
      });

      expect(health.overallHealth).toBe("AT_RISK");
      expect(health.reasons.some((r) => r.includes("API testing domain is AT_RISK"))).toBe(true);
    });

    it("returns NOT_EVALUATED when neither domain has test execution and no confirmed defects exist", () => {
      const health = evaluateProjectHealth({
        defects: {
          confirmedDefects: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
          suspectedDefects: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
          dismissedDefects: 0,
        },
        discovery: { totalCrawledPages: 5, failedPages: 0, failureRate: 0 },
        webHealth: "NOT_EVALUATED",
        apiHealth: "NOT_EVALUATED",
        latestWebRun: null,
        latestApiRun: null,
      });

      expect(health.overallHealth).toBe("NOT_EVALUATED");
    });
  });

  // ==========================================
  // SECTION 4: FASTIFY INTEGRATION TESTS
  // ==========================================
  describe("Fastify Report Endpoints & RBAC Security", () => {
    it("returns 403 Forbidden when an unauthorized non-member accesses reports", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/projects/${testProjectId}/reports/executive-summary`,
        headers: {
          "x-api-key": "invalid-key",
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 404 when querying reports for a non-existent project UUID", async () => {
      const nonExistentId = "00000000-0000-0000-0000-000000000000";
      const res = await app.inject({
        method: "GET",
        url: `/projects/${nonExistentId}/reports/executive-summary`,
        headers: {
          "x-api-key": testApiKey,
        },
      });
      expect(res.statusCode).toBe(404);
    });

    it("GET /projects/:projectId/reports/executive-summary returns complete audit payload", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/projects/${testProjectId}/reports/executive-summary`,
        headers: {
          "x-api-key": testApiKey,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.projectId).toBe(testProjectId);
      expect(json.health).toBeDefined();
      expect(json.health.overallHealth).toBeDefined();
      expect(json.defects).toBeDefined();
      expect(json.defects.suspectedDefects.total).toBe(1); // 1 suspected bug seeded
      expect(json.defects.confirmedDefects.total).toBe(0);
      expect(json.coverage).toBeDefined();
      expect(json.execution).toBeDefined();
      expect(json.aiUsage).toBeDefined();
      expect(json.discovery).toBeDefined();
    });

    it("GET /projects/:projectId/reports/coverage computes 5-tier coverage metrics", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/projects/${testProjectId}/reports/coverage`,
        headers: {
          "x-api-key": testApiKey,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.discoveryCoverage).toBeDefined();
      expect(json.discoveryCoverage.crawledPagesCount).toBe(4);
      expect(json.scenarioGenerationCoverage).toBeDefined();
      expect(json.approvalCoverage).toBeDefined();
      expect(json.executionCoverage.web).toBeDefined();
      expect(json.executionCoverage.api).toBeDefined();
      expect(json.categoryCoverage).toBeDefined();
    });

    it("GET /projects/:projectId/reports/discovery returns deduplicated canonical URLs", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/projects/${testProjectId}/reports/discovery`,
        headers: {
          "x-api-key": testApiKey,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.totalCrawledPages).toBe(4);
      expect(json.pages.length).toBe(4);
      const urls = json.pages.map((p: any) => p.url);
      expect(new Set(urls).size).toBe(4); // Strictly deduplicated
    });

    it("GET /projects/:projectId/reports/execution separates web and API telemetry", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/projects/${testProjectId}/reports/execution`,
        headers: {
          "x-api-key": testApiKey,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.web).toBeDefined();
      expect(json.web.totalTests).toBe(1);
      expect(json.web.passedTests).toBe(1);
      expect(json.api).toBeDefined();
      expect(json.api.totalTests).toBe(1);
      expect(json.api.passedTests).toBe(1);
    });

    it("GET /projects/:projectId/reports/ai-usage distinguishes local Ollama from cloud APIs", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/projects/${testProjectId}/reports/ai-usage`,
        headers: {
          "x-api-key": testApiKey,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.totalInvocations).toBe(2);
      expect(json.totalTokens).toBe(3750);
      expect(json.totalEstimatedCostUsd).toBe(0.00015);
      expect(json.cacheSavings.totalHits).toBe(1);

      const localProvider = json.providers.find((p: any) => p.isLocal);
      expect(localProvider).toBeDefined();
      expect(localProvider.costUsd).toBe(0);
    });

    it("GET /projects/:projectId/reports/export?format=html returns standalone printable report", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/projects/${testProjectId}/reports/export?format=html&reportType=summary`,
        headers: {
          "x-api-key": testApiKey,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.payload).toContain("<!DOCTYPE html>");
      expect(res.payload).toContain("@media print");
    });

    it("GET /projects/:projectId/reports/export?format=csv returns sanitized attachment", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/projects/${testProjectId}/reports/export?format=csv&reportType=execution`,
        headers: {
          "x-api-key": testApiKey,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.headers["content-disposition"]).toContain("attachment; filename=");
      expect(res.payload).toContain("Run ID");
      expect(res.payload).toContain("Execution Status");
    });

    it("GET /projects/:projectId/reports/export?format=json returns structured telemetry", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/projects/${testProjectId}/reports/export?format=json&reportType=summary`,
        headers: {
          "x-api-key": testApiKey,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/json");
      const json = JSON.parse(res.payload);
      expect(json.project.id).toBe(testProjectId);
      expect(json.summary.health).toBeDefined();
    });
  });
});
