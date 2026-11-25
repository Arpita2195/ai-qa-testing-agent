import React, { useState, useEffect, useCallback } from "react";
import { api, apiBase } from "../App";

interface ProjectHealth {
  overallHealth: "HEALTHY" | "NEEDS_ATTENTION" | "AT_RISK" | "NOT_EVALUATED";
  overallStatus?: "HEALTHY" | "NEEDS_ATTENTION" | "AT_RISK" | "NOT_EVALUATED";
  reasons: string[];
  evaluatedAt?: string;
  webHealth?: {
    status: "HEALTHY" | "NEEDS_ATTENTION" | "AT_RISK" | "NOT_EVALUATED";
    runId?: string | null;
    passRate?: number | null;
  } | "HEALTHY" | "NEEDS_ATTENTION" | "AT_RISK" | "NOT_EVALUATED";
  apiHealth?: {
    status: "HEALTHY" | "NEEDS_ATTENTION" | "AT_RISK" | "NOT_EVALUATED";
    runId?: string | null;
    passRate?: number | null;
  } | "HEALTHY" | "NEEDS_ATTENTION" | "AT_RISK" | "NOT_EVALUATED";
  latestWebRunId?: string | null;
  latestApiRunId?: string | null;
}

interface CoverageMetrics {
  discoveryCoverage?: {
    crawledPagesCount?: number;
    pagesWithScenariosCount?: number;
    percentage?: number;
    coveragePercent?: number;
  } | number;
  scenarioGenerationCoverage?: {
    totalGeneratedCases?: number;
    approvedGeneratedCases?: number;
    generatedScenarios?: number;
    plannedScenarios?: number;
    percentage?: number;
    coveragePercent?: number;
  };
  approvalCoverage?: {
    totalTestCases?: number;
    approvedTestCases?: number;
    percentage?: number;
    web?: { approved: number; total: number; percent: number };
    api?: { approved: number; total: number; percent: number };
    combined?: { approved: number; total: number; percent: number };
  };
  executionCoverage?: {
    web?: {
      lifetimeApprovedCases?: number;
      lifetimeExecutedCases?: number;
      lifetimePercentage?: number;
      latestRunApprovedCases?: number;
      latestRunExecutedCases?: number;
      latestRunPercentage?: number;
      approvedEligible?: number;
      uniqueConclusiveLifetime?: number;
      lifetimeCoveragePercent?: number;
      uniqueConclusiveLatestRun?: number;
      latestRunCoveragePercent?: number;
      latestRunId?: string | null;
    };
    api?: {
      lifetimeApprovedEndpoints?: number;
      lifetimeExecutedEndpoints?: number;
      lifetimePercentage?: number;
      latestRunApprovedEndpoints?: number;
      latestRunExecutedEndpoints?: number;
      latestRunPercentage?: number;
      approvedEligible?: number;
      uniqueConclusiveLifetime?: number;
      lifetimeCoveragePercent?: number;
      uniqueConclusiveLatestRun?: number;
      latestRunCoveragePercent?: number;
      latestRunId?: string | null;
    };
  };
  categoryCoverage?: {
    categories?: Array<{
      category: string;
      totalCases: number;
      executedCases: number;
      passedCases: number;
      percentage: number;
    }>;
    [key: string]: any;
  };
}

interface ExecutionReport {
  summary?: {
    totalRuns: number;
    passedRuns: number;
    failedRuns: number;
    passRate: number;
  };
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
}

interface ClassifiedFailure {
  resultId: string;
  runId: string;
  testCaseId: string | null;
  testName: string;
  executionDomain: "web" | "api";
  classification:
    | "inconclusive_result"
    | "flaky_failure"
    | "authentication_failure"
    | "network_failure"
    | "infrastructure_failure"
    | "application_defect"
    | "script_or_selector_failure"
    | "unclassified_failure";
  confidenceScore: number;
  errorMessage: string;
  aiSuggestedAction: string | null;
  executedAt: string;
}

interface AiUsageMetrics {
  totalPromptTokens?: number;
  totalCompletionTokens?: number;
  totalTokens?: number;
  totalInvocations?: number;
  totalEstimatedCostUsd?: number;
  providers?: Array<{
    provider: string;
    model: string;
    invocations: number;
    tokens: number;
    costUsd: number;
    isLocal: boolean;
  }>;
  cacheSavings?: {
    totalHits: number;
    tokensSaved: number;
    estimatedDollarsSavedUsd: number;
  };
  totals?: {
    totalCalls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    savedTokens: number;
    savedCostUsd: number;
  };
}

interface DiscoveryReport {
  totalCrawledPages?: number;
  totalDiscovered?: number;
  pagesWithScenarios?: number;
  visitedCount?: number;
  pages?: Array<{
    id?: string;
    url: string;
    path?: string;
    depth: number;
    status?: string;
    pageType?: string;
    title?: string;
    scenariosGenerated?: number;
    crawledAt?: string;
    createdAt?: string;
  }>;
}

interface DefectSummary {
  confirmedDefects?: {
    total: number;
    critical?: number;
    high?: number;
    critical_high?: number;
    medium: number;
    low: number;
  };
  suspectedDefects?: {
    total: number;
    critical?: number;
    high?: number;
    critical_high?: number;
    medium: number;
    low: number;
  };
  confirmed?: {
    critical_high: number;
    medium: number;
    low: number;
    total: number;
  };
  suspected?: {
    critical_high: number;
    medium: number;
    low: number;
    total: number;
  };
  dismissedDefects?: number;
  dismissed?: number;
}

