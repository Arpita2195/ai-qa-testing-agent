import { pool } from "../config/db";
import { logger } from "./observability/logger";

// ============================================================================
// Types & Interfaces
// ============================================================================

export type ProjectHealthStatus = "HEALTHY" | "NEEDS_ATTENTION" | "AT_RISK" | "NOT_EVALUATED";

export type FailureClassification =
  | "inconclusive_result"
  | "flaky_failure"
  | "authentication_failure"
  | "network_failure"
  | "infrastructure_failure"
  | "application_defect"
  | "script_or_selector_failure"
  | "unclassified_failure";

export interface DefectSummary {
  confirmed: {
    critical_high: number;
    medium: number;
    low: number;
    total: number;
  };
  suspected: {
    critical_high: number;
    medium: number;
    low: number;
    total: number;
  };
  dismissed: number;
  confirmedDefects?: {
    critical?: number;
    high?: number;
    critical_high?: number;
    medium: number;
    low: number;
    total: number;
  };
  suspectedDefects?: {
    critical?: number;
    high?: number;
    critical_high?: number;
    medium: number;
    low: number;
    total: number;
  };
  dismissedDefects?: number;
}

export interface DomainHealth {
  status: ProjectHealthStatus;
  runId: string | null;
  runType: string | null;
  passRate: number | null;
  flakyRate: number | null;
  conclusiveCoverage: number | null;
  totalConclusiveResults: number;
  passedResults: number;
  failedResults: number;
  reasons: string[];
}

export interface DiscoveryMetrics {
  totalDiscovered?: number;
  visitedCount?: number;
  queuedCount?: number;
  failedCount?: number;
  skippedCount?: number;
  coveragePercent?: number;
  failureRatePercent?: number;
  failureRate?: number;
  healthStatus?: "HEALTHY" | "DEGRADED" | "AT_RISK" | "NOT_CRAWLED";
  totalCrawledPages?: number;
  failedPages?: number;
}

export interface ExecutiveSummaryReport {
  projectId: string;
  projectName: string;
  baseUrl: string;
  generatedAt: string;
  health: {
    overallStatus: ProjectHealthStatus;
    overallHealth?: ProjectHealthStatus;
    label: string;
    reasons: string[];
    webHealth: DomainHealth;
    apiHealth: DomainHealth;
    evaluatedAt?: string;
  };
  defects: DefectSummary;
  discovery: {
    visitedCount: number;
    queuedCount: number;
    failedCount: number;
    skippedCount: number;
    totalDiscovered: number;
    coveragePercent: number;
    totalCrawledPages?: number;
    pagesWithScenarios?: number;
  };
  coverage: {
    discoveryCoverage: any;
    scenarioCoverage: number;
    webApprovalCoverage: number;
    apiApprovalCoverage: number;
    combinedApprovalCoverage: number;
    lifetimeConclusiveExecutionCoverage: number;
    discoveryCoveragePercent?: number;
    [key: string]: any;
  };
  executionTotals: {
    totalTestCases: number;
    approvedTestCases: number;
    totalApiEndpoints: number;
    approvedApiEndpoints: number;
    totalRunsExecuted: number;
  };
  execution?: {
    summary: { totalRuns: number; passedRuns: number; failedRuns: number; passRate: number };
    web: { totalTests: number; passedTests: number; failedTests: number; passRate: number; latestRunId: string | null; latestRunPassRate: number | null };
    api: { totalTests: number; passedTests: number; failedTests: number; passRate: number; latestRunId: string | null; latestRunPassRate: number | null };
  };
  aiUsage: {
    totalCalls: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    totalEstimatedCostUsd: number;
    totalSavedTokens: number;
    totalSavedCostUsd: number;
  };
}

export interface DiscoveryReport {
  projectId: string;
  summary: {
    visitedCount: number;
    queuedCount: number;
    failedCount: number;
    skippedCount: number;
    totalDiscovered: number;
    coveragePercent: number;
    failureRatePercent: number;
    healthStatus: "HEALTHY" | "DEGRADED" | "AT_RISK" | "NOT_CRAWLED";
  };
  pages: Array<{
    url: string;
    path: string;
    depth: number;
    status: string;
    pageType: string;
    title: string | null;
    durationMs: number;
    errorMessage: string | null;
    createdAt: string;
  }>;
}

export interface CoverageReport {
  projectId: string;
  discoveryCoverage: {
    visitedPages: number;
    eligiblePages: number;
    coveragePercent: number;
    status: string;
    crawledPagesCount?: number;
    pagesWithScenariosCount?: number;
    percentage?: number;
  };
  scenarioGenerationCoverage: {
    generatedScenarios: number;
    plannedScenarios: number;
    coveragePercent: number;
    totalGeneratedCases?: number;
    approvedGeneratedCases?: number;
    percentage?: number;
  };
  approvalCoverage: {
    web: { approved: number; total: number; percent: number };
    api: { approved: number; total: number; percent: number };
    combined: { approved: number; total: number; percent: number };
    totalTestCases?: number;
    approvedTestCases?: number;
    percentage?: number;
  };
  executionCoverage: {
    web: {
      approvedEligible: number;
      uniqueConclusiveLifetime: number;
      lifetimeCoveragePercent: number;
      uniqueConclusiveLatestRun: number;
      latestRunCoveragePercent: number;
      lifetimeApprovedCases?: number;
      lifetimeExecutedCases?: number;
      lifetimePercentage?: number;
      latestRunApprovedCases?: number;
      latestRunExecutedCases?: number;
      latestRunPercentage?: number;
      latestRunId?: string | null;
    };
    api: {
      approvedEligible: number;
      uniqueConclusiveLifetime: number;
      lifetimeCoveragePercent: number;
      uniqueConclusiveLatestRun: number;
      latestRunCoveragePercent: number;
      lifetimeApprovedEndpoints?: number;
      lifetimeExecutedEndpoints?: number;
      lifetimePercentage?: number;
      latestRunApprovedEndpoints?: number;
      latestRunExecutedEndpoints?: number;
      latestRunPercentage?: number;
      latestRunId?: string | null;
    };
    combined: {
      approvedEligible: number;
      uniqueConclusiveLifetime: number;
      lifetimeCoveragePercent: number;
    };
  };
  categoryCoverage: Record<string, any>;
}

export interface ClassifiedFailure {
  id: string;
  runId: string;
  runType: "web" | "api";
  targetId: string;
  targetName: string;
  testName?: string;
  status: string;
  classification: FailureClassification;
  classificationLabel: string;
  confidenceScore?: number;
  errorMessage: string | null;
  durationMs: number | null;
  retryCount: number;
  isFlaky: boolean;
  actualStatus?: number | null;
  expectedStatus?: number | null;
  probableCauseSuggestion: string | null;
  aiSuggestedAction?: string | null;
  isAiSuggestion: boolean;
  bugReportStatus: "confirmed" | "suspected" | "none";
  resultId?: string;
  testCaseId?: string | null;
  apiEndpointId?: string | null;
  executionDomain?: "web" | "api";
  executedAt: string;
}

export interface ExecutionReport {
  projectId: string;
  latestWebRun: DomainHealth | null;
  latestApiRun: DomainHealth | null;
  lifetimeWebMetrics: {
    totalConclusive: number;
    passed: number;
    failed: number;
    passRate: number;
  };
  lifetimeApiMetrics: {
    totalConclusive: number;
    passed: number;
    failed: number;
    passRate: number;
  };
  recentRuns: Array<{
    id: string;
    runType: string;
    status: string;
    startedAt: string | null;
    finishedAt: string | null;
    concurrency: number;
    flakyCount: number;
    totalCount: number;
    createdAt: string;
  }>;
  web?: {
    totalTests: number;
    passedTests: number;
    failedTests: number;
    passRate: number;
    latestRunId: string | null;
    latestRunPassRate: number | null;
  };
  api?: {
    totalTests: number;
    passedTests: number;
    failedTests: number;
    passRate: number;
    latestRunId: string | null;
    latestRunPassRate: number | null;
  };
  summary?: {
    totalRuns: number;
    passedRuns: number;
    failedRuns: number;
    passRate: number;
  };
}

