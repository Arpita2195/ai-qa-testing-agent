import { pool } from "../config/db";
import type {
  ChangeType,
  FlakyTestReportItem,
  RunComparisonResult,
  RunComparisonSummary,
  TestComparisonItem,
  TestRecommendationResult,
} from "../types/regression";

interface DbRunRow {
  id: string;
  project_id: string;
  status: string;
  commit_sha: string | null;
  build_id: string | null;
  branch: string | null;
  environment: string;
  started_at: Date;
  finished_at: Date | null;
}

interface DbWebResultRow {
  test_case_id: string;
  title: string;
  status: string;
  duration_ms: number;
  error_message: string | null;
  screenshot_path: string | null;
  trace_path: string | null;
}

interface DbApiResultRow {
  endpoint_id: string;
  name: string;
  status: string;
  response_ms: number | null;
  error_message: string | null;
}

export async function compareRuns(
  baseRunId: string,
  targetRunId: string,
): Promise<RunComparisonResult> {
  const runsQuery = await pool.query<DbRunRow>(
    "SELECT * FROM test_runs WHERE id IN ($1, $2)",
    [baseRunId, targetRunId],
  );

  const baseRun = runsQuery.rows.find((r) => r.id === baseRunId);
  const targetRun = runsQuery.rows.find((r) => r.id === targetRunId);

  if (!baseRun) {
    throw new Error(`Base run ${baseRunId} not found`);
  }
  if (!targetRun) {
    throw new Error(`Target run ${targetRunId} not found`);
  }

  // Fetch Web results for both runs
  const webResultsQuery = await pool.query<DbWebResultRow & { run_id: string }>(
    `SELECT tr.run_id, tr.test_case_id, tc.title, tr.status, tr.duration_ms,
            tr.error_message, tr.screenshot_path, tr.trace_path
     FROM test_results tr
     JOIN test_cases tc ON tc.id = tr.test_case_id
     WHERE tr.run_id IN ($1, $2)`,
    [baseRunId, targetRunId],
  );

  // Fetch API results for both runs
  const apiResultsQuery = await pool.query<DbApiResultRow & { run_id: string }>(
    `SELECT ar.run_id, ar.endpoint_id, ae.name, ar.status, ar.response_ms, ar.error_message
     FROM api_test_results ar
     JOIN api_endpoints ae ON ae.id = ar.endpoint_id
     WHERE ar.run_id IN ($1, $2)`,
    [baseRunId, targetRunId],
  );

  const baseWebMap = new Map<string, DbWebResultRow>();
  const targetWebMap = new Map<string, DbWebResultRow>();
  for (const row of webResultsQuery.rows) {
    if (row.run_id === baseRunId) baseWebMap.set(row.test_case_id, row);
    if (row.run_id === targetRunId) targetWebMap.set(row.test_case_id, row);
  }

  const baseApiMap = new Map<string, DbApiResultRow>();
  const targetApiMap = new Map<string, DbApiResultRow>();
  for (const row of apiResultsQuery.rows) {
    if (row.run_id === baseRunId) baseApiMap.set(row.endpoint_id, row);
    if (row.run_id === targetRunId) targetApiMap.set(row.endpoint_id, row);
  }

  const items: TestComparisonItem[] = [];

  // Compare Web Results
  const allWebIds = new Set([...baseWebMap.keys(), ...targetWebMap.keys()]);
  for (const id of allWebIds) {
    const base = baseWebMap.get(id);
    const target = targetWebMap.get(id);
    const title = target?.title ?? base?.title ?? "Untitled web test";

    const changeType = determineChangeType(base?.status, target?.status);
    const durationDelta =
      target?.duration_ms != null && base?.duration_ms != null
        ? target.duration_ms - base.duration_ms
        : null;

    items.push({
      id,
      type: "web",
      title,
      base_status: base?.status ?? null,
      target_status: target?.status ?? null,
      change_type: changeType,
      duration_ms: target?.duration_ms ?? base?.duration_ms,
      duration_delta_ms: durationDelta,
      error_message: target?.error_message ?? (changeType === "recurring_failure" ? base?.error_message : null),
      screenshot_path: target?.screenshot_path ?? base?.screenshot_path,
      trace_path: target?.trace_path ?? base?.trace_path,
    });
  }

  // Compare API Results
  const allApiIds = new Set([...baseApiMap.keys(), ...targetApiMap.keys()]);
  for (const id of allApiIds) {
    const base = baseApiMap.get(id);
    const target = targetApiMap.get(id);
    const title = target?.name ?? base?.name ?? "Untitled API endpoint";

    const changeType = determineChangeType(base?.status, target?.status);
    const durationDelta =
      target?.response_ms != null && base?.response_ms != null
        ? target.response_ms - base.response_ms
        : null;

    items.push({
      id,
      type: "api",
      title,
      base_status: base?.status ?? null,
      target_status: target?.status ?? null,
      change_type: changeType,
      duration_ms: target?.response_ms ?? base?.response_ms,
      duration_delta_ms: durationDelta,
      error_message: target?.error_message ?? (changeType === "recurring_failure" ? base?.error_message : null),
    });
  }

  // Calculate summary counts
  const newFailuresCount = items.filter((i) => i.change_type === "new_failure").length;
  const recurringFailuresCount = items.filter((i) => i.change_type === "recurring_failure").length;
  const fixedCount = items.filter((i) => i.change_type === "fixed").length;
  const stablePassesCount = items.filter((i) => i.change_type === "stable_pass").length;
  const addedCount = items.filter((i) => i.change_type === "added").length;
  const removedCount = items.filter((i) => i.change_type === "removed").length;

  const targetTests = items.filter((i) => i.target_status !== null);
  const passedCount = targetTests.filter((i) => i.target_status === "passed").length;
  const failedCount = targetTests.filter((i) => i.target_status === "failed").length;

  const baseDuration = computeTotalDuration(baseWebMap, baseApiMap);
  const targetDuration = computeTotalDuration(targetWebMap, targetApiMap);

  const summary: RunComparisonSummary = {
    base_run_id: baseRun.id,
    target_run_id: targetRun.id,
    base_commit_sha: baseRun.commit_sha,
    target_commit_sha: targetRun.commit_sha,
    base_branch: baseRun.branch,
    target_branch: targetRun.branch,
    environment: targetRun.environment,
    total_tests: targetTests.length,
    passed_count: passedCount,
    failed_count: failedCount,
    new_failures_count: newFailuresCount,
    recurring_failures_count: recurringFailuresCount,
    fixed_tests_count: fixedCount,
    stable_passes_count: stablePassesCount,
    added_tests_count: addedCount,
    removed_tests_count: removedCount,
    duration_delta_ms: targetDuration - baseDuration,
    regression_detected: newFailuresCount > 0,
  };

  return { summary, items };
}