interface ExecutiveSummaryReport {
  projectId: string;
  projectName: string;
  generatedAt: string;
  health: ProjectHealth;
  defects: DefectSummary;
  coverage: CoverageMetrics;
  execution: ExecutionReport;
  aiUsage: AiUsageMetrics;
  discovery: DiscoveryReport;
}

class ReportsErrorBoundary extends React.Component<
  { projectId: string; children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: any) {
    console.error("ReportsTab render crash caught by boundary:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="tab-content">
          <div className="notice error">
            <h3>Unable to render Reports Dashboard</h3>
            <p style={{ margin: "8px 0" }}>
              {this.state.error?.message || "An unexpected error occurred while rendering the reports."}
            </p>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false, error: null })}
              style={{ marginTop: 8 }}
            >
              Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function ReportsTab({ projectId }: { projectId: string }) {
  return (
    <ReportsErrorBoundary projectId={projectId}>
      <ReportsTabContent projectId={projectId} />
    </ReportsErrorBoundary>
  );
}

function ReportsTabContent({ projectId }: { projectId: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summaryData, setSummaryData] = useState<ExecutiveSummaryReport | null>(null);
  const [failures, setFailures] = useState<ClassifiedFailure[]>([]);
  const [discoveryData, setDiscoveryData] = useState<DiscoveryReport | null>(null);
  const [activeSubView, setActiveSubView] = useState<
    "summary" | "coverage" | "execution" | "failures" | "discovery" | "ai"
  >("summary");
  const [exportingFormat, setExportingFormat] = useState<string | null>(null);

  const fetchReports = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sum, fail, disc] = await Promise.all([
        api<ExecutiveSummaryReport>(`/projects/${projectId}/reports/executive-summary`),
        api<{ failures: ClassifiedFailure[] }>(`/projects/${projectId}/reports/failures?limit=50`).catch(() => ({
          failures: [],
        })),
        api<DiscoveryReport>(`/projects/${projectId}/reports/discovery`).catch(() => null),
      ]);
      setSummaryData(sum);
      setFailures(fail?.failures || []);
      if (disc) setDiscoveryData(disc);
    } catch (err: any) {
      setError(err?.message || "Failed to load project reports");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  const handlePrintPdf = () => {
    const printUrl = `${apiBase}/projects/${projectId}/reports/export?format=html&reportType=summary`;
    const win = window.open(printUrl, "_blank");
    if (win) {
      win.focus();
      setTimeout(() => {
        try {
          win.print();
        } catch {
          // ignore
        }
      }, 1000);
    }
  };

  const handleDownloadFile = async (format: "html" | "csv" | "json", reportType = "summary") => {
    try {
      setExportingFormat(`${format}-${reportType}`);
      const exportUrl = `${apiBase}/projects/${projectId}/reports/export?format=${format}&reportType=${reportType}`;
      const response = await fetch(exportUrl, { credentials: "include" });
      if (!response.ok) {
        throw new Error(`Export failed with HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      const extension = format === "html" ? "html" : format === "csv" ? "csv" : "json";
      anchor.download = `project-${projectId}-report-${reportType}.${extension}`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(blobUrl);
    } catch (err: any) {
      alert(`Export failed: ${err.message}`);
    } finally {
      setExportingFormat(null);
    }
  };

  if (loading) {
    return (
      <div className="tab-content">
        <div className="notice">Loading project executive reports & telemetry...</div>
      </div>
    );
  }

  if (error || !summaryData) {
    return (
      <div className="tab-content">
        <div className="notice error">{error || "Unable to display report."}</div>
        <button type="button" onClick={fetchReports} style={{ marginTop: 10 }}>
          Retry
        </button>
      </div>
    );
  }

  // Safe extraction of all metrics with defaults
  const health = summaryData.health || ({} as any);
  const defects = summaryData.defects || ({} as any);
  const coverage = summaryData.coverage || ({} as any);
  const execution = summaryData.execution || ({} as any);
  const aiUsage = summaryData.aiUsage || ({} as any);
  const discovery = summaryData.discovery || ({} as any);

  // Health fields
  const overallHealth: string = health.overallHealth || health.overallStatus || "NOT_EVALUATED";
  const evaluatedAt: string = health.evaluatedAt || summaryData.generatedAt || new Date().toISOString();
  const reasons: string[] = Array.isArray(health.reasons) ? health.reasons : [];
  const webHealthStatus: string =
    typeof health.webHealth === "object" && health.webHealth !== null
      ? health.webHealth.status || "NOT_EVALUATED"
      : health.webHealth || "NOT_EVALUATED";
  const apiHealthStatus: string =
    typeof health.apiHealth === "object" && health.apiHealth !== null
      ? health.apiHealth.status || "NOT_EVALUATED"
      : health.apiHealth || "NOT_EVALUATED";

  // Defect breakdown
  const confirmedCritHigh =
    defects.confirmedDefects?.critical_high !== undefined
      ? defects.confirmedDefects.critical_high
      : defects.confirmedDefects?.critical !== undefined || defects.confirmedDefects?.high !== undefined
      ? (defects.confirmedDefects?.critical ?? 0) + (defects.confirmedDefects?.high ?? 0)
      : defects.confirmed?.critical_high ?? 0;
  const confirmedMed = defects.confirmedDefects?.medium ?? defects.confirmed?.medium ?? 0;
  const confirmedLow = defects.confirmedDefects?.low ?? defects.confirmed?.low ?? 0;
  const confirmedTotal =
    defects.confirmedDefects?.total ?? defects.confirmed?.total ?? confirmedCritHigh + confirmedMed + confirmedLow;

  const suspectedCritHigh =
    defects.suspectedDefects?.critical_high !== undefined
      ? defects.suspectedDefects.critical_high
      : defects.suspectedDefects?.critical !== undefined || defects.suspectedDefects?.high !== undefined
      ? (defects.suspectedDefects?.critical ?? 0) + (defects.suspectedDefects?.high ?? 0)
      : defects.suspected?.critical_high ?? 0;
  const suspectedMed = defects.suspectedDefects?.medium ?? defects.suspected?.medium ?? 0;
  const suspectedLow = defects.suspectedDefects?.low ?? defects.suspected?.low ?? 0;
  const suspectedTotal =
    defects.suspectedDefects?.total ?? defects.suspected?.total ?? suspectedCritHigh + suspectedMed + suspectedLow;

  // Discovery fields
  const totalCrawledPages = discovery.totalCrawledPages ?? discovery.totalDiscovered ?? 0;
  const pagesWithScenarios = discovery.pagesWithScenarios ?? discovery.visitedCount ?? 0;

  // Coverage fields
  const discCovPct =
    typeof coverage.discoveryCoverage === "number"
      ? coverage.discoveryCoverage
      : (coverage.discoveryCoverage?.percentage ?? coverage.discoveryCoverage?.coveragePercent ?? 0);
  const discCrawledCount =
    typeof coverage.discoveryCoverage === "object" && coverage.discoveryCoverage !== null
      ? (coverage.discoveryCoverage.crawledPagesCount ?? totalCrawledPages)
      : totalCrawledPages;
  const discWithScenCount =
    typeof coverage.discoveryCoverage === "object" && coverage.discoveryCoverage !== null
      ? (coverage.discoveryCoverage.pagesWithScenariosCount ?? pagesWithScenarios)
      : pagesWithScenarios;

  const scenGenCases =
    coverage.scenarioGenerationCoverage?.approvedGeneratedCases ??
    coverage.scenarioGenerationCoverage?.generatedScenarios ??
    0;
  const scenPlanCases =
    coverage.scenarioGenerationCoverage?.totalGeneratedCases ??
    coverage.scenarioGenerationCoverage?.plannedScenarios ??
    0;
  const scenCovPct =
    coverage.scenarioGenerationCoverage?.percentage ??
    coverage.scenarioGenerationCoverage?.coveragePercent ??
    0;

  const approvedCases =
    coverage.approvalCoverage?.approvedTestCases ??
    coverage.approvalCoverage?.combined?.approved ??
    coverage.approvalCoverage?.web?.approved ??
    0;
  const totalCases =
    coverage.approvalCoverage?.totalTestCases ??
    coverage.approvalCoverage?.combined?.total ??
    coverage.approvalCoverage?.web?.total ??
    0;
  const approvalPct =
    coverage.approvalCoverage?.percentage ??
    coverage.approvalCoverage?.combined?.percent ??
    (totalCases > 0 ? (approvedCases / totalCases) * 100 : 0);

  const webLifeApproved =
    coverage.executionCoverage?.web?.lifetimeApprovedCases ??
    coverage.executionCoverage?.web?.approvedEligible ??
    0;
  const webLifeExecuted =
    coverage.executionCoverage?.web?.lifetimeExecutedCases ??
    coverage.executionCoverage?.web?.uniqueConclusiveLifetime ??
    0;
  const webLifePct =
    coverage.executionCoverage?.web?.lifetimePercentage ??
    coverage.executionCoverage?.web?.lifetimeCoveragePercent ??
    0;

  const webLatestApproved =
    coverage.executionCoverage?.web?.latestRunApprovedCases ??
    coverage.executionCoverage?.web?.approvedEligible ??
    0;
  const webLatestExecuted =
    coverage.executionCoverage?.web?.latestRunExecutedCases ??
    coverage.executionCoverage?.web?.uniqueConclusiveLatestRun ??
    0;
  const webLatestPct =
    coverage.executionCoverage?.web?.latestRunPercentage ??
    coverage.executionCoverage?.web?.latestRunCoveragePercent ??
    0;

  const apiLifeApproved =
    coverage.executionCoverage?.api?.lifetimeApprovedEndpoints ??
    coverage.executionCoverage?.api?.approvedEligible ??
    0;
  const apiLifeExecuted =
    coverage.executionCoverage?.api?.lifetimeExecutedEndpoints ??
    coverage.executionCoverage?.api?.uniqueConclusiveLifetime ??
    0;
  const apiLifePct =
    coverage.executionCoverage?.api?.lifetimePercentage ??
    coverage.executionCoverage?.api?.lifetimeCoveragePercent ??
    0;

  const apiLatestApproved =
    coverage.executionCoverage?.api?.latestRunApprovedEndpoints ??
    coverage.executionCoverage?.api?.approvedEligible ??
    0;
  const apiLatestExecuted =
    coverage.executionCoverage?.api?.latestRunExecutedEndpoints ??
    coverage.executionCoverage?.api?.uniqueConclusiveLatestRun ??
    0;
  const apiLatestPct =
    coverage.executionCoverage?.api?.latestRunPercentage ??
    coverage.executionCoverage?.api?.latestRunCoveragePercent ??
    0;

  // Category coverage array
  const categoryList: Array<{
    category: string;
    totalCases: number;
    executedCases: number;
    passedCases: number;
    percentage: number;
  }> = Array.isArray(coverage.categoryCoverage?.categories)
    ? coverage.categoryCoverage.categories
    : Object.entries(coverage.categoryCoverage || {})
        .filter(([k]) => k !== "categories")
        .map(([k, v]: [string, any]) => ({
          category: k,
          totalCases: v?.planned ?? 0,
          executedCases: v?.generated ?? 0,
          passedCases: v?.generated ?? 0,
          percentage: v?.percent ?? 0,
        }));

  // Execution Telemetry
  const webTotal = execution.web?.totalTests ?? 0;
  const webPassed = execution.web?.passedTests ?? 0;
  const webFailed = execution.web?.failedTests ?? 0;
  const webPassRate = execution.web?.passRate ?? 0;
  const webLatestPassRate = execution.web?.latestRunPassRate;
  const webLatestRunId = execution.web?.latestRunId;

  const apiTotal = execution.api?.totalTests ?? 0;
  const apiPassed = execution.api?.passedTests ?? 0;
  const apiFailed = execution.api?.failedTests ?? 0;
  const apiPassRate = execution.api?.passRate ?? 0;
  const apiLatestPassRate = execution.api?.latestRunPassRate;
  const apiLatestRunId = execution.api?.latestRunId;

  const lifetimeRuns = execution.summary?.totalRuns ?? 0;
  const lifetimePassRate = execution.summary?.passRate ?? 0;

  // AI Usage
  const aiCostUsd = aiUsage.totalEstimatedCostUsd ?? aiUsage.totals?.estimatedCostUsd ?? 0;
  const aiSavedUsd = aiUsage.cacheSavings?.estimatedDollarsSavedUsd ?? aiUsage.totals?.savedCostUsd ?? 0;
  const aiCacheHits = aiUsage.cacheSavings?.totalHits ?? 0;
  const aiTokensSaved = aiUsage.cacheSavings?.tokensSaved ?? aiUsage.totals?.savedTokens ?? 0;
  const aiInvocations = aiUsage.totalInvocations ?? aiUsage.totals?.totalCalls ?? 0;
  const aiTotalTokens = aiUsage.totalTokens ?? aiUsage.totals?.totalTokens ?? 0;
  const aiPromptTokens = aiUsage.totalPromptTokens ?? aiUsage.totals?.promptTokens ?? 0;
  const aiCompletionTokens = aiUsage.totalCompletionTokens ?? aiUsage.totals?.completionTokens ?? 0;
  const aiProviders = Array.isArray(aiUsage.providers) ? aiUsage.providers : [];

  // Discovery Pages list
  const discoveryPages = discoveryData?.pages || discovery.pages || [];

  const getHealthBadgeClass = (h: string) => {
    switch (h) {
      case "HEALTHY":
        return "badge approved";
      case "NEEDS_ATTENTION":
        return "badge pending";
      case "AT_RISK":
        return "badge rejected";
      default:
        return "badge";
    }
  };

  const getClassificationBadge = (c: string) => {
    switch (c) {
      case "application_defect":
        return { label: "App Defect", bg: "#fde8e7", color: "#a13232" };
      case "authentication_failure":
        return { label: "Auth Failure", bg: "#ffe4e6", color: "#be123c" };
      case "network_failure":
        return { label: "Network Timeout", bg: "#ffedd5", color: "#c2410c" };
      case "infrastructure_failure":
        return { label: "Infra / Browser", bg: "#ede9fe", color: "#6d28d9" };
      case "script_or_selector_failure":
        return { label: "Script / Selector", bg: "#e0f2fe", color: "#0369a1" };
      case "flaky_failure":
        return { label: "Flaky Test", bg: "#fef3c7", color: "#b45309" };
      case "inconclusive_result":
        return { label: "Inconclusive", bg: "#f1f5f9", color: "#475569" };
      default:
        return { label: "Unclassified", bg: "#e2e8f0", color: "#334155" };
    }
  };

  return (
    <div className="tab-content reports-dashboard">
      {/* Top Header & Export Action Bar */}
      <div className="section-heading" style={{ flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2>Executive QA Telemetry & Audit Reports</h2>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            Deterministic health governance, 5-tier test coverage, canonical discovery, and AI cost telemetry.
          </p>
        </div>
        <div className="actions" style={{ flexWrap: "wrap" }}>
          <button
            type="button"
            className="secondary"
            onClick={handlePrintPdf}
            title="Open printable standalone report with print stylesheet"
          >
            🖨️ Print / Save as PDF
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => handleDownloadFile("html", "summary")}
            disabled={exportingFormat === "html-summary"}
          >
            {exportingFormat === "html-summary" ? "Exporting..." : "🌐 Download HTML"}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => handleDownloadFile("csv", "execution")}
            disabled={exportingFormat === "csv-execution"}
          >
            {exportingFormat === "csv-execution" ? "Exporting..." : "📊 Export CSV"}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => handleDownloadFile("json", "summary")}
            disabled={exportingFormat === "json-summary"}
          >
            {exportingFormat === "json-summary" ? "Exporting..." : "📋 Export JSON"}
          </button>
        </div>
      </div>

      {/* Navigation Sub-Tabs */}
      <div className="tabs" style={{ margin: "12px 0 16px" }}>
        <button
          className={activeSubView === "summary" ? "active" : ""}
          onClick={() => setActiveSubView("summary")}
        >
          Executive Summary
        </button>
        <button
          className={activeSubView === "coverage" ? "active" : ""}
          onClick={() => setActiveSubView("coverage")}
        >
          5-Tier Coverage
        </button>
        <button
          className={activeSubView === "execution" ? "active" : ""}
          onClick={() => setActiveSubView("execution")}
        >
          Telemetry (Web vs API)
        </button>
        <button
          className={activeSubView === "failures" ? "active" : ""}
          onClick={() => setActiveSubView("failures")}
        >
          Failure Analysis ({failures.length})
        </button>
        <button
          className={activeSubView === "discovery" ? "active" : ""}
          onClick={() => setActiveSubView("discovery")}
        >
          Canonical Discovery ({totalCrawledPages})
        </button>
        <button
          className={activeSubView === "ai" ? "active" : ""}
          onClick={() => setActiveSubView("ai")}
        >
          AI Usage & Cost
        </button>
      </div>

      {/* 1. EXECUTIVE SUMMARY VIEW */}
      {activeSubView === "summary" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Health Status Banner Card */}
          <div
            className="card"
            style={{
              borderLeft:
                overallHealth === "HEALTHY"
                  ? "6px solid #16a34a"
                  : overallHealth === "NEEDS_ATTENTION"
                  ? "6px solid #d97706"
                  : overallHealth === "AT_RISK"
                  ? "6px solid #dc2626"
                  : "6px solid #64748b",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span
                  style={{
                    fontSize: "1.2rem",
                    fontWeight: 700,
                  }}
                >
                  Overall Project Health:
                </span>
                <span
                  className={getHealthBadgeClass(overallHealth)}
                  style={{ fontSize: "1rem", padding: "4px 14px" }}
                >
                  {overallHealth.replace(/_/g, " ")}
                </span>
              </div>
              <span className="muted" style={{ fontSize: "0.85rem" }}>
                Evaluated: {new Date(evaluatedAt).toLocaleString()}
              </span>
            </div>

            <div style={{ marginTop: 10 }}>
              <strong>Precedence Rules & Health Evaluation Factors:</strong>
              <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
                {reasons.length > 0 ? (
                  reasons.map((r, i) => (
                    <li key={i} style={{ color: "#334155", fontSize: "0.92rem", marginBottom: 3 }}>
                      {r}
                    </li>
                  ))
                ) : (
                  <li style={{ color: "#64748b", fontSize: "0.92rem" }}>No health factors reported.</li>
                )}
              </ul>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 12,
                marginTop: 14,
                paddingTop: 12,
                borderTop: "1px solid #e2e8f0",
              }}
            >
              <div>
                <span className="muted">Web Health:</span>{" "}
                <span className={getHealthBadgeClass(webHealthStatus)}>
                  {webHealthStatus.replace(/_/g, " ")}
                </span>
              </div>
              <div>
                <span className="muted">API Health:</span>{" "}
                <span className={getHealthBadgeClass(apiHealthStatus)}>
                  {apiHealthStatus.replace(/_/g, " ")}
                </span>
              </div>
              <div>
                <span className="muted">Confirmed Critical/High:</span>{" "}
                <strong>{confirmedCritHigh}</strong>
              </div>
              <div>
                <span className="muted">Suspected (Pending Triage):</span>{" "}
                <strong style={{ color: "#b45309" }}>{suspectedTotal}</strong>
              </div>
            </div>
          </div>

          {/* Quick Metric KPI Cards */}
          <div className="cards" style={{ marginTop: 0 }}>
            <div className="card">
              <span className="muted">Canonical Pages Discovered</span>
              <strong style={{ fontSize: "1.6rem", color: "#17324d" }}>
                {totalCrawledPages}
              </strong>
              <span>
                {pagesWithScenarios} pages covered with scenarios (
                {discCovPct.toFixed(1)}%)
              </span>
            </div>

            <div className="card">
              <span className="muted">Test Cases (Approved / Total)</span>
              <strong style={{ fontSize: "1.6rem", color: "#17324d" }}>
                {approvedCases} / {totalCases}
              </strong>
              <span>{approvalPct.toFixed(1)}% test case approval rate</span>
            </div>

            <div className="card">
              <span className="muted">Latest Execution Pass Rate</span>
              <div style={{ display: "flex", gap: 12, alignItems: "baseline", marginTop: 4 }}>
                <div>
                  <span style={{ fontSize: "0.85rem", color: "#64748b" }}>Web: </span>
                  <strong style={{ fontSize: "1.2rem", color: "#16a34a" }}>
                    {webLatestPassRate !== null && webLatestPassRate !== undefined
                      ? `${webLatestPassRate.toFixed(1)}%`
                      : "N/A"}
                  </strong>
                </div>
                <div>
                  <span style={{ fontSize: "0.85rem", color: "#64748b" }}>API: </span>
                  <strong style={{ fontSize: "1.2rem", color: "#16a34a" }}>
                    {apiLatestPassRate !== null && apiLatestPassRate !== undefined
                      ? `${apiLatestPassRate.toFixed(1)}%`
                      : "N/A"}
                  </strong>
                </div>
              </div>
              <span style={{ marginTop: 4 }}>
                Lifetime pass rate: {lifetimePassRate.toFixed(1)}% across {lifetimeRuns} runs
              </span>
            </div>

            <div className="card">
              <span className="muted">AI Cost & Optimization</span>
              <strong style={{ fontSize: "1.6rem", color: "#17324d" }}>
                ${aiCostUsd.toFixed(4)}
              </strong>
              <span style={{ color: "#16a34a" }}>
                ${aiSavedUsd.toFixed(4)} saved via AI cache ({aiCacheHits} hits)
              </span>
            </div>
          </div>

          {/* Defect Breakdown Section */}
          <div className="card">
            <h3>Defect Classification & QA Triage</h3>
            <p className="muted" style={{ margin: "2px 0 12px" }}>
              Deterministic health degradation applies strictly to confirmed product defects. Suspected AI-identified
              defects require QA verification before altering project health.
            </p>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                gap: 16,
              }}
            >
              <div style={{ border: "1px solid #dbe2ea", borderRadius: 8, padding: 14 }}>
                <h4 style={{ margin: "0 0 8px", color: "#be123c" }}>
                  Confirmed Product Defects ({confirmedTotal})
                </h4>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span className="badge badge-priority-critical">
                    Critical/High: {confirmedCritHigh}
                  </span>
                  <span className="badge badge-priority-medium">
                    Medium: {confirmedMed}
                  </span>
                  <span className="badge badge-priority-low">
                    Low: {confirmedLow}
                  </span>
                </div>
                <p style={{ fontSize: "0.82rem", color: "#64748b", marginTop: 8 }}>
                  Affects project health directly. Confirmed critical/high forces AT_RISK status.
                </p>
              </div>

              <div style={{ border: "1px solid #fed7aa", background: "#fffdf9", borderRadius: 8, padding: 14 }}>
                <h4 style={{ margin: "0 0 8px", color: "#c2410c" }}>
                  Suspected Defects Pending QA Triage ({suspectedTotal})
                </h4>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span className="badge pending">Critical/High: {suspectedCritHigh}</span>
                  <span className="badge pending">Medium: {suspectedMed}</span>
                  <span className="badge pending">Low: {suspectedLow}</span>
                </div>
                <p style={{ fontSize: "0.82rem", color: "#64748b", marginTop: 8 }}>
                  AI-identified potential defects awaiting human confirmation or dismissal.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 2. 5-TIER COVERAGE ENGINE VIEW */}
      {activeSubView === "coverage" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card">
            <h3>5-Tier Comprehensive Coverage Engine</h3>
            <p className="muted" style={{ margin: "4px 0 16px" }}>
              Separates web UI tests from API endpoints to guarantee accurate denominators and eliminate entity collision.
            </p>

            <table className="data-table">
              <thead>
                <tr>
                  <th>Coverage Tier</th>
                  <th>Numerator / Denominator</th>
                  <th>Coverage Rate</th>
                  <th>Target Benchmark</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <strong>Tier 1: Canonical Discovery</strong>
                    <div className="muted" style={{ fontSize: "0.8rem" }}>
                      Pages with scenarios vs total crawled URLs
                    </div>
                  </td>
                  <td>
                    {discWithScenCount} / {discCrawledCount} pages
                  </td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <progress value={discCovPct} max={100} style={{ width: 100 }} />
                      <strong>{discCovPct.toFixed(1)}%</strong>
                    </div>
                  </td>
                  <td>&ge; 80.0%</td>
                </tr>

                <tr>
                  <td>
                    <strong>Tier 2: Scenario Generation</strong>
                    <div className="muted" style={{ fontSize: "0.8rem" }}>
                      Generated scenarios vs total planned scenarios
                    </div>
                  </td>
                  <td>
                    {scenGenCases} / {scenPlanCases} cases
                  </td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <progress value={scenCovPct} max={100} style={{ width: 100 }} />
                      <strong>{scenCovPct.toFixed(1)}%</strong>
                    </div>
                  </td>
                  <td>&ge; 70.0%</td>
                </tr>

                <tr>
                  <td>
                    <strong>Tier 3: Test Approval</strong>
                    <div className="muted" style={{ fontSize: "0.8rem" }}>
                      Approved test cases vs total defined cases
                    </div>
                  </td>
                  <td>
                    {approvedCases} / {totalCases} cases
                  </td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <progress value={approvalPct} max={100} style={{ width: 100 }} />
                      <strong>{approvalPct.toFixed(1)}%</strong>
                    </div>
                  </td>
                  <td>&ge; 85.0%</td>
                </tr>

                <tr>
                  <td>
                    <strong>Tier 4A: Web Execution (Lifetime)</strong>
                    <div className="muted" style={{ fontSize: "0.8rem" }}>
                      Lifetime executed web cases vs approved web cases
                    </div>
                  </td>
                  <td>
                    {webLifeExecuted} / {webLifeApproved} cases
                  </td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <progress value={webLifePct} max={100} style={{ width: 100 }} />
                      <strong>{webLifePct.toFixed(1)}%</strong>
                    </div>
                  </td>
                  <td>&ge; 90.0%</td>
                </tr>

                <tr>
                  <td>
                    <strong>Tier 4B: Web Execution (Latest Run)</strong>
                    <div className="muted" style={{ fontSize: "0.8rem" }}>
                      Latest completed web run execution coverage
                    </div>
                  </td>
                  <td>
                    {webLatestExecuted} / {webLatestApproved} cases
                  </td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <progress value={webLatestPct} max={100} style={{ width: 100 }} />
                      <strong>{webLatestPct.toFixed(1)}%</strong>
                    </div>
                  </td>
                  <td>&ge; 90.0%</td>
                </tr>

                <tr>
                  <td>
                    <strong>Tier 4C: API Execution (Lifetime)</strong>
                    <div className="muted" style={{ fontSize: "0.8rem" }}>
                      Lifetime executed endpoints vs approved endpoints
                    </div>
                  </td>
                  <td>
                    {apiLifeExecuted} / {apiLifeApproved} endpoints
                  </td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <progress value={apiLifePct} max={100} style={{ width: 100 }} />
                      <strong>{apiLifePct.toFixed(1)}%</strong>
                    </div>
                  </td>
                  <td>&ge; 90.0%</td>
                </tr>

                <tr>
                  <td>
                    <strong>Tier 4D: API Execution (Latest Run)</strong>
                    <div className="muted" style={{ fontSize: "0.8rem" }}>
                      Latest completed API run execution coverage
                    </div>
                  </td>
                  <td>
                    {apiLatestExecuted} / {apiLatestApproved} endpoints
                  </td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <progress value={apiLatestPct} max={100} style={{ width: 100 }} />
                      <strong>{apiLatestPct.toFixed(1)}%</strong>
                    </div>
                  </td>
                  <td>&ge; 90.0%</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Tier 5: Category Coverage */}
          <div className="card">
            <h3>Tier 5: Category Coverage Distribution</h3>
            <p className="muted" style={{ margin: "4px 0 14px" }}>
              Tracks execution and pass rates across Positive, Negative, Boundary, Edge-case, and Security test categories.
            </p>
            {categoryList.length === 0 ? (
              <div className="notice">No scenario category breakdown available yet.</div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
                {categoryList.map((cat) => (
                  <div key={cat.category} style={{ border: "1px solid #dbe2ea", borderRadius: 8, padding: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span className="badge" style={{ textTransform: "uppercase", fontWeight: 700 }}>
                        {cat.category}
                      </span>
                      <strong>{cat.percentage.toFixed(0)}%</strong>
                    </div>
                    <div style={{ marginTop: 8, fontSize: "0.85rem", color: "#475569" }}>
                      <div>Executed: {cat.executedCases} / {cat.totalCases}</div>
                      <div>Passed: {cat.passedCases}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 3. EXECUTION TELEMETRY VIEW (WEB VS API) */}
      {activeSubView === "execution" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card">
            <h3>Domain-Separated Execution Telemetry</h3>
            <p className="muted" style={{ margin: "4px 0 16px" }}>
              Web browser interactions and API HTTP assertions are executed independently to prevent false correlations.
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 18 }}>
              {/* Web UI Execution */}
              <div style={{ border: "1px solid #dbe2ea", borderRadius: 8, padding: 16 }}>
                <h4 style={{ margin: "0 0 12px", color: "#17324d", display: "flex", alignItems: "center", gap: 8 }}>
                  🌐 Web UI Playwright Tests
                </h4>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div>
                    <span className="muted">Total Tests Executed:</span> <strong>{webTotal}</strong>
                  </div>
                  <div>
                    <span className="muted">Passed Tests:</span>{" "}
                    <strong style={{ color: "#16a34a" }}>{webPassed}</strong>
                  </div>
                  <div>
                    <span className="muted">Failed Tests:</span>{" "}
                    <strong style={{ color: "#dc2626" }}>{webFailed}</strong>
                  </div>
                  <div>
                    <span className="muted">Lifetime Pass Rate:</span>{" "}
                    <strong>{webPassRate.toFixed(1)}%</strong>
                  </div>
                  <div style={{ paddingTop: 8, borderTop: "1px solid #e2e8f0" }}>
                    <span className="muted">Latest Run Pass Rate:</span>{" "}
                    <strong>
                      {webLatestPassRate !== null && webLatestPassRate !== undefined
                        ? `${webLatestPassRate.toFixed(1)}%`
                        : "No completed runs"}
                    </strong>
                  </div>
                  {webLatestRunId && (
                    <div style={{ fontSize: "0.8rem", color: "#64748b" }}>
                      Run ID: {webLatestRunId}
                    </div>
                  )}
                </div>
              </div>

              {/* API Execution */}
              <div style={{ border: "1px solid #dbe2ea", borderRadius: 8, padding: 16 }}>
                <h4 style={{ margin: "0 0 12px", color: "#17324d", display: "flex", alignItems: "center", gap: 8 }}>
                  ⚡ API Endpoint Assertions
                </h4>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div>
                    <span className="muted">Total Endpoints Executed:</span> <strong>{apiTotal}</strong>
                  </div>
                  <div>
                    <span className="muted">Passed Assertions:</span>{" "}
                    <strong style={{ color: "#16a34a" }}>{apiPassed}</strong>
                  </div>
                  <div>
                    <span className="muted">Failed Assertions:</span>{" "}
                    <strong style={{ color: "#dc2626" }}>{apiFailed}</strong>
                  </div>
                  <div>
                    <span className="muted">Lifetime Pass Rate:</span>{" "}
                    <strong>{apiPassRate.toFixed(1)}%</strong>
                  </div>
                  <div style={{ paddingTop: 8, borderTop: "1px solid #e2e8f0" }}>
                    <span className="muted">Latest Run Pass Rate:</span>{" "}
                    <strong>
                      {apiLatestPassRate !== null && apiLatestPassRate !== undefined
                        ? `${apiLatestPassRate.toFixed(1)}%`
                        : "No completed runs"}
                    </strong>
                  </div>
                  {apiLatestRunId && (
                    <div style={{ fontSize: "0.8rem", color: "#64748b" }}>
                      Run ID: {apiLatestRunId}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 4. DETERMINISTIC FAILURE ANALYSIS VIEW */}
      {activeSubView === "failures" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card">
            <h3>Evidence-Based Failure Classification</h3>
            <p className="muted" style={{ margin: "4px 0 16px" }}>
              Classified deterministically using strict hierarchy: Inconclusive &rarr; Flaky &rarr; Auth check &rarr;
              Network &rarr; Infrastructure &rarr; Application Defect &rarr; Script/Selector. AI suggestions are explicitly labeled.
            </p>

            {failures.length === 0 ? (
              <div className="notice">No test failures recorded for this project.</div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Domain</th>
                    <th>Test / Endpoint</th>
                    <th>Classification</th>
                    <th>Confidence</th>
                    <th>Error Context & AI Suggestion</th>
                    <th>Executed At</th>
                  </tr>
                </thead>
                <tbody>
                  {failures.map((f) => {
                    const badge = getClassificationBadge(f.classification);
                    return (
                      <tr key={f.resultId}>
                        <td>
                          <span className="badge" style={{ textTransform: "uppercase" }}>
                            {f.executionDomain}
                          </span>
                        </td>
                        <td>
                          <strong>{f.testName}</strong>
                          {f.testCaseId && (
                            <div className="muted" style={{ fontSize: "0.78rem" }}>
                              Case: {f.testCaseId.slice(0, 8)}...
                            </div>
                          )}
                        </td>
                        <td>
                          <span
                            style={{
                              display: "inline-block",
                              padding: "3px 8px",
                              borderRadius: 4,
                              background: badge.bg,
                              color: badge.color,
                              fontWeight: 600,
                              fontSize: "0.82rem",
                            }}
                          >
                            {badge.label}
                          </span>
                        </td>
                        <td>
                          <strong>
                            {f.confidenceScore !== undefined ? `${(f.confidenceScore * 100).toFixed(0)}%` : "N/A"}
                          </strong>
                        </td>
                        <td style={{ maxWidth: 360 }}>
                          <div
                            style={{
                              fontFamily: "monospace",
                              fontSize: "0.8rem",
                              color: "#be123c",
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word",
                            }}
                          >
                            {(f.errorMessage || "").slice(0, 160)}
                            {(f.errorMessage || "").length > 160 ? "..." : ""}
                          </div>
                          {f.aiSuggestedAction && (
                            <div
                              style={{
                                marginTop: 6,
                                padding: 6,
                                background: "#f8fafc",
                                borderLeft: "3px solid #3b82f6",
                                fontSize: "0.78rem",
                                color: "#1e293b",
                              }}
                            >
                              <strong>AI Suggestion (Verify with QA):</strong> {f.aiSuggestedAction}
                            </div>
                          )}
                        </td>
                        <td style={{ fontSize: "0.8rem", color: "#64748b", whiteSpace: "nowrap" }}>
                          {new Date(f.executedAt).toLocaleString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* 5. CANONICAL WEBSITE DISCOVERY VIEW */}
      {activeSubView === "discovery" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card">
            <h3>Canonical Website Discovery</h3>
            <p className="muted" style={{ margin: "4px 0 16px" }}>
              Deduplicated canonical URLs identified by autonomous crawler using standard URL normalization.
            </p>

            {discoveryPages.length === 0 ? (
              <div className="notice">
                No canonical discovery pages recorded yet. Run a discovery crawl from the Automations tab to explore and index target pages.
              </div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Canonical URL</th>
                    <th>Crawl Depth</th>
                    <th>Status</th>
                    <th>Generated Scenarios</th>
                    <th>Crawled At</th>
                  </tr>
                </thead>
                <tbody>
                  {discoveryPages.map((p, idx) => (
                    <tr key={p.id || p.url || idx}>
                      <td>
                        <code style={{ fontSize: "0.85rem" }}>{p.url}</code>
                        {p.title && <div className="muted" style={{ fontSize: "0.8rem" }}>{p.title}</div>}
                      </td>
                      <td>{p.depth}</td>
                      <td>
                        <span className={`badge ${p.status === "visited" ? "approved" : p.status === "failed" ? "rejected" : "pending"}`}>
                          {p.status || "discovered"}
                        </span>
                      </td>
                      <td>
                        {(p.scenariosGenerated ?? 0) > 0 ? (
                          <span className="badge approved">{p.scenariosGenerated} scenarios</span>
                        ) : (
                          <span className="badge pending">0 scenarios</span>
                        )}
                      </td>
                      <td style={{ fontSize: "0.8rem", color: "#64748b" }}>
                        {p.crawledAt || p.createdAt ? new Date(p.crawledAt || p.createdAt || "").toLocaleString() : "N/A"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* 6. AI USAGE & COST VIEW */}
      {activeSubView === "ai" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card">
            <h3>AI Usage, Cost Telemetry & Optimization</h3>
            <p className="muted" style={{ margin: "4px 0 16px" }}>
              Separates local inference (e.g. Ollama, cost $0.00) from commercial API calls, and measures cache savings.
            </p>

            <div className="cards" style={{ marginTop: 0 }}>
              <div className="card">
                <span className="muted">Total AI Invocations</span>
                <strong style={{ fontSize: "1.5rem" }}>{aiInvocations}</strong>
              </div>
              <div className="card">
                <span className="muted">Total Tokens Consumed</span>
                <strong style={{ fontSize: "1.5rem" }}>{aiTotalTokens.toLocaleString()}</strong>
                <span style={{ fontSize: "0.8rem" }}>
                  Prompt: {aiPromptTokens.toLocaleString()} | Completion: {aiCompletionTokens.toLocaleString()}
                </span>
              </div>
              <div className="card">
                <span className="muted">Total Estimated Cost</span>
                <strong style={{ fontSize: "1.5rem", color: "#17324d" }}>
                  ${aiCostUsd.toFixed(4)}
                </strong>
              </div>
              <div className="card">
                <span className="muted">Cache Dollars Saved</span>
                <strong style={{ fontSize: "1.5rem", color: "#16a34a" }}>
                  ${aiSavedUsd.toFixed(4)}
                </strong>
                <span style={{ fontSize: "0.8rem" }}>
                  {aiCacheHits} cache hits ({aiTokensSaved.toLocaleString()} tokens)
                </span>
              </div>
            </div>

            <h4 style={{ margin: "20px 0 8px" }}>Provider & Model Breakdown</h4>
            {aiProviders.length === 0 ? (
              <div className="notice">No AI token usage logs recorded yet for this project.</div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Model</th>
                    <th>Environment</th>
                    <th>Invocations</th>
                    <th>Tokens</th>
                    <th>Estimated Cost (USD)</th>
                  </tr>
                </thead>
                <tbody>
                  {aiProviders.map((p, idx) => (
                    <tr key={idx}>
                      <td><strong>{p.provider}</strong></td>
                      <td><code>{p.model}</code></td>
                      <td>
                        {p.isLocal ? (
                          <span className="badge approved">Local ($0.00)</span>
                        ) : (
                          <span className="badge">Commercial Cloud</span>
                        )}
                      </td>
                      <td>{p.invocations}</td>
                      <td>{p.tokens.toLocaleString()}</td>
                      <td>${p.costUsd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