export interface AiUsageReport {
  projectId: string;
  totals: {
    totalCalls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    savedTokens: number;
    savedCostUsd: number;
  };
  byProvider: Array<{
    provider: string;
    calls: number;
    totalTokens: number;
    estimatedCostUsd: number;
    isZeroCostLocal: boolean;
  }>;
  byModel: Array<{
    model: string;
    calls: number;
    totalTokens: number;
    estimatedCostUsd: number;
  }>;
  byFeature: Array<{
    feature: string;
    calls: number;
    totalTokens: number;
    estimatedCostUsd: number;
  }>;
  recentLogs: Array<{
    id: string;
    feature: string;
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    durationMs: number | null;
    createdAt: string;
  }>;
  totalInvocations?: number;
  totalPromptTokens?: number;
  totalCompletionTokens?: number;
  totalTokens?: number;
  totalEstimatedCostUsd?: number;
  providers?: Array<any>;
  cacheSavings?: {
    totalHits: number;
    tokensSaved: number;
    estimatedDollarsSavedUsd: number;
  };
}

// ============================================================================
// Service Implementation
// ============================================================================

export function computeProjectHealth(params: {
  defects: DefectSummary | any;
  discovery: DiscoveryMetrics | any;
  webHealth: DomainHealth | ProjectHealthStatus;
  apiHealth: DomainHealth | ProjectHealthStatus;
  latestWebRun?: any;
  latestApiRun?: any;
}): {
  overallStatus: ProjectHealthStatus;
  overallHealth: ProjectHealthStatus;
  label: string;
  reasons: string[];
  webHealth: DomainHealth;
  apiHealth: DomainHealth;
} {
  const { defects, discovery } = params;
  const webHealth: DomainHealth =
    typeof params.webHealth === "string"
      ? {
          status: params.webHealth,
          runId: params.latestWebRun?.id || null,
          runType: "web",
          passRate: params.latestWebRun?.passRate ?? null,
          flakyRate: null,
          conclusiveCoverage: null,
          totalConclusiveResults: 0,
          passedResults: 0,
          failedResults: 0,
          reasons: params.webHealth === "AT_RISK" ? ["Web testing domain is AT_RISK"] : [],
        }
      : params.webHealth;

  const apiHealth: DomainHealth =
    typeof params.apiHealth === "string"
      ? {
          status: params.apiHealth,
          runId: params.latestApiRun?.id || null,
          runType: "api",
          passRate: params.latestApiRun?.passRate ?? null,
          flakyRate: null,
          conclusiveCoverage: null,
          totalConclusiveResults: 0,
          passedResults: 0,
          failedResults: 0,
          reasons: params.apiHealth === "AT_RISK" ? ["API testing domain is AT_RISK"] : [],
        }
      : params.apiHealth;

  const reasons: string[] = [];

  const confirmedCritHigh =
    defects?.confirmed?.critical_high ??
    ((defects?.confirmedDefects?.critical || 0) + (defects?.confirmedDefects?.high || 0));
  const confirmedMedium =
    defects?.confirmed?.medium ??
    (defects?.confirmedDefects?.medium || 0);
  const suspectedCritHigh =
    defects?.suspected?.critical_high ??
    ((defects?.suspectedDefects?.critical || 0) + (defects?.suspectedDefects?.high || 0));

  const discFailureRate =
    discovery?.failureRatePercent ??
    discovery?.failureRate ??
    0;
  const isCrawlAtRisk =
    discovery?.healthStatus === "AT_RISK" || discFailureRate >= 20;
  const isCrawlDegraded =
    discovery?.healthStatus === "DEGRADED" || discFailureRate >= 10;

  // Precedence 1: Confirmed Critical/High Defects
  if (confirmedCritHigh >= 1) {
    reasons.push(
      `Critical project risk: ${confirmedCritHigh} confirmed critical/high product defect(s) unresolved.`
    );
    return {
      overallStatus: "AT_RISK",
      overallHealth: "AT_RISK",
      label: "At Risk • Confirmed Critical Defect",
      reasons,
      webHealth,
      apiHealth,
    };
  }

  // Precedence 2: Severe Discovery Crash
  if (isCrawlAtRisk) {
    reasons.push(`Website discovery failed: ${discFailureRate}% crawl failure rate exceeded threshold.`);
    return {
      overallStatus: "AT_RISK",
      overallHealth: "AT_RISK",
      label: "At Risk • Severe Crawl Failure",
      reasons,
      webHealth,
      apiHealth,
    };
  }

  // Precedence 3: Both Domains Untested
  if (webHealth.status === "NOT_EVALUATED" && apiHealth.status === "NOT_EVALUATED") {
    if (confirmedMedium >= 3) {
      reasons.push(`Warning: ${confirmedMedium} confirmed medium product defect(s) unresolved.`);
      return {
        overallStatus: "NEEDS_ATTENTION",
        overallHealth: "NEEDS_ATTENTION",
        label: "Needs Attention • Confirmed Defects",
        reasons,
        webHealth,
        apiHealth,
      };
    }
    if (isCrawlDegraded) {
      reasons.push(`Website discovery degraded: ${discovery?.failedCount || 0} page(s) failed during exploration.`);
      return {
        overallStatus: "NEEDS_ATTENTION",
        overallHealth: "NEEDS_ATTENTION",
        label: "Needs Attention • Crawl Degraded",
        reasons,
        webHealth,
        apiHealth,
      };
    }
    reasons.push("No conclusive test execution telemetry exists for web or API testing.");
    if (suspectedCritHigh > 0) {
      reasons.push(
        `Notice: ${suspectedCritHigh} suspected critical/high defect(s) pending QA triage.`
      );
    }
    return {
      overallStatus: "NOT_EVALUATED",
      overallHealth: "NOT_EVALUATED",
      label: "Not Evaluated • Untested",
      reasons,
      webHealth,
      apiHealth,
    };
  }

  // Precedence 4: Domain Severity Dominance
  if (webHealth.status === "AT_RISK" || apiHealth.status === "AT_RISK") {
    if (webHealth.status === "AT_RISK") {
      reasons.push(...(webHealth.reasons.length > 0 ? webHealth.reasons : ["Web testing domain is AT_RISK"]));
    }
    if (apiHealth.status === "AT_RISK") {
      reasons.push(...(apiHealth.reasons.length > 0 ? apiHealth.reasons : ["API testing domain is AT_RISK"]));
    }
    return {
      overallStatus: "AT_RISK",
      overallHealth: "AT_RISK",
      label: "At Risk",
      reasons,
      webHealth,
      apiHealth,
    };
  }

  if (webHealth.status === "NEEDS_ATTENTION" || apiHealth.status === "NEEDS_ATTENTION") {
    reasons.push(...webHealth.reasons);
    reasons.push(...apiHealth.reasons);
    return {
      overallStatus: "NEEDS_ATTENTION",
      overallHealth: "NEEDS_ATTENTION",
      label: "Needs Attention",
      reasons,
      webHealth,
      apiHealth,
    };
  }

  if (confirmedMedium >= 3) {
    reasons.push(`Warning: ${confirmedMedium} confirmed medium product defect(s) unresolved.`);
    return {
      overallStatus: "NEEDS_ATTENTION",
      overallHealth: "NEEDS_ATTENTION",
      label: "Needs Attention • Confirmed Medium Defects",
      reasons,
      webHealth,
      apiHealth,
    };
  }

  if (isCrawlDegraded) {
    reasons.push(`Website discovery degraded: ${discovery?.failedCount || 0} page(s) failed during exploration.`);
    return {
      overallStatus: "NEEDS_ATTENTION",
      overallHealth: "NEEDS_ATTENTION",
      label: "Needs Attention • Crawl Degraded",
      reasons,
      webHealth,
      apiHealth,
    };
  }

  if (suspectedCritHigh > 0) {
    reasons.push(
      `Notice: ${suspectedCritHigh} suspected critical/high defect(s) pending QA triage.`
    );
  }

  // Both Healthy or One Healthy + One Untested
  if (webHealth.status === "HEALTHY" && apiHealth.status === "HEALTHY") {
    reasons.push("All quality bars met across Web and API testing.");
    return {
      overallStatus: "HEALTHY",
      overallHealth: "HEALTHY",
      label: "Healthy",
      reasons,
      webHealth,
      apiHealth,
    };
  }

  if (webHealth.status === "HEALTHY" && apiHealth.status === "NOT_EVALUATED") {
    reasons.push("Web testing quality bars met. API testing not evaluated.");
    return {
      overallStatus: "HEALTHY",
      overallHealth: "HEALTHY",
      label: "Healthy • API Untested",
      reasons,
      webHealth,
      apiHealth,
    };
  }

  if (webHealth.status === "NOT_EVALUATED" && apiHealth.status === "HEALTHY") {
    reasons.push("API testing quality bars met. Web testing not evaluated.");
    return {
      overallStatus: "HEALTHY",
      overallHealth: "HEALTHY",
      label: "Healthy • Web Untested",
      reasons,
      webHealth,
      apiHealth,
    };
  }

  return {
    overallStatus: "NOT_EVALUATED",
    overallHealth: "NOT_EVALUATED",
    label: "Not Evaluated",
    reasons,
    webHealth,
    apiHealth,
  };
}

