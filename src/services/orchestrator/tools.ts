import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool } from "../../config/db";
import { runApiTest, type ApiEndpoint } from "../apiRunner";
import { analyzeFailure } from "../failureAnalyzer";
import { compareRuns, recommendTestsForChanges } from "../regressionService";
import {
  classifyRunStatus,
  redactSecrets,
  runTestCase,
  scrubEvidence,
  type WebResultStatus,
} from "../runner";
import { writeRunReport } from "../runReport";

export interface ToolContext {
  projectId: string;
  correlationId: string;
  commitSha?: string;
  branch?: string;
  environment?: string;
}

// -------------------------------------------------------------
// Approved Tool 1: recommend_tests
// -------------------------------------------------------------
export const recommendTestsInputSchema = z.object({
  changed_files: z.array(z.string().min(1)).min(1),
});

export const recommendTestsOutputSchema = z.object({
  matched_keywords: z.array(z.string()),
  recommended_test_case_ids: z.array(z.string()),
  recommended_endpoint_ids: z.array(z.string()),
  test_case_count: z.number(),
  endpoint_count: z.number(),
});

async function handleRecommendTests(
  params: z.infer<typeof recommendTestsInputSchema>,
  context: ToolContext,
) {
  const result = await recommendTestsForChanges(context.projectId, params.changed_files);
  return {
    matched_keywords: result.matched_keywords,
    recommended_test_case_ids: result.recommended_test_cases.map((t) => t.id),
    recommended_endpoint_ids: result.recommended_api_endpoints.map((e) => e.id),
    test_case_count: result.recommended_test_cases.length,
    endpoint_count: result.recommended_api_endpoints.length,
  };
}

// -------------------------------------------------------------
// Approved Tool 2: run_web_tests
// -------------------------------------------------------------
export const runWebTestsInputSchema = z.object({
  test_case_ids: z.array(z.string().uuid()).optional(),
  commit_sha: z.string().optional(),
  branch: z.string().optional(),
  environment: z.string().default("test"),
});

export const runWebTestsOutputSchema = z.object({
  run_id: z.string().uuid(),
  status: z.string(),
  total: z.number(),
  passed: z.number(),
  failed: z.number(),
  inconclusive: z.number(),
  failed_test_details: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      error: z.string().nullable(),
      steps: z.array(z.string()),
    }),
  ),
});