function determineChangeType(
  baseStatus: string | undefined,
  targetStatus: string | undefined,
): ChangeType {
  if (!baseStatus && targetStatus) {
    return targetStatus === "failed" ? "new_failure" : "added";
  }
  if (baseStatus && !targetStatus) {
    return "removed";
  }
  if (baseStatus === "passed" && targetStatus === "failed") {
    return "new_failure";
  }
  if (baseStatus === "failed" && targetStatus === "failed") {
    return "recurring_failure";
  }
  if (baseStatus === "failed" && targetStatus === "passed") {
    return "fixed";
  }
  if (baseStatus === "passed" && targetStatus === "passed") {
    return "stable_pass";
  }
  if (targetStatus === "failed") {
    return "new_failure";
  }
  return "stable_pass";
}

function computeTotalDuration(
  webMap: Map<string, DbWebResultRow>,
  apiMap: Map<string, DbApiResultRow>,
): number {
  let total = 0;
  for (const w of webMap.values()) total += w.duration_ms ?? 0;
  for (const a of apiMap.values()) total += a.response_ms ?? 0;
  return total;
}

export async function detectFlakyTests(
  projectId: string,
  runLimit = 30,
): Promise<FlakyTestReportItem[]> {
  // Web test aggregation
  const webFlakyQuery = await pool.query<{
    test_case_id: string;
    title: string;
    module: string;
    total_runs: string;
    passed_runs: string;
    failed_runs: string;
    last_status: string;
    last_run_at: Date;
    last_error: string | null;
  }>(
    `WITH recent_runs AS (
       SELECT id, created_at FROM test_runs
       WHERE project_id = $1
       ORDER BY created_at DESC
       LIMIT $2
     ),
     aggregated AS (
       SELECT
         tr.test_case_id,
         tc.title,
         tc.module,
         COUNT(tr.id) as total_runs,
         COUNT(tr.id) FILTER (WHERE tr.status = 'passed') as passed_runs,
         COUNT(tr.id) FILTER (WHERE tr.status = 'failed') as failed_runs,
         (ARRAY_AGG(tr.status ORDER BY tr.created_at DESC))[1] as last_status,
         (ARRAY_AGG(tr.created_at ORDER BY tr.created_at DESC))[1] as last_run_at,
         (ARRAY_AGG(tr.error_message ORDER BY tr.created_at DESC) FILTER (WHERE tr.error_message IS NOT NULL))[1] as last_error
       FROM test_results tr
       JOIN test_cases tc ON tc.id = tr.test_case_id
       JOIN recent_runs rr ON rr.id = tr.run_id
       GROUP BY tr.test_case_id, tc.title, tc.module
       HAVING COUNT(tr.id) >= 2
     )
     SELECT * FROM aggregated
     WHERE passed_runs > 0 AND failed_runs > 0
     ORDER BY (LEAST(passed_runs, failed_runs)::float / total_runs::float) DESC`,
    [projectId, runLimit],
  );

  // API test aggregation
  const apiFlakyQuery = await pool.query<{
    endpoint_id: string;
    name: string;
    total_runs: string;
    passed_runs: string;
    failed_runs: string;
    last_status: string;
    last_run_at: Date;
    last_error: string | null;
  }>(
    `WITH recent_runs AS (
       SELECT id, created_at FROM test_runs
       WHERE project_id = $1
       ORDER BY created_at DESC
       LIMIT $2
     ),
     aggregated AS (
       SELECT
         ar.endpoint_id,
         ae.name,
         COUNT(ar.id) as total_runs,
         COUNT(ar.id) FILTER (WHERE ar.status = 'passed') as passed_runs,
         COUNT(ar.id) FILTER (WHERE ar.status = 'failed') as failed_runs,
         (ARRAY_AGG(ar.status ORDER BY ar.created_at DESC))[1] as last_status,
         (ARRAY_AGG(ar.created_at ORDER BY ar.created_at DESC))[1] as last_run_at,
         (ARRAY_AGG(ar.error_message ORDER BY ar.created_at DESC) FILTER (WHERE ar.error_message IS NOT NULL))[1] as last_error
       FROM api_test_results ar
       JOIN api_endpoints ae ON ae.id = ar.endpoint_id
       JOIN recent_runs rr ON rr.id = ar.run_id
       GROUP BY ar.endpoint_id, ae.name
       HAVING COUNT(ar.id) >= 2
     )
     SELECT * FROM aggregated
     WHERE passed_runs > 0 AND failed_runs > 0
     ORDER BY (LEAST(passed_runs, failed_runs)::float / total_runs::float) DESC`,
    [projectId, runLimit],
  );

  const results: FlakyTestReportItem[] = [];

  for (const row of webFlakyQuery.rows) {
    const total = parseInt(row.total_runs, 10);
    const passed = parseInt(row.passed_runs, 10);
    const failed = parseInt(row.failed_runs, 10);
    const flakiness = Number(((2 * Math.min(passed, failed)) / total).toFixed(2));

    results.push({
      id: row.test_case_id,
      type: "web",
      title: row.title,
      module: row.module,
      total_runs: total,
      passed_runs: passed,
      failed_runs: failed,
      flakiness_score: flakiness,
      last_status: row.last_status,
      last_run_at: new Date(row.last_run_at).toISOString(),
      last_error: row.last_error,
    });
  }

  for (const row of apiFlakyQuery.rows) {
    const total = parseInt(row.total_runs, 10);
    const passed = parseInt(row.passed_runs, 10);
    const failed = parseInt(row.failed_runs, 10);
    const flakiness = Number(((2 * Math.min(passed, failed)) / total).toFixed(2));

    results.push({
      id: row.endpoint_id,
      type: "api",
      title: row.name,
      module: "api",
      total_runs: total,
      passed_runs: passed,
      failed_runs: failed,
      flakiness_score: flakiness,
      last_status: row.last_status,
      last_run_at: new Date(row.last_run_at).toISOString(),
      last_error: row.last_error,
    });
  }

  return results.sort((a, b) => b.flakiness_score - a.flakiness_score);
}