export function classifyFailure(params: {
  status: string;
  errorMessage?: string | null;
  error?: string | null;
  flaky?: boolean;
  retryCount?: number;
  attempts?: any;
  previousRunStatus?: string;
  actualStatus?: number | null;
  actualStatusCode?: number | null;
  expectedStatus?: number | null;
  expectedStatusCode?: number | null;
  testType?: string | null;
  expectedResult?: string | null;
  scenarioCategory?: string | null;
  bugReportClassification?: string | null;
  bugReportStatus?: string | null;
  domain?: "web" | "api";
}): { classification: FailureClassification; label: string; confidenceScore: number } {
  const {
    status,
    errorMessage,
    error,
    flaky,
    previousRunStatus,
    retryCount = 0,
    attempts = [],
    actualStatus = params.actualStatusCode ?? null,
    expectedStatus = params.expectedStatusCode ?? null,
    testType,
    expectedResult = "",
    scenarioCategory,
    bugReportClassification,
    bugReportStatus,
  } = params;

  const rawError = errorMessage ?? error ?? "";
  const msg = rawError.toLowerCase();
  const exp = (expectedResult || "").toLowerCase();
  const isNegativeIntent =
    testType === "negative" ||
    scenarioCategory === "negative" ||
    /(invalid|negative|error message|unauthorized|access denied|should fail)/i.test(exp);

  // Step 1: Inconclusive check (FIRST)
  if (status === "inconclusive" || /(timed out before assertion|inconclusive)/i.test(msg)) {
    return { classification: "inconclusive_result", label: "Inconclusive Result", confidenceScore: 0.95 };
  }

  // Step 2: Flaky test check
  let hasAttemptTransition = false;
  if (Array.isArray(attempts) && attempts.length > 1) {
    const statuses = attempts.map((a: any) => a?.status);
    hasAttemptTransition = statuses.includes("passed") && statuses.includes("failed");
  }
  if (flaky === true || previousRunStatus === "passed" || hasAttemptTransition) {
    return { classification: "flaky_failure", label: "Flaky Test", confidenceScore: 0.85 };
  }

  // Step 3: Authentication failure check (evidence-based)
  // API: actual 401/403 when 401/403 was NOT expected
  if (
    (actualStatus === 401 || actualStatus === 403) &&
    expectedStatus !== 401 &&
    expectedStatus !== 403
  ) {
    return { classification: "authentication_failure", label: "Authentication Failure", confidenceScore: 0.9 };
  }
  // Web: 401/403/CSRF/token error on a positive/standard test (NOT intentional negative test)
  if (
    /(401 unauthorized|403 forbidden|csrf token|jwt expired|session expired|invalid token|authentication failed)/i.test(
      msg
    )
  ) {
    if (isNegativeIntent) {
      return { classification: "script_or_selector_failure", label: "Script / Assertion Failure", confidenceScore: 0.85 };
    }
    if (testType === "positive" || /(dashboard|logged in|welcome|success)/i.test(exp)) {
      return { classification: "authentication_failure", label: "Authentication Failure", confidenceScore: 0.9 };
    }
    return { classification: "unclassified_failure", label: "Unclassified Failure", confidenceScore: 0.5 };
  }

  // Step 4: Network failure check
  if (
    /(econnrefused|enotfound|etimedout|econnreset|net::err_|dns_probe_|fetch failed|socket hang up)/i.test(
      msg
    ) ||
    (actualStatus === 0 && msg.includes("network"))
  ) {
    return { classification: "network_failure", label: "Network Failure", confidenceScore: 0.9 };
  }

  // Step 5: Infrastructure failure check (includes browser disconnections and crashes)
  if (
    actualStatus === 502 ||
    actualStatus === 503 ||
    actualStatus === 504 ||
    /(502 bad gateway|503 service unavailable|504 gateway timeout|database connection|redis connection|out of memory|browser disconnected|target closed|target page, context or browser has been closed|crashed)/i.test(
      msg
    )
  ) {
    return { classification: "infrastructure_failure", label: "Infrastructure Failure", confidenceScore: 0.95 };
  }

  // Step 6: Application defect check (Requires verified evidence!)
  if (bugReportStatus === "confirmed" && bugReportClassification === "product_bug") {
    return { classification: "application_defect", label: "Application Defect (Confirmed)", confidenceScore: 0.95 };
  }
  if (/(assertionerror|expect\(received\)\.toequal|expected status to be|actual_status does not match|expected .* to deeply equal)/i.test(msg)) {
    return { classification: "application_defect", label: "Application Defect", confidenceScore: 0.85 };
  }

  // Step 7: Script or selector failure check
  if (
    /(waiting for locator|element not found|locator\.click|timeout \d+ms exceeded while waiting for locator|strict mode violation)/i.test(
      msg
    )
  ) {
    return { classification: "script_or_selector_failure", label: "Script / Selector Failure", confidenceScore: 0.85 };
  }

  // Step 8: Default fallback for missing or insufficient evidence
  return { classification: "unclassified_failure", label: "Unclassified Failure", confidenceScore: 0.5 };
}