async function handleRunWebTests(
  params: z.infer<typeof runWebTestsInputSchema>,
  context: ToolContext,
) {
  const projectResult = await pool.query<{ id: string; name: string; base_url: string }>(
    "SELECT id, name, base_url FROM projects WHERE id = $1",
    [context.projectId],
  );
  const project = projectResult.rows[0];
  if (!project) throw new Error(`Project ${context.projectId} not found`);

  const runId = randomUUID();
  const commitSha = params.commit_sha ?? context.commitSha ?? null;
  const branch = params.branch ?? context.branch ?? null;
  const environment = params.environment ?? context.environment ?? "test";

  await pool.query(
    `INSERT INTO test_runs
       (id, project_id, status, started_at, run_type, commit_sha, branch, environment, trigger_source)
     VALUES ($1, $2, 'running', now(), 'web', $3, $4, $5, 'orchestrator')`,
    [runId, project.id, commitSha, branch, environment],
  );

  const testCasesQuery = params.test_case_ids && params.test_case_ids.length > 0
    ? await pool.query<{ id: string; title: string; steps: string[]; review_status: string }>(
        `SELECT id, title, steps, review_status FROM test_cases
         WHERE project_id = $1 AND id = ANY($2::uuid[])`,
        [project.id, params.test_case_ids],
      )
    : await pool.query<{ id: string; title: string; steps: string[]; review_status: string }>(
        `SELECT id, title, steps, review_status FROM test_cases
         WHERE project_id = $1 AND review_status = 'approved'
         ORDER BY created_at ASC`,
        [project.id],
      );

  const testCases = testCasesQuery.rows;
  const results: Array<{
    id: string;
    testCaseId: string;
    title: string;
    steps: string[];
    status: WebResultStatus;
    durationMs: number;
    error_message: string | null;
    screenshot_path: string | null;
    trace_path: string | null;
    evidence: any;
  }> = [];

  for (const tc of testCases) {
    const resultId = randomUUID();
    const execution = await runTestCase(
      project.base_url,
      tc.steps,
      { runId, resultId },
      { projectId: project.id },
    );

    const insertedResult = await pool.query<{ id: string }>(
      `INSERT INTO test_results
         (id, run_id, test_case_id, status, error_message, duration_ms, screenshot_path, trace_path, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        resultId,
        runId,
        tc.id,
        execution.status,
        execution.errorMessage ? redactSecrets(execution.errorMessage) : null,
        execution.durationMs,
        execution.screenshotPath,
        execution.tracePath ?? null,
        JSON.stringify(scrubEvidence(execution.evidence)),
      ],
    );

    results.push({
      id: insertedResult.rows[0].id,
      testCaseId: tc.id,
      title: redactSecrets(tc.title),
      steps: tc.steps.map((s) => redactSecrets(s)),
      status: execution.status,
      durationMs: execution.durationMs,
      error_message: execution.errorMessage ? redactSecrets(execution.errorMessage) : null,
      screenshot_path: execution.screenshotPath,
      trace_path: execution.tracePath ?? null,
      evidence: scrubEvidence(execution.evidence),
    });
  }

  const runStatus = classifyRunStatus(results.map((r) => r.status));
  await pool.query(
    "UPDATE test_runs SET status = $1, finished_at = now() WHERE id = $2",
    [runStatus, runId],
  );

  await writeRunReport({
    runId,
    projectName: project.name,
    baseUrl: project.base_url,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    tests: results.map((r) => ({
      id: r.id,
      title: r.title,
      steps: r.steps,
      status: r.status,
      duration_ms: r.durationMs,
      error_message: r.error_message,
      evidence: r.evidence,
    })),
  });

  const failedTests = results.filter((r) => r.status === "failed");
  const passedTests = results.filter((r) => r.status === "passed");
  const inconclusiveTests = results.filter((r) => r.status === "inconclusive");

  return {
    run_id: runId,
    status: runStatus,
    total: results.length,
    passed: passedTests.length,
    failed: failedTests.length,
    inconclusive: inconclusiveTests.length,
    failed_test_details: failedTests.map((f) => ({
      id: f.testCaseId,
      title: f.title,
      error: f.error_message,
      steps: f.steps,
    })),
  };
}

// -------------------------------------------------------------
// Approved Tool 3: run_api_tests
// -------------------------------------------------------------
export const runApiTestsInputSchema = z.object({
  endpoint_ids: z.array(z.string().uuid()).optional(),
});

export const runApiTestsOutputSchema = z.object({
  run_id: z.string().uuid(),
  status: z.string(),
  total: z.number(),
  passed: z.number(),
  failed: z.number(),
  inconclusive: z.number().default(0),
  skipped: z.number().default(0),
  failed_endpoints: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      error: z.string().nullable(),
      status: z.string().optional(),
    }),
  ),
});

async function handleRunApiTests(
  params: z.infer<typeof runApiTestsInputSchema>,
  context: ToolContext,
) {
  const projectResult = await pool.query<{ id: string; base_url: string }>(
    "SELECT id, base_url FROM projects WHERE id = $1",
    [context.projectId],
  );
  const project = projectResult.rows[0];
  if (!project) throw new Error(`Project ${context.projectId} not found`);

  const runId = randomUUID();
  await pool.query(
    `INSERT INTO test_runs
       (id, project_id, status, started_at, run_type, trigger_source)
     VALUES ($1, $2, 'running', now(), 'api', 'orchestrator')`,
    [runId, project.id],
  );

  const endpointsQuery = params.endpoint_ids && params.endpoint_ids.length > 0
    ? await pool.query<ApiEndpoint & { id: string; name: string }>(
        `SELECT id, name, method, path, headers, body, expected_status, expected_fields, max_response_ms
         FROM api_endpoints
         WHERE project_id = $1 AND id = ANY($2::uuid[])`,
        [project.id, params.endpoint_ids],
      )
    : await pool.query<ApiEndpoint & { id: string; name: string }>(
        `SELECT id, name, method, path, headers, body, expected_status, expected_fields, max_response_ms
         FROM api_endpoints
         WHERE project_id = $1 AND review_status = 'approved'`,
        [project.id],
      );

  const endpoints = endpointsQuery.rows;
  const results: Array<{ id: string; name: string; status: string; error_message: string | null }> = [];

  for (const ep of endpoints) {
    const execution = await runApiTest(project.base_url, ep);
    await pool.query(
      `INSERT INTO api_test_results
         (run_id, endpoint_id, status, actual_status, response_ms, error_message, response_snippet)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        runId,
        ep.id,
        execution.status,
        execution.actualStatus,
        execution.responseMs,
        execution.errorMessage,
        execution.responseSnippet,
      ],
    );
    results.push({
      id: ep.id,
      name: ep.name,
      status: execution.status,
      error_message: execution.errorMessage,
    });
  }

  const runStatus = classifyRunStatus(results.map((r) => r.status));
  await pool.query(
    "UPDATE test_runs SET status = $1, finished_at = now() WHERE id = $2",
    [runStatus, runId],
  );

  const failedEndpoints = results.filter((r) => r.status === "failed" || r.status === "inconclusive");
  return {
    run_id: runId,
    status: runStatus,
    total: results.length,
    passed: results.filter((r) => r.status === "passed").length,
    failed: results.filter((r) => r.status === "failed").length,
    inconclusive: results.filter((r) => r.status === "inconclusive").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed_endpoints: failedEndpoints.map((f) => ({
      id: f.id,
      name: f.name,
      error: f.error_message,
      status: f.status,
    })),
  };
}