export async function recommendTestsForChanges(
  projectId: string,
  changedFiles: string[],
): Promise<TestRecommendationResult> {
  const stopWords = new Set([
    "src", "app", "lib", "test", "tests", "spec", "specs", "component", "components",
    "route", "routes", "controller", "controllers", "service", "services", "utils",
    "util", "index", "ts", "tsx", "js", "jsx", "json", "css", "html",
  ]);

  const extractedKeywords = new Set<string>();

  for (const file of changedFiles) {
    const parts = file
      .replace(/\\/g, "/")
      .split("/")
      .flatMap((part) => part.split(/[^a-zA-Z0-9]+/))
      .map((token) => token.toLowerCase())
      .filter((token) => token.length >= 3 && !stopWords.has(token));

    for (const token of parts) {
      extractedKeywords.add(token);
    }
  }

  const keywordList = Array.from(extractedKeywords);

  if (keywordList.length === 0) {
    return {
      changed_files: changedFiles,
      matched_keywords: [],
      recommended_test_cases: [],
      recommended_api_endpoints: [],
    };
  }

  // Fetch approved test cases for project
  const testCasesQuery = await pool.query<{
    id: string;
    title: string;
    description: string | null;
    steps: unknown;
    module: string;
    priority: string;
  }>(
    `SELECT id, title, description, steps, module, priority
     FROM test_cases
     WHERE project_id = $1 AND review_status = 'approved'`,
    [projectId],
  );

  // Fetch approved API endpoints for project
  const endpointsQuery = await pool.query<{
    id: string;
    name: string;
    method: string;
    path: string;
  }>(
    `SELECT id, name, method, path
     FROM api_endpoints
     WHERE project_id = $1 AND review_status = 'approved'`,
    [projectId],
  );

  const matchedTestCases: TestRecommendationResult["recommended_test_cases"] = [];
  for (const tc of testCasesQuery.rows) {
    const content = `${tc.title} ${tc.description ?? ""} ${tc.module} ${JSON.stringify(tc.steps)}`.toLowerCase();
    const matchedReasons: string[] = [];
    for (const kw of keywordList) {
      if (content.includes(kw)) {
        matchedReasons.push(`Matches keyword "${kw}" in ${tc.module}`);
      }
    }
    if (matchedReasons.length > 0) {
      matchedTestCases.push({
        id: tc.id,
        title: tc.title,
        module: tc.module,
        priority: tc.priority,
        matched_reasons: matchedReasons,
      });
    }
  }

  const matchedEndpoints: TestRecommendationResult["recommended_api_endpoints"] = [];
  for (const ep of endpointsQuery.rows) {
    const content = `${ep.name} ${ep.path}`.toLowerCase();
    const matchedReasons: string[] = [];
    for (const kw of keywordList) {
      if (content.includes(kw)) {
        matchedReasons.push(`Matches keyword "${kw}" in endpoint path/name`);
      }
    }
    if (matchedReasons.length > 0) {
      matchedEndpoints.push({
        id: ep.id,
        name: ep.name,
        method: ep.method,
        path: ep.path,
        matched_reasons: matchedReasons,
      });
    }
  }

  return {
    changed_files: changedFiles,
    matched_keywords: keywordList,
    recommended_test_cases: matchedTestCases.sort(
      (a, b) => b.matched_reasons.length - a.matched_reasons.length,
    ),
    recommended_api_endpoints: matchedEndpoints.sort(
      (a, b) => b.matched_reasons.length - a.matched_reasons.length,
    ),
  };
}