export class ReportingService {
  /**
   * 1. Query Confirmed and Suspected Defect Counts for a Project
   */
  async getDefectSummary(projectId: string): Promise<DefectSummary> {
    const query = `
      SELECT
        -- Confirmed product defects
        COUNT(*) FILTER (WHERE br.status = 'confirmed' AND br.classification = 'product_bug' AND br.severity IN ('critical', 'high')) AS confirmed_crit_high,
        COUNT(*) FILTER (WHERE br.status = 'confirmed' AND br.classification = 'product_bug' AND br.severity = 'medium') AS confirmed_med,
        COUNT(*) FILTER (WHERE br.status = 'confirmed' AND br.classification = 'product_bug' AND br.severity = 'low') AS confirmed_low,
        COUNT(*) FILTER (WHERE br.status = 'confirmed' AND br.classification = 'product_bug') AS confirmed_total,
        -- Suspected defects (automated / AI triage pending)
        COUNT(*) FILTER (WHERE br.status = 'suspected' AND br.severity IN ('critical', 'high')) AS suspected_crit_high,
        COUNT(*) FILTER (WHERE br.status = 'suspected' AND br.severity = 'medium') AS suspected_med,
        COUNT(*) FILTER (WHERE br.status = 'suspected' AND br.severity = 'low') AS suspected_low,
        COUNT(*) FILTER (WHERE br.status = 'suspected') AS suspected_total,
        -- Dismissed
        COUNT(*) FILTER (WHERE br.status = 'dismissed') AS dismissed_total
      FROM bug_reports br
      LEFT JOIN test_results tr ON tr.id = br.result_id
      LEFT JOIN test_runs tr_runs ON tr_runs.id = tr.run_id
      LEFT JOIN api_test_results atr ON atr.id = br.api_result_id
      LEFT JOIN test_runs atr_runs ON atr_runs.id = atr.run_id
      WHERE (tr_runs.project_id = $1 OR atr_runs.project_id = $1);
    `;

    const res = await pool.query(query, [projectId]);
    const row = res.rows[0] || {};

    return {
      confirmed: {
        critical_high: parseInt(row.confirmed_crit_high || "0", 10),
        medium: parseInt(row.confirmed_med || "0", 10),
        low: parseInt(row.confirmed_low || "0", 10),
        total: parseInt(row.confirmed_total || "0", 10),
      },
      suspected: {
        critical_high: parseInt(row.suspected_crit_high || "0", 10),
        medium: parseInt(row.suspected_med || "0", 10),
        low: parseInt(row.suspected_low || "0", 10),
        total: parseInt(row.suspected_total || "0", 10),
      },
      dismissed: parseInt(row.dismissed_total || "0", 10),
    };
  }

  /**
   * 2. Query Deduplicated Discovery Telemetry (1 current state per canonical URL)
   */
  async getDiscoveryMetrics(projectId: string): Promise<{
    visitedCount: number;
    queuedCount: number;
    failedCount: number;
    skippedCount: number;
    totalDiscovered: number;
    coveragePercent: number;
    failureRatePercent: number;
    healthStatus: "HEALTHY" | "DEGRADED" | "AT_RISK" | "NOT_CRAWLED";
  }> {
    const query = `
      SELECT
        COUNT(*) FILTER (WHERE status = 'visited') AS visited_count,
        COUNT(*) FILTER (WHERE status = 'queued') AS queued_count,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
        COUNT(*) FILTER (WHERE status = 'skipped') AS skipped_count,
        COUNT(*) AS total_count
      FROM (
        SELECT DISTINCT ON (url) url, status
        FROM crawled_pages
        WHERE project_id = $1
        ORDER BY url, updated_at DESC
      ) canonical_pages;
    `;

    const res = await pool.query(query, [projectId]);
    const row = res.rows[0] || {};

    const visited = parseInt(row.visited_count || "0", 10);
    const queued = parseInt(row.queued_count || "0", 10);
    const failed = parseInt(row.failed_count || "0", 10);
    const skipped = parseInt(row.skipped_count || "0", 10);
    const total = parseInt(row.total_count || "0", 10);

    const crawlDenominator = visited + queued + failed;
    const coveragePercent =
      crawlDenominator > 0 ? Math.round((visited / crawlDenominator) * 1000) / 10 : 0;

    const attemptedPages = visited + failed;
    const failureRatePercent =
      attemptedPages > 0 ? Math.round((failed / attemptedPages) * 1000) / 10 : 0;

    let healthStatus: "HEALTHY" | "DEGRADED" | "AT_RISK" | "NOT_CRAWLED" = "NOT_CRAWLED";
    if (attemptedPages >= 5) {
      if (failureRatePercent >= 50) {
        healthStatus = "AT_RISK";
      } else if (failed >= 3 || failureRatePercent >= 20) {
        healthStatus = "DEGRADED";
      } else {
        healthStatus = "HEALTHY";
      }
    } else if (attemptedPages > 0) {
      healthStatus = "HEALTHY";
    }

    return {
      visitedCount: visited,
      queuedCount: queued,
      failedCount: failed,
      skippedCount: skipped,
      totalDiscovered: total,
      coveragePercent,
      failureRatePercent,
      healthStatus,
    };
  }

  /**
   * 3. Evaluate Sub-Health for Web or API Domain
   */
  async evaluateDomainHealth(
    projectId: string,
    domain: "web" | "api"
  ): Promise<DomainHealth> {
    const runTypes = domain === "web" ? "('web', 'suite')" : "('api', 'suite')";
    const resultTable = domain === "web" ? "test_results" : "api_test_results";
    const entityTable = domain === "web" ? "test_cases" : "api_endpoints";
    const entityFk = domain === "web" ? "test_case_id" : "endpoint_id";

    // 1. Find latest eligible completed run for this domain
    const latestRunQuery = `
      SELECT tr.id, tr.run_type, tr.status, tr.finished_at
      FROM test_runs tr
      WHERE tr.project_id = $1
        AND tr.run_type IN ${runTypes}
        AND tr.status IN ('passed', 'failed', 'inconclusive')
        AND tr.finished_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM ${resultTable} WHERE run_id = tr.id)
      ORDER BY tr.created_at DESC
      LIMIT 1;
    `;
    const runRes = await pool.query(latestRunQuery, [projectId]);
    const latestRun = runRes.rows[0];

    // Total approved entities eligible for execution
    const totalApprovedRes = await pool.query(
      `SELECT COUNT(*) AS count FROM ${entityTable} WHERE project_id = $1 AND review_status = 'approved'`,
      [projectId]
    );
    const approvedEntitiesCount = parseInt(totalApprovedRes.rows[0]?.count || "0", 10);

    if (!latestRun || approvedEntitiesCount === 0) {
      return {
        status: "NOT_EVALUATED",
        runId: latestRun ? latestRun.id : null,
        runType: latestRun ? latestRun.run_type : null,
        passRate: null,
        flakyRate: null,
        conclusiveCoverage: null,
        totalConclusiveResults: 0,
        passedResults: 0,
        failedResults: 0,
        reasons: [
          approvedEntitiesCount === 0
            ? `No approved ${domain === "web" ? "test cases" : "API endpoints"} exist for testing.`
            : `No completed ${domain} test runs exist.`,
        ],
      };
    }

    // 2. Query conclusive results and execution counts for this latest run
    const resultsQuery = `
      SELECT
        COUNT(*) FILTER (WHERE r.status = 'passed') AS passed_count,
        COUNT(*) FILTER (WHERE r.status = 'failed') AS failed_count,
        COUNT(*) FILTER (WHERE r.status = 'inconclusive') AS inconclusive_count,
        COUNT(*) FILTER (WHERE r.status = 'skipped') AS skipped_count,
        COUNT(*) FILTER (WHERE r.flaky = TRUE) AS flaky_count,
        COUNT(DISTINCT r.${entityFk}) FILTER (WHERE r.status IN ('passed', 'failed')) AS conclusive_entities_count
      FROM ${resultTable} r
      JOIN ${entityTable} e ON e.id = r.${entityFk}
      WHERE r.run_id = $1 AND e.review_status = 'approved';
    `;
    const resRow = (await pool.query(resultsQuery, [latestRun.id])).rows[0] || {};

    const passed = parseInt(resRow.passed_count || "0", 10);
    const failed = parseInt(resRow.failed_count || "0", 10);
    const inconclusive = parseInt(resRow.inconclusive_count || "0", 10);
    const flaky = parseInt(resRow.flaky_count || "0", 10);
    const conclusiveEntities = parseInt(resRow.conclusive_entities_count || "0", 10);

    const conclusiveDenominator = passed + failed;
    const totalAttempts = passed + failed + inconclusive;

    if (conclusiveDenominator === 0) {
      return {
        status: "NOT_EVALUATED",
        runId: latestRun.id,
        runType: latestRun.run_type,
        passRate: null,
        flakyRate: null,
        conclusiveCoverage: null,
        totalConclusiveResults: 0,
        passedResults: 0,
        failedResults: 0,
        reasons: ["Latest run had zero conclusive passed or failed outcomes."],
      };
    }

    const passRate = Math.round((passed / conclusiveDenominator) * 1000) / 10;
    const flakyRate = totalAttempts > 0 ? Math.round((flaky / totalAttempts) * 1000) / 10 : 0;
    const conclusiveCoverage = Math.round((conclusiveEntities / approvedEntitiesCount) * 1000) / 10;

    const reasons: string[] = [];
    let status: ProjectHealthStatus = "HEALTHY";

    if (passRate < 75) {
      status = "AT_RISK";
      reasons.push(`${domain.toUpperCase()} pass rate is critical: ${passRate}% (< 75%).`);
    } else if (flakyRate >= 15) {
      status = "AT_RISK";
      reasons.push(`${domain.toUpperCase()} flaky rate is severe: ${flakyRate}% (>= 15%).`);
    } else if (conclusiveCoverage < 40) {
      status = "AT_RISK";
      reasons.push(
        `${domain.toUpperCase()} conclusive coverage is critical: ${conclusiveCoverage}% (< 40%).`
      );
    } else if (passRate < 90) {
      status = "NEEDS_ATTENTION";
      reasons.push(`${domain.toUpperCase()} pass rate needs attention: ${passRate}% (< 90%).`);
    } else if (flakyRate >= 5) {
      status = "NEEDS_ATTENTION";
      reasons.push(`${domain.toUpperCase()} flaky rate is elevated: ${flakyRate}% (>= 5%).`);
    } else if (conclusiveCoverage < 75) {
      status = "NEEDS_ATTENTION";
      reasons.push(
        `${domain.toUpperCase()} conclusive coverage is moderate: ${conclusiveCoverage}% (< 75%).`
      );
    } else {
      reasons.push(`${domain.toUpperCase()} quality bars met (Pass: ${passRate}%, Coverage: ${conclusiveCoverage}%).`);
    }

    return {
      status,
      runId: latestRun.id,
      runType: latestRun.run_type,
      passRate,
      flakyRate,
      conclusiveCoverage,
      totalConclusiveResults: conclusiveDenominator,
      passedResults: passed,
      failedResults: failed,
      reasons,
    };
  }