// -------------------------------------------------------------
// Approved Tool 4: compare_regression
// -------------------------------------------------------------
export const compareRegressionInputSchema = z.object({
  base_run_id: z.string().uuid().optional(),
  target_run_id: z.string().uuid(),
});

export const compareRegressionOutputSchema = z.object({
  regression_detected: z.boolean(),
  new_failures_count: z.number(),
  recurring_failures_count: z.number(),
  fixed_count: z.number(),
  duration_delta_ms: z.number(),
  new_failure_titles: z.array(z.string()),
});

async function handleCompareRegression(
  params: z.infer<typeof compareRegressionInputSchema>,
  context: ToolContext,
) {
  let baseRunId = params.base_run_id;
  if (!baseRunId) {
    const prevQuery = await pool.query<{ id: string }>(
      `SELECT id FROM test_runs
       WHERE project_id = $1 AND id != $2 AND status IN ('passed', 'failed', 'inconclusive')
       ORDER BY created_at DESC LIMIT 1`,
      [context.projectId, params.target_run_id],
    );
    if (prevQuery.rows.length === 0) {
      return {
        regression_detected: false,
        new_failures_count: 0,
        recurring_failures_count: 0,
        fixed_count: 0,
        duration_delta_ms: 0,
        new_failure_titles: [],
      };
    }
    baseRunId = prevQuery.rows[0].id;
  }

  const comp = await compareRuns(baseRunId, params.target_run_id, context.projectId);
  const newFailures = comp.items.filter((i) => i.change_type === "new_failure");

  return {
    regression_detected: comp.summary.regression_detected,
    new_failures_count: comp.summary.new_failures_count,
    recurring_failures_count: comp.summary.recurring_failures_count,
    fixed_count: comp.summary.fixed_tests_count,
    duration_delta_ms: comp.summary.duration_delta_ms,
    new_failure_titles: newFailures.map((f) => f.title),
  };
}

// -------------------------------------------------------------
// Approved Tool 5: analyze_failure
// -------------------------------------------------------------
export const analyzeFailureInputSchema = z.object({
  test_case_id: z.string().uuid(),
  error_message: z.string().min(1),
  steps: z.array(z.string()),
  page_url: z.string().default(""),
});