  /**
   * 4. Compute Overall Deterministic Project Health
   */
  async evaluateProjectHealth(projectId: string): Promise<ReturnType<typeof computeProjectHealth>> {
    const [defects, discovery, webHealth, apiHealth] = await Promise.all([
      this.getDefectSummary(projectId),
      this.getDiscoveryMetrics(projectId),
      this.evaluateDomainHealth(projectId, "web"),
      this.evaluateDomainHealth(projectId, "api"),
    ]);

    return computeProjectHealth({ defects, discovery, webHealth, apiHealth });
  }

  /**
   * 5. Generate Multi-Tier Coverage Report
   */
  async getCoverageReport(projectId: string): Promise<CoverageReport> {
    // 1. Discovery Coverage
    const disc = await this.getDiscoveryMetrics(projectId);

    // 2. Scenario Generation Coverage
    const scenRes = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'generated' AND test_case_id IS NOT NULL) AS generated_count,
         COUNT(*) FILTER (WHERE status IN ('planned', 'generated', 'failed', 'skipped')) AS planned_count
       FROM scenario_checklists
       WHERE project_id = $1`,
      [projectId]
    );
    const scenGen = parseInt(scenRes.rows[0]?.generated_count || "0", 10);
    const scenPlanned = parseInt(scenRes.rows[0]?.planned_count || "0", 10);
    const scenPercent = scenPlanned > 0 ? Math.round((scenGen / scenPlanned) * 1000) / 10 : 0;

    // 3. Approval Coverage
    const tcRes = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE review_status = 'approved') AS approved_count,
         COUNT(*) AS total_count
       FROM test_cases
       WHERE project_id = $1`,
      [projectId]
    );
    const tcApproved = parseInt(tcRes.rows[0]?.approved_count || "0", 10);
    const tcTotal = parseInt(tcRes.rows[0]?.total_count || "0", 10);
    const tcPercent = tcTotal > 0 ? Math.round((tcApproved / tcTotal) * 1000) / 10 : 0;

    const epRes = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE review_status = 'approved') AS approved_count,
         COUNT(*) AS total_count
       FROM api_endpoints
       WHERE project_id = $1`,
      [projectId]
    );
    const epApproved = parseInt(epRes.rows[0]?.approved_count || "0", 10);
    const epTotal = parseInt(epRes.rows[0]?.total_count || "0", 10);
    const epPercent = epTotal > 0 ? Math.round((epApproved / epTotal) * 1000) / 10 : 0;

    const combApproved = tcApproved + epApproved;
    const combTotal = tcTotal + epTotal;
    const combPercent = combTotal > 0 ? Math.round((combApproved / combTotal) * 1000) / 10 : 0;

    // 4. Execution Coverage (Strictly Approved Entities)
    // Web Lifetime & Latest Run
    const webLifetimeRes = await pool.query(
      `SELECT COUNT(DISTINCT tr.test_case_id) AS executed_count
       FROM test_results tr
       JOIN test_cases tc ON tc.id = tr.test_case_id
       WHERE tc.project_id = $1 AND tc.review_status = 'approved' AND tr.status IN ('passed', 'failed')`,
      [projectId]
    );
    const webUniqueConclusiveLifetime = parseInt(webLifetimeRes.rows[0]?.executed_count || "0", 10);
    const webLifetimePercent =
      tcApproved > 0 ? Math.round((webUniqueConclusiveLifetime / tcApproved) * 1000) / 10 : 0;

    const webHealth = await this.evaluateDomainHealth(projectId, "web");
    const webUniqueLatest =
      webHealth.runId && tcApproved > 0
        ? (
            await pool.query(
              `SELECT COUNT(DISTINCT tr.test_case_id) AS count
               FROM test_results tr
               JOIN test_cases tc ON tc.id = tr.test_case_id
               WHERE tr.run_id = $1 AND tc.review_status = 'approved' AND tr.status IN ('passed', 'failed')`,
              [webHealth.runId]
            )
          ).rows[0]?.count || "0"
        : 0;
    const webLatestCount = parseInt(webUniqueLatest.toString(), 10);
    const webLatestPercent = tcApproved > 0 ? Math.round((webLatestCount / tcApproved) * 1000) / 10 : 0;

    // API Lifetime & Latest Run
    const apiLifetimeRes = await pool.query(
      `SELECT COUNT(DISTINCT atr.endpoint_id) AS executed_count
       FROM api_test_results atr
       JOIN api_endpoints ep ON ep.id = atr.endpoint_id
       WHERE ep.project_id = $1 AND ep.review_status = 'approved' AND atr.status IN ('passed', 'failed')`,
      [projectId]
    );
    const apiUniqueConclusiveLifetime = parseInt(apiLifetimeRes.rows[0]?.executed_count || "0", 10);
    const apiLifetimePercent =
      epApproved > 0 ? Math.round((apiUniqueConclusiveLifetime / epApproved) * 1000) / 10 : 0;

    const apiHealth = await this.evaluateDomainHealth(projectId, "api");
    const apiUniqueLatest =
      apiHealth.runId && epApproved > 0
        ? (
            await pool.query(
              `SELECT COUNT(DISTINCT atr.endpoint_id) AS count
               FROM api_test_results atr
               JOIN api_endpoints ep ON ep.id = atr.endpoint_id
               WHERE atr.run_id = $1 AND ep.review_status = 'approved' AND atr.status IN ('passed', 'failed')`,
              [apiHealth.runId]
            )
          ).rows[0]?.count || "0"
        : 0;
    const apiLatestCount = parseInt(apiUniqueLatest.toString(), 10);
    const apiLatestPercent = epApproved > 0 ? Math.round((apiLatestCount / epApproved) * 1000) / 10 : 0;

    // Combined Lifetime (Distinct Tables, Zero Collision)
    const combConclusiveLifetime = webUniqueConclusiveLifetime + apiUniqueConclusiveLifetime;
    const combLifetimePercent =
      combApproved > 0 ? Math.round((combConclusiveLifetime / combApproved) * 1000) / 10 : 0;

    // 5. Category Coverage
    const catRes = await pool.query(
      `SELECT
         category,
         COUNT(*) FILTER (WHERE status = 'generated' AND test_case_id IS NOT NULL) AS gen_count,
         COUNT(*) FILTER (WHERE status IN ('planned', 'generated', 'failed', 'skipped')) AS plan_count
       FROM scenario_checklists
       WHERE project_id = $1
       GROUP BY category`,
      [projectId]
    );
    const categoryCoverage: Record<string, { planned: number; generated: number; percent: number }> = {
      positive: { planned: 0, generated: 0, percent: 0 },
      negative: { planned: 0, generated: 0, percent: 0 },
      boundary: { planned: 0, generated: 0, percent: 0 },
      edge_case: { planned: 0, generated: 0, percent: 0 },
    };
    for (const r of catRes.rows) {
      const plan = parseInt(r.plan_count || "0", 10);
      const gen = parseInt(r.gen_count || "0", 10);
      categoryCoverage[r.category] = {
        planned: plan,
        generated: gen,
        percent: plan > 0 ? Math.round((gen / plan) * 1000) / 10 : 0,
      };
    }

    return {
      projectId,
      discoveryCoverage: {
        visitedPages: disc.visitedCount,
        eligiblePages: disc.visitedCount + disc.queuedCount + disc.failedCount,
        coveragePercent: disc.coveragePercent,
        status: disc.healthStatus,
        crawledPagesCount: disc.totalDiscovered,
        pagesWithScenariosCount: disc.visitedCount,
        percentage: disc.coveragePercent,
      },
      scenarioGenerationCoverage: {
        generatedScenarios: scenGen,
        plannedScenarios: scenPlanned,
        coveragePercent: scenPercent,
        totalGeneratedCases: scenPlanned,
        approvedGeneratedCases: scenGen,
        percentage: scenPercent,
      },
      approvalCoverage: {
        web: { approved: tcApproved, total: tcTotal, percent: tcPercent },
        api: { approved: epApproved, total: epTotal, percent: epPercent },
        combined: { approved: combApproved, total: combTotal, percent: combPercent },
        totalTestCases: combTotal,
        approvedTestCases: combApproved,
        percentage: combPercent,
      },
      executionCoverage: {
        web: {
          approvedEligible: tcApproved,
          uniqueConclusiveLifetime: webUniqueConclusiveLifetime,
          lifetimeCoveragePercent: webLifetimePercent,
          uniqueConclusiveLatestRun: webLatestCount,
          latestRunCoveragePercent: webLatestPercent,
          lifetimeApprovedCases: tcApproved,
          lifetimeExecutedCases: webUniqueConclusiveLifetime,
          lifetimePercentage: webLifetimePercent,
          latestRunApprovedCases: tcApproved,
          latestRunExecutedCases: webLatestCount,
          latestRunPercentage: webLatestPercent,
          latestRunId: webHealth.runId,
        },
        api: {
          approvedEligible: epApproved,
          uniqueConclusiveLifetime: apiUniqueConclusiveLifetime,
          lifetimeCoveragePercent: apiLifetimePercent,
          uniqueConclusiveLatestRun: apiLatestCount,
          latestRunCoveragePercent: apiLatestPercent,
          lifetimeApprovedEndpoints: epApproved,
          lifetimeExecutedEndpoints: apiUniqueConclusiveLifetime,
          lifetimePercentage: apiLifetimePercent,
          latestRunApprovedEndpoints: epApproved,
          latestRunExecutedEndpoints: apiLatestCount,
          latestRunPercentage: apiLatestPercent,
          latestRunId: apiHealth.runId,
        },
        combined: {
          approvedEligible: combApproved,
          uniqueConclusiveLifetime: combConclusiveLifetime,
          lifetimeCoveragePercent: combLifetimePercent,
        },
      },
      categoryCoverage: {
        ...categoryCoverage,
        categories: Object.entries(categoryCoverage).map(([k, v]) => ({
          category: k,
          totalCases: v.planned,
          executedCases: v.generated,
          passedCases: v.generated,
          percentage: v.percent,
        })),
      },
    };
  }

  /**
   * 6. Classify a Failed or Inconclusive Result Deterministically
   */
  classifyFailure(params: Parameters<typeof classifyFailure>[0]) {
    return classifyFailure(params);
  }

  /**
   * 7. Query Classified Failures for a Project
   */
  async getFailures(
    projectId: string,
    filter?: { runId?: string; limit?: number }
  ): Promise<ClassifiedFailure[]> {
    const limit = filter?.limit || 100;
    const failures: ClassifiedFailure[] = [];

    // Query web failures
    const webQuery = `
      SELECT
        tr.id, tr.run_id, tr.test_case_id, tc.title AS target_name, tr.status, tr.error_message,
        tr.duration_ms, tr.retry_count, tr.flaky, tr.attempts, tr.created_at,
        tc.test_type, tc.expected_result, sc.category AS scenario_category,
        br.status AS bug_status, br.classification AS bug_classification, br.probable_cause
      FROM test_results tr
      JOIN test_cases tc ON tc.id = tr.test_case_id
      LEFT JOIN scenario_checklists sc ON sc.project_id = tc.project_id AND sc.scenario_id = tc.scenario_id
      LEFT JOIN bug_reports br ON br.result_id = tr.id
      WHERE tc.project_id = $1 AND tr.status IN ('failed', 'inconclusive')
        ${filter?.runId ? "AND tr.run_id = $2" : ""}
      ORDER BY tr.created_at DESC
      LIMIT ${limit};
    `;
    const webRes = await pool.query(webQuery, filter?.runId ? [projectId, filter.runId] : [projectId]);

    for (const row of webRes.rows) {
      const { classification, label } = this.classifyFailure({
        status: row.status,
        errorMessage: row.error_message,
        flaky: row.flaky === true,
        retryCount: row.retry_count || 0,
        attempts: row.attempts,
        testType: row.test_type,
        expectedResult: row.expected_result,
        scenarioCategory: row.scenario_category,
        bugReportClassification: row.bug_classification,
        bugReportStatus: row.bug_status,
      });

      failures.push({
        id: row.id,
        resultId: row.id,
        runId: row.run_id,
        runType: "web",
        executionDomain: "web",
        targetId: row.test_case_id,
        testCaseId: row.test_case_id,
        targetName: row.target_name,
        testName: row.target_name,
        status: row.status,
        classification,
        classificationLabel: label,
        confidenceScore: 0.85,
        errorMessage: row.error_message,
        durationMs: row.duration_ms,
        retryCount: row.retry_count || 0,
        isFlaky: row.flaky === true,
        probableCauseSuggestion: row.probable_cause,
        aiSuggestedAction: row.probable_cause,
        isAiSuggestion: Boolean(row.probable_cause),
        bugReportStatus: row.bug_status === "confirmed" ? "confirmed" : row.bug_status === "suspected" ? "suspected" : "none",
        executedAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
      });
    }

    // Query API failures
    const apiQuery = `
      SELECT
        atr.id, atr.run_id, atr.endpoint_id, ep.name AS target_name, atr.status, atr.error_message,
        atr.response_ms, atr.actual_status, ep.expected_status, atr.retry_count, atr.flaky, atr.attempts, atr.created_at,
        br.status AS bug_status, br.classification AS bug_classification, br.probable_cause
      FROM api_test_results atr
      JOIN api_endpoints ep ON ep.id = atr.endpoint_id
      LEFT JOIN bug_reports br ON br.api_result_id = atr.id
      WHERE ep.project_id = $1 AND atr.status IN ('failed', 'inconclusive')
        ${filter?.runId ? "AND atr.run_id = $2" : ""}
      ORDER BY atr.created_at DESC
      LIMIT ${limit};
    `;
    const apiRes = await pool.query(apiQuery, filter?.runId ? [projectId, filter.runId] : [projectId]);

    for (const row of apiRes.rows) {
      const { classification, label } = this.classifyFailure({
        status: row.status,
        errorMessage: row.error_message,
        flaky: row.flaky === true,
        retryCount: row.retry_count || 0,
        attempts: row.attempts,
        actualStatus: row.actual_status,
        expectedStatus: row.expected_status,
        bugReportClassification: row.bug_classification,
        bugReportStatus: row.bug_status,
      });

      failures.push({
        id: row.id,
        resultId: row.id,
        runId: row.run_id,
        runType: "api",
        executionDomain: "api",
        targetId: row.endpoint_id,
        testCaseId: row.endpoint_id,
        targetName: row.target_name,
        testName: row.target_name,
        status: row.status,
        classification,
        classificationLabel: label,
        confidenceScore: 0.85,
        errorMessage: row.error_message,
        durationMs: row.response_ms,
        retryCount: row.retry_count || 0,
        isFlaky: row.flaky === true,
        actualStatus: row.actual_status,
        expectedStatus: row.expected_status,
        probableCauseSuggestion: row.probable_cause,
        aiSuggestedAction: row.probable_cause,
        isAiSuggestion: Boolean(row.probable_cause),
        bugReportStatus: row.bug_status === "confirmed" ? "confirmed" : row.bug_status === "suspected" ? "suspected" : "none",
        executedAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
      });
    }

    // Sort by execution time descending
    failures.sort((a, b) => new Date(b.executedAt).getTime() - new Date(a.executedAt).getTime());
    return failures.slice(0, limit);
  }

  /**
   * 8. Query AI Usage & Cost Telemetry
   */
  async getAiUsageMetrics(projectId: string): Promise<AiUsageReport> {
    const totalsQuery = `
      SELECT
        COUNT(*) AS total_calls,
        COALESCE(SUM(prompt_tokens), 0) AS total_prompt,
        COALESCE(SUM(completion_tokens), 0) AS total_completion,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(estimated_cost_usd), 0) AS total_cost
      FROM ai_usage_logs
      WHERE project_id = $1;
    `;
    const totalsRes = await pool.query(totalsQuery, [projectId]);
    const totRow = totalsRes.rows[0] || {};

    const savingsQuery = `
      SELECT
        COALESCE(SUM(saved_tokens), 0) AS saved_tokens,
        COALESCE(SUM(saved_cost_usd), 0) AS saved_cost
      FROM ai_cache_savings_logs
      WHERE project_id = $1;
    `;
    const savRes = await pool.query(savingsQuery, [projectId]);
    const savRow = savRes.rows[0] || {};

    const providerQuery = `
      SELECT
        provider,
        COUNT(*) AS calls,
        COALESCE(SUM(total_tokens), 0) AS tokens,
        COALESCE(SUM(estimated_cost_usd), 0) AS cost
      FROM ai_usage_logs
      WHERE project_id = $1
      GROUP BY provider
      ORDER BY cost DESC, tokens DESC;
    `;
    const provRes = await pool.query(providerQuery, [projectId]);

    const modelQuery = `
      SELECT
        model,
        COUNT(*) AS calls,
        COALESCE(SUM(total_tokens), 0) AS tokens,
        COALESCE(SUM(estimated_cost_usd), 0) AS cost
      FROM ai_usage_logs
      WHERE project_id = $1
      GROUP BY model
      ORDER BY cost DESC, tokens DESC;
    `;
    const modRes = await pool.query(modelQuery, [projectId]);

    const featureQuery = `
      SELECT
        feature,
        COUNT(*) AS calls,
        COALESCE(SUM(total_tokens), 0) AS tokens,
        COALESCE(SUM(estimated_cost_usd), 0) AS cost
      FROM ai_usage_logs
      WHERE project_id = $1
      GROUP BY feature
      ORDER BY cost DESC, tokens DESC;
    `;
    const featRes = await pool.query(featureQuery, [projectId]);

    const recentLogsQuery = `
      SELECT id, feature, provider, model, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, duration_ms, created_at
      FROM ai_usage_logs
      WHERE project_id = $1
      ORDER BY created_at DESC
      LIMIT 50;
    `;
    const logsRes = await pool.query(recentLogsQuery, [projectId]);

    const totalCalls = parseInt(totRow.total_calls || "0", 10);
    const totalPrompt = parseInt(totRow.total_prompt || "0", 10);
    const totalCompletion = parseInt(totRow.total_completion || "0", 10);
    const totalTokens = parseInt(totRow.total_tokens || "0", 10);
    const totalCost = parseFloat(totRow.total_cost || "0");
    const savedTokens = parseInt(savRow.saved_tokens || "0", 10);
    const savedCost = parseFloat(savRow.saved_cost || "0");

    const providers = provRes.rows.map((r) => ({
      provider: r.provider || "gemini",
      model: modRes.rows.find((m) => m.calls > 0)?.model || r.provider,
      invocations: parseInt(r.calls || "0", 10),
      tokens: parseInt(r.tokens || "0", 10),
      costUsd: parseFloat(r.cost || "0"),
      isLocal: (r.provider || "").toLowerCase() === "ollama",
    }));

    return {
      projectId,
      totalInvocations: totalCalls,
      totalPromptTokens: totalPrompt,
      totalCompletionTokens: totalCompletion,
      totalTokens,
      totalEstimatedCostUsd: totalCost,
      providers,
      cacheSavings: {
        totalHits: savedTokens > 0 ? 1 : 0,
        tokensSaved: savedTokens,
        estimatedDollarsSavedUsd: savedCost,
      },
      totals: {
        totalCalls,
        promptTokens: totalPrompt,
        completionTokens: totalCompletion,
        totalTokens,
        estimatedCostUsd: totalCost,
        savedTokens,
        savedCostUsd: savedCost,
      },
      byProvider: provRes.rows.map((r) => ({
        provider: r.provider || "gemini",
        calls: parseInt(r.calls || "0", 10),
        totalTokens: parseInt(r.tokens || "0", 10),
        estimatedCostUsd: parseFloat(r.cost || "0"),
        isZeroCostLocal: (r.provider || "").toLowerCase() === "ollama",
      })),
      byModel: modRes.rows.map((r) => ({
        model: r.model,
        calls: parseInt(r.calls || "0", 10),
        totalTokens: parseInt(r.tokens || "0", 10),
        estimatedCostUsd: parseFloat(r.cost || "0"),
      })),
      byFeature: featRes.rows.map((r) => ({
        feature: r.feature,
        calls: parseInt(r.calls || "0", 10),
        totalTokens: parseInt(r.tokens || "0", 10),
        estimatedCostUsd: parseFloat(r.cost || "0"),
      })),
      recentLogs: logsRes.rows.map((r) => ({
        id: r.id,
        feature: r.feature,
        provider: r.provider || "gemini",
        model: r.model,
        promptTokens: parseInt(r.prompt_tokens || "0", 10),
        completionTokens: parseInt(r.completion_tokens || "0", 10),
        totalTokens: parseInt(r.total_tokens || "0", 10),
        estimatedCostUsd: parseFloat(r.estimated_cost_usd || "0"),
        durationMs: r.duration_ms ? parseInt(r.duration_ms, 10) : null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
      })),
    };
  }

  /**
   * 9. Query Execution Telemetry (Lifetime vs Latest-Run Separated)
   */
  async getExecutionReport(projectId: string): Promise<ExecutionReport> {
    const [latestWebRun, latestApiRun] = await Promise.all([
      this.evaluateDomainHealth(projectId, "web"),
      this.evaluateDomainHealth(projectId, "api"),
    ]);

    // Lifetime Web Metrics
    const webLifeRes = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE tr.status = 'passed') AS passed_count,
         COUNT(*) FILTER (WHERE tr.status = 'failed') AS failed_count
       FROM test_results tr
       JOIN test_cases tc ON tc.id = tr.test_case_id
       WHERE tc.project_id = $1 AND tc.review_status = 'approved'`,
      [projectId]
    );
    const webPassed = parseInt(webLifeRes.rows[0]?.passed_count || "0", 10);
    const webFailed = parseInt(webLifeRes.rows[0]?.failed_count || "0", 10);
    const webConclusive = webPassed + webFailed;
    const webPassRate = webConclusive > 0 ? Math.round((webPassed / webConclusive) * 1000) / 10 : 0;

    // Lifetime API Metrics
    const apiLifeRes = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE atr.status = 'passed') AS passed_count,
         COUNT(*) FILTER (WHERE atr.status = 'failed') AS failed_count
       FROM api_test_results atr
       JOIN api_endpoints ep ON ep.id = atr.endpoint_id
       WHERE ep.project_id = $1 AND ep.review_status = 'approved'`,
      [projectId]
    );
    const apiPassed = parseInt(apiLifeRes.rows[0]?.passed_count || "0", 10);
    const apiFailed = parseInt(apiLifeRes.rows[0]?.failed_count || "0", 10);
    const apiConclusive = apiPassed + apiFailed;
    const apiPassRate = apiConclusive > 0 ? Math.round((apiPassed / apiConclusive) * 1000) / 10 : 0;

    // Recent Runs
    const recentRes = await pool.query(
      `SELECT id, run_type, status, started_at, finished_at, concurrency, flaky_count, total_count, created_at
       FROM test_runs
       WHERE project_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [projectId]
    );

    return {
      projectId,
      web: {
        totalTests: webConclusive,
        passedTests: webPassed,
        failedTests: webFailed,
        passRate: webPassRate,
        latestRunId: latestWebRun.runId || null,
        latestRunPassRate: latestWebRun.passRate,
      },
      api: {
        totalTests: apiConclusive,
        passedTests: apiPassed,
        failedTests: apiFailed,
        passRate: apiPassRate,
        latestRunId: latestApiRun.runId || null,
        latestRunPassRate: latestApiRun.passRate,
      },
      summary: {
        totalRuns: recentRes.rows.length,
        passedRuns: recentRes.rows.filter((r) => r.status === "passed").length,
        failedRuns: recentRes.rows.filter((r) => r.status === "failed").length,
        passRate:
          recentRes.rows.length > 0
            ? Math.round(
                (recentRes.rows.filter((r) => r.status === "passed").length / recentRes.rows.length) * 1000
              ) / 10
            : 0,
      },
      latestWebRun: latestWebRun.runId ? latestWebRun : null,
      latestApiRun: latestApiRun.runId ? latestApiRun : null,
      lifetimeWebMetrics: {
        totalConclusive: webConclusive,
        passed: webPassed,
        failed: webFailed,
        passRate: webPassRate,
      },
      lifetimeApiMetrics: {
        totalConclusive: apiConclusive,
        passed: apiPassed,
        failed: apiFailed,
        passRate: apiPassRate,
      },
      recentRuns: recentRes.rows.map((r) => ({
        id: r.id,
        runType: r.run_type,
        status: r.status,
        startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
        finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
        concurrency: r.concurrency || 1,
        flakyCount: r.flaky_count || 0,
        totalCount: r.total_count || 0,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
      })),
    };
  }

  /**
   * 10. Generate Complete Executive Summary Report
   */
  async getExecutiveSummary(projectId: string): Promise<ExecutiveSummaryReport> {
    const projRes = await pool.query("SELECT id, name, base_url FROM projects WHERE id = $1", [projectId]);
    const project = projRes.rows[0];
    if (!project) {
      throw new Error("Project not found");
    }

    const [health, defects, discovery, coverage, aiUsage] = await Promise.all([
      this.evaluateProjectHealth(projectId),
      this.getDefectSummary(projectId),
      this.getDiscoveryMetrics(projectId),
      this.getCoverageReport(projectId),
      this.getAiUsageMetrics(projectId),
    ]);

    const runCountRes = await pool.query("SELECT COUNT(*) AS count FROM test_runs WHERE project_id = $1", [
      projectId,
    ]);

    return {
      projectId: project.id,
      projectName: project.name,
      baseUrl: project.base_url,
      generatedAt: new Date().toISOString(),
      health: {
        ...health,
        overallHealth: health.overallStatus,
        evaluatedAt: new Date().toISOString(),
      },
      defects: {
        ...defects,
        confirmedDefects: {
          critical: defects.confirmed.critical_high,
          high: 0,
          critical_high: defects.confirmed.critical_high,
          medium: defects.confirmed.medium,
          low: defects.confirmed.low,
          total: defects.confirmed.total,
        },
        suspectedDefects: {
          critical: defects.suspected.critical_high,
          high: 0,
          critical_high: defects.suspected.critical_high,
          medium: defects.suspected.medium,
          low: defects.suspected.low,
          total: defects.suspected.total,
        },
        dismissedDefects: defects.dismissed,
      },
      discovery: {
        ...discovery,
        totalCrawledPages: discovery.totalDiscovered,
        pagesWithScenarios: discovery.visitedCount,
      },
      coverage: {
        ...coverage,
        discoveryCoverage: coverage.discoveryCoverage,
        scenarioGenerationCoverage: coverage.scenarioGenerationCoverage,
        approvalCoverage: coverage.approvalCoverage,
        executionCoverage: coverage.executionCoverage,
        categoryCoverage: coverage.categoryCoverage,
        discoveryCoveragePercent: coverage.discoveryCoverage.coveragePercent,
        scenarioCoverage: coverage.scenarioGenerationCoverage.coveragePercent,
        webApprovalCoverage: coverage.approvalCoverage.web.percent,
        apiApprovalCoverage: coverage.approvalCoverage.api.percent,
        combinedApprovalCoverage: coverage.approvalCoverage.combined.percent,
        lifetimeConclusiveExecutionCoverage: coverage.executionCoverage.combined.lifetimeCoveragePercent,
      },
      executionTotals: {
        totalTestCases: coverage.approvalCoverage.web.total,
        approvedTestCases: coverage.approvalCoverage.web.approved,
        totalApiEndpoints: coverage.approvalCoverage.api.total,
        approvedApiEndpoints: coverage.approvalCoverage.api.approved,
        totalRunsExecuted: parseInt(runCountRes.rows[0]?.count || "0", 10),
      },
      execution: {
        summary: {
          totalRuns: parseInt(runCountRes.rows[0]?.count || "0", 10),
          passedRuns: 0,
          failedRuns: 0,
          passRate: coverage.executionCoverage.combined.lifetimeCoveragePercent,
        },
        web: {
          totalTests: coverage.executionCoverage.web.uniqueConclusiveLifetime,
          passedTests: coverage.executionCoverage.web.uniqueConclusiveLifetime,
          failedTests: 0,
          passRate: coverage.executionCoverage.web.lifetimeCoveragePercent,
          latestRunId: health.webHealth.runId,
          latestRunPassRate: health.webHealth.passRate,
        },
        api: {
          totalTests: coverage.executionCoverage.api.uniqueConclusiveLifetime,
          passedTests: coverage.executionCoverage.api.uniqueConclusiveLifetime,
          failedTests: 0,
          passRate: coverage.executionCoverage.api.lifetimeCoveragePercent,
          latestRunId: health.apiHealth.runId,
          latestRunPassRate: health.apiHealth.passRate,
        },
      },
      aiUsage: {
        ...aiUsage,
        totalCalls: aiUsage.totals.totalCalls,
        totalPromptTokens: aiUsage.totals.promptTokens,
        totalCompletionTokens: aiUsage.totals.completionTokens,
        totalTokens: aiUsage.totals.totalTokens,
        totalEstimatedCostUsd: aiUsage.totals.estimatedCostUsd,
        totalSavedTokens: aiUsage.totals.savedTokens,
        totalSavedCostUsd: aiUsage.totals.savedCostUsd,
      },
    };
  }
}

export const reportingService = new ReportingService();
export const evaluateProjectHealth = computeProjectHealth;