export const analyzeFailureOutputSchema = z.object({
  bug_report_id: z.string().uuid().optional(),
  classification: z.string(),
  severity: z.string(),
  probable_cause: z.string(),
  reproduction_steps: z.array(z.string()),
});

async function handleAnalyzeFailure(
  params: z.infer<typeof analyzeFailureInputSchema>,
  context: ToolContext,
) {
  const tcQuery = await pool.query<{ title: string; expected_result: string | null }>(
    "SELECT title, expected_result FROM test_cases WHERE id = $1",
    [params.test_case_id],
  );
  const title = tcQuery.rows[0]?.title ?? "Unknown Test Failure";
  const expectedResult = tcQuery.rows[0]?.expected_result ?? null;

  const analysis = await analyzeFailure({
    title,
    steps: params.steps,
    expected_result: expectedResult,
    errorMessage: params.error_message,
    pageUrl: params.page_url,
  });

  // Find latest result for this test case to link bug report
  const resultQuery = await pool.query<{ id: string }>(
    `SELECT id FROM test_results
     WHERE test_case_id = $1 AND status = 'failed'
     ORDER BY created_at DESC LIMIT 1`,
    [params.test_case_id],
  );
  const resultId = resultQuery.rows[0]?.id;

  let bugReportId: string | undefined;
  if (resultId) {
    const insertBug = await pool.query<{ id: string }>(
      `INSERT INTO bug_reports
         (id, result_id, test_case_id, title, description, severity, classification, probable_cause, reproduction_steps, status)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, 'suspected')
       ON CONFLICT (result_id) DO UPDATE
         SET classification = EXCLUDED.classification,
             probable_cause = EXCLUDED.probable_cause,
             severity = EXCLUDED.severity
       RETURNING id`,
      [
        resultId,
        params.test_case_id,
        analysis.title,
        analysis.description,
        analysis.severity,
        analysis.classification,
        analysis.probable_cause,
        JSON.stringify(analysis.reproduction_steps),
      ],
    );
    bugReportId = insertBug.rows[0]?.id;
  }

  return {
    bug_report_id: bugReportId,
    classification: analysis.classification,
    severity: analysis.severity,
    probable_cause: analysis.probable_cause,
    reproduction_steps: analysis.reproduction_steps,
  };
}

// -------------------------------------------------------------
// Tool Registry with Whitelisted Tools
// -------------------------------------------------------------
export interface WhitelistedTool {
  name: string;
  description: string;
  inputSchema: z.ZodSchema<any>;
  outputSchema: z.ZodSchema<any>;
  execute: (params: any, context: ToolContext) => Promise<any>;
}

export const WHITELISTED_TOOLS: Record<string, WhitelistedTool> = {
  recommend_tests: {
    name: "recommend_tests",
    description: "Recommends approved test cases and API endpoints based on touched or changed files.",
    inputSchema: recommendTestsInputSchema,
    outputSchema: recommendTestsOutputSchema,
    execute: handleRecommendTests,
  },
  run_web_tests: {
    name: "run_web_tests",
    description: "Executes approved browser test cases using headless Chromium with deterministic assertions and evidence capture.",
    inputSchema: runWebTestsInputSchema,
    outputSchema: runWebTestsOutputSchema,
    execute: handleRunWebTests,
  },
  run_api_tests: {
    name: "run_api_tests",
    description: "Executes approved backend API endpoints, verifying status codes, response schemas, and latency thresholds.",
    inputSchema: runApiTestsInputSchema,
    outputSchema: runApiTestsOutputSchema,
    execute: handleRunApiTests,
  },
  compare_regression: {
    name: "compare_regression",
    description: "Compares a test run against previous build runs to detect newly introduced regressions and track fixes.",
    inputSchema: compareRegressionInputSchema,
    outputSchema: compareRegressionOutputSchema,
    execute: handleCompareRegression,
  },
  analyze_failure: {
    name: "analyze_failure",
    description: "Analyzes failure evidence with AI to diagnose probable causes and create categorized bug reports without modifying test results.",
    inputSchema: analyzeFailureInputSchema,
    outputSchema: analyzeFailureOutputSchema,
    execute: handleAnalyzeFailure,
  },
};
