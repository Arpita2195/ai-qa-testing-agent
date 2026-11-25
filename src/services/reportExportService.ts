import {
  type ExecutiveSummaryReport,
  type CoverageReport,
  type ClassifiedFailure,
  type AiUsageReport,
} from "./reportingService";

// ============================================================================
// CSV Export Engine with Strict Numeric Trust & Formula Injection Protection
// ============================================================================

export type CsvColumnType = "trusted_numeric" | "text" | "date" | "boolean";

export interface CsvColumnDefinition<T> {
  header: string;
  key: keyof T | ((row: T) => unknown);
  type: CsvColumnType;
}

const FORMULA_TRIGGER_REGEX = /^[=\+\-@\t\r]/;
const DANGEROUS_CONTROL_CHARS_REGEX = /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g;
const STRICT_NUMERIC_PATTERN = /^-?\d+(\.\d+)?$/;

/**
 * Validates and formats explicitly identified trusted numeric database columns.
 * Emits bare numbers (preserving legitimate negative numbers and decimals).
 * Strictly throws TypeError on invalid or non-numeric input.
 */
export function formatTrustedNumeric(val: unknown, columnHeader = "numeric_col"): string {
  if (val === null || val === undefined) {
    return "";
  }

  let num: number;
  if (typeof val === "number") {
    if (!Number.isFinite(val)) {
      throw new TypeError(
        `Invalid numeric value in trusted_numeric column "${columnHeader}": non-finite number ${val}`
      );
    }
    num = val;
  } else if (typeof val === "string") {
    const trimmed = val.trim();
    if (!STRICT_NUMERIC_PATTERN.test(trimmed)) {
      throw new TypeError(
        `Invalid numeric string in trusted_numeric column "${columnHeader}": "${val}"`
      );
    }
    num = Number(trimmed);
    if (!Number.isFinite(num)) {
      throw new TypeError(`Failed to parse trusted_numeric column "${columnHeader}": "${val}"`);
    }
  } else {
    throw new TypeError(
      `Unexpected data type in trusted_numeric column "${columnHeader}": ${typeof val}`
    );
  }

  return num.toString();
}

/**
 * Sanitizes untrusted text cells against CSV spreadsheet formula injection.
 * Triggers on =, +, -, @, \t, \r after stripping leading whitespace and control characters.
 * Ordinary text starting with %, |, or \ is NOT prefixed with an apostrophe.
 */
export function formatTextCell(raw: unknown): string {
  if (raw === null || raw === undefined) {
    return "";
  }

  const str = String(raw).replace(DANGEROUS_CONTROL_CHARS_REGEX, "");
  const trimmedStart = str.trimStart();

  let needsPrefix = false;
  if (FORMULA_TRIGGER_REGEX.test(str) || FORMULA_TRIGGER_REGEX.test(trimmedStart)) {
    needsPrefix = true;
  }

  const content = needsPrefix ? `'${str}` : str;
  const needsQuotes =
    content.includes(",") ||
    content.includes('"') ||
    content.includes("\n");

  const escaped = content.replace(/"/g, '""');
  return needsQuotes ? `"${escaped}"` : escaped;
}

/**
 * Generates an RFC 4180 compliant CSV string from an array of objects.
 */
export function exportToCsv<T>(
  first: T[] | CsvColumnDefinition<T>[],
  second: CsvColumnDefinition<T>[] | T[]
): string {
  let data: T[];
  let columns: CsvColumnDefinition<T>[];
  if (Array.isArray(first) && first.length > 0 && typeof (first[0] as any) === "object" && (first[0] as any) !== null && "header" in (first[0] as any)) {
    columns = first as CsvColumnDefinition<T>[];
    data = (second as T[]) || [];
  } else {
    data = (first as T[]) || [];
    columns = (second as CsvColumnDefinition<T>[]) || [];
  }

  const headerRow = columns
    .map((c) => {
      const h = c.header.replace(/"/g, '""');
      return h.includes(",") || h.includes('"') ? `"${h}"` : h;
    })
    .join(",");

  const rows = data.map((item) => {
    return columns
      .map((col) => {
        const val = typeof col.key === "function" ? col.key(item) : item[col.key];
        const colType = String(col.type).toLowerCase();

        if (colType === "trusted_numeric" || colType === "numeric") {
          return formatTrustedNumeric(val, col.header);
        } else if (colType === "boolean") {
          return val === null || val === undefined ? "" : Boolean(val) ? "true" : "false";
        } else if (colType === "date") {
          if (!val) return "";
          const d = val instanceof Date ? val : new Date(String(val));
          return isNaN(d.getTime()) ? formatTextCell(val) : d.toISOString();
        } else {
          return formatTextCell(val);
        }
      })
      .join(",");
  });

  return [headerRow, ...rows].join("\n");
}

// ============================================================================
// HTML Entity Escaping (Cross-Site Scripting Prevention)
// ============================================================================

export function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ============================================================================
// Standalone Self-Contained HTML Report Generator
// ============================================================================

export function generateStandaloneHtmlReport(input: any): string {
  const summary: any = input.summary || input;
  const coverage: any = input.coverage || summary.coverage || {};
  const failures: any[] = input.failures || summary.failures || [];
  const aiUsage: any = input.aiUsage || summary.aiUsage || {};

  const overallStatus =
    summary.health?.overallStatus ||
    summary.health?.overallHealth ||
    "HEALTHY";

  const healthColor =
    overallStatus === "HEALTHY"
      ? "#10b981"
      : overallStatus === "NEEDS_ATTENTION"
      ? "#f59e0b"
      : overallStatus === "AT_RISK"
      ? "#ef4444"
      : "#64748b";

  const projectName = summary.projectName || "Project";
  const baseUrl = summary.baseUrl || "";
  const generatedAt = summary.generatedAt || new Date().toISOString();
  const label = summary.health?.label || overallStatus;
  const reasons: string[] = summary.health?.reasons || [];

  const confirmedCritHigh =
    summary.defects?.confirmed?.critical_high ??
    ((summary.defects?.confirmedDefects?.critical || 0) + (summary.defects?.confirmedDefects?.high || 0));
  const confirmedMedium =
    summary.defects?.confirmed?.medium ??
    (summary.defects?.confirmedDefects?.medium || 0);
  const confirmedLow =
    summary.defects?.confirmed?.low ??
    (summary.defects?.confirmedDefects?.low || 0);

  const suspectedTotal =
    summary.defects?.suspected?.total ??
    (summary.defects?.suspectedDefects?.total || 0);
  const suspectedCritHigh =
    summary.defects?.suspected?.critical_high ??
    ((summary.defects?.suspectedDefects?.critical || 0) + (summary.defects?.suspectedDefects?.high || 0));

  const conclusiveCoverage =
    summary.coverage?.lifetimeConclusiveExecutionCoverage ??
    summary.coverage?.executionCoverage?.web?.lifetimePercentage ??
    coverage?.executionCoverage?.web?.lifetimePercentage ??
    0;

  const totalCost = summary.aiUsage?.totalEstimatedCostUsd ?? aiUsage?.totalEstimatedCostUsd ?? 0;
  const totalTokens = summary.aiUsage?.totalTokens ?? aiUsage?.totalTokens ?? 0;
  const totalSavedTokens =
    summary.aiUsage?.totalSavedTokens ??
    summary.aiUsage?.cacheSavings?.tokensSaved ??
    aiUsage?.cacheSavings?.tokensSaved ??
    0;
  const totalSavedCost =
    summary.aiUsage?.totalSavedCostUsd ??
    summary.aiUsage?.cacheSavings?.estimatedDollarsSavedUsd ??
    aiUsage?.cacheSavings?.estimatedDollarsSavedUsd ??
    0;

  const webHealth =
    typeof summary.health?.webHealth === "object" && summary.health?.webHealth !== null
      ? summary.health.webHealth
      : {
          status: summary.health?.webHealth || "NOT_EVALUATED",
          passRate: summary.execution?.web?.latestRunPassRate ?? summary.execution?.web?.passRate ?? null,
          flakyRate: null,
          conclusiveCoverage: summary.execution?.web?.passRate ?? null,
          passedResults: summary.execution?.web?.passedTests ?? 0,
          failedResults: summary.execution?.web?.failedTests ?? 0,
        };

  const apiHealth =
    typeof summary.health?.apiHealth === "object" && summary.health?.apiHealth !== null
      ? summary.health.apiHealth
      : {
          status: summary.health?.apiHealth || "NOT_EVALUATED",
          passRate: summary.execution?.api?.latestRunPassRate ?? summary.execution?.api?.passRate ?? null,
          flakyRate: null,
          conclusiveCoverage: summary.execution?.api?.passRate ?? null,
          passedResults: summary.execution?.api?.passedTests ?? 0,
          failedResults: summary.execution?.api?.failedTests ?? 0,
        };

  const providersList = Array.isArray(aiUsage?.byProvider)
    ? aiUsage.byProvider
    : Array.isArray(aiUsage?.providers)
    ? aiUsage.providers
    : [];

  const discCovPercent =
    coverage.discoveryCoverage?.coveragePercent ??
    coverage.discoveryCoverage?.percentage ??
    summary.coverage?.discoveryCoverage ??
    0;
  const discVisited =
    coverage.discoveryCoverage?.visitedPages ??
    coverage.discoveryCoverage?.crawledPagesCount ??
    summary.discovery?.visitedCount ??
    summary.discovery?.totalCrawledPages ??
    0;
  const discEligible =
    coverage.discoveryCoverage?.eligiblePages ??
    coverage.discoveryCoverage?.crawledPagesCount ??
    summary.discovery?.totalDiscovered ??
    summary.discovery?.totalCrawledPages ??
    0;

  const scenCovPercent =
    coverage.scenarioGenerationCoverage?.coveragePercent ??
    coverage.scenarioGenerationCoverage?.percentage ??
    summary.coverage?.scenarioCoverage ??
    0;
  const scenGen =
    coverage.scenarioGenerationCoverage?.generatedScenarios ??
    coverage.scenarioGenerationCoverage?.approvedGeneratedCases ??
    0;
  const scenPlanned =
    coverage.scenarioGenerationCoverage?.plannedScenarios ??
    coverage.scenarioGenerationCoverage?.totalGeneratedCases ??
    0;

  const apprvCovPercent =
    coverage.approvalCoverage?.combined?.percent ??
    coverage.approvalCoverage?.percentage ??
    summary.coverage?.combinedApprovalCoverage ??
    0;
  const apprvCount =
    coverage.approvalCoverage?.combined?.approved ??
    coverage.approvalCoverage?.approvedTestCases ??
    summary.executionTotals?.approvedTestCases ??
    0;
  const apprvTotal =
    coverage.approvalCoverage?.combined?.total ??
    coverage.approvalCoverage?.totalTestCases ??
    summary.executionTotals?.totalTestCases ??
    0;

  const webExecLifetimePercent =
    coverage.executionCoverage?.web?.lifetimeCoveragePercent ??
    coverage.executionCoverage?.web?.lifetimePercentage ??
    0;
  const webExecLatestPercent =
    coverage.executionCoverage?.web?.latestRunCoveragePercent ??
    coverage.executionCoverage?.web?.latestRunPercentage ??
    0;
  const webExecLatestRun =
    coverage.executionCoverage?.web?.uniqueConclusiveLatestRun ??
    coverage.executionCoverage?.web?.latestRunExecutedCases ??
    0;
  const webExecApproved =
    coverage.executionCoverage?.web?.approvedEligible ??
    coverage.executionCoverage?.web?.latestRunApprovedCases ??
    0;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Executive QA & Test Coverage Report - ${escapeHtml(summary.projectName)}</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #3b82f6;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
      line-height: 1.5;
      padding: 24px;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 24px;
    }
    .header h1 { font-size: 1.75rem; font-weight: 700; color: #fff; }
    .header p { color: var(--text-muted); font-size: 0.875rem; margin-top: 4px; }
    .btn-print {
      background: var(--primary);
      color: #fff;
      border: none;
      padding: 10px 18px;
      border-radius: 6px;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .btn-print:hover { opacity: 0.9; }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px 20px;
    }
    .card h3 { font-size: 0.875rem; color: var(--text-muted); font-weight: 600; text-transform: uppercase; }
    .card .value { font-size: 1.875rem; font-weight: 700; margin-top: 6px; color: #fff; }
    .card .subtitle { font-size: 0.75rem; color: var(--text-muted); margin-top: 4px; }
    .section-title { font-size: 1.25rem; font-weight: 700; margin: 28px 0 14px; color: #fff; border-left: 4px solid var(--primary); padding-left: 10px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 0.875rem; }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); }
    th { background: #1e293b; color: var(--text-muted); font-weight: 600; text-transform: uppercase; font-size: 0.75rem; }
    tr:hover { background: rgba(255, 255, 255, 0.02); }
    .progress-bar { background: #334155; height: 8px; border-radius: 4px; overflow: hidden; margin-top: 6px; }
    .progress-fill { height: 100%; background: var(--primary); border-radius: 4px; }
    .callout {
      background: rgba(59, 130, 246, 0.1);
      border: 1px solid rgba(59, 130, 246, 0.3);
      border-radius: 6px;
      padding: 12px 16px;
      margin-bottom: 20px;
      font-size: 0.875rem;
    }
    .reasons-list { list-style: disc; margin-left: 20px; margin-top: 8px; }

    /* Print Stylesheet for Browser-Native PDF Generation */
    @media print {
      body { background: #fff !important; color: #000 !important; padding: 0 !important; }
      .container { max-width: 100% !important; margin: 0 !important; }
      .no-print { display: none !important; }
      .card { border: 1px solid #ccc !important; background: #fff !important; color: #000 !important; break-inside: avoid; }
      .card .value { color: #000 !important; }
      th { background: #f1f5f9 !important; color: #000 !important; }
      td { border-bottom: 1px solid #ddd !important; color: #000 !important; }
      .page-break { page-break-before: always; }
      @page { size: A4 portrait; margin: 15mm; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <h1>Executive QA & Quality Telemetry Report</h1>
        <p>Project: <strong>${escapeHtml(projectName)}</strong> | Base URL: <code>${escapeHtml(
    baseUrl
  )}</code> | Generated: ${new Date(generatedAt).toLocaleString()}</p>
      </div>
      <div class="no-print">
        <button class="btn-print" onclick="window.print()">
          <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
            <path d="M2.5 8a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1z"/>
            <path d="M5 1a2 2 0 0 0-2 2v2H2a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1v1a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-1h1a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-1V3a2 2 0 0 0-2-2H5zM4 3a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2H4V3zm1 5a2 2 0 0 0-2 2v1H2a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v-1a2 2 0 0 0-2-2H5zm7 2v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1z"/>
          </svg>
          Print / Save as PDF
        </button>
      </div>
    </div>

    <!-- Executive Health Banner -->
    <div class="callout" style="border-left: 6px solid ${healthColor};">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span style="font-weight: 700; font-size: 1rem;">Deterministic Project Health Status: ${escapeHtml(
          label
        )}</span>
        <span class="badge" style="background: ${healthColor}; color: #fff;">${overallStatus}</span>
      </div>
      ${
        reasons.length > 0
          ? `<ul class="reasons-list">${reasons
              .map((r) => `<li>${escapeHtml(r)}</li>`)
              .join("")}</ul>`
          : ""
      }
    </div>

    <!-- High-Level KPI Cards -->
    <div class="grid">
      <div class="card">
        <h3>Confirmed Product Defects</h3>
        <div class="value" style="color: ${
          confirmedCritHigh > 0 ? "var(--danger)" : "var(--success)"
        };">
          ${confirmedCritHigh}
        </div>
        <div class="subtitle">Critical/High Confirmed (${confirmedMedium} Medium, ${confirmedLow} Low)</div>
      </div>
      <div class="card">
        <h3>Suspected Defects (Pending)</h3>
        <div class="value" style="color: var(--warning);">${suspectedTotal}</div>
        <div class="subtitle">${suspectedCritHigh} Critical/High awaiting QA triage</div>
      </div>
      <div class="card">
        <h3>Lifetime Conclusive Coverage</h3>
        <div class="value">${conclusiveCoverage}%</div>
        <div class="subtitle">Approved tests conclusively executed</div>
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${Math.min(
            100,
            conclusiveCoverage
          )}%;"></div>
        </div>
      </div>
      <div class="card">
        <h3>AI Optimization & Telemetry</h3>
        <div class="value">$${totalCost.toFixed(4)}</div>
        <div class="subtitle">${totalTokens.toLocaleString()} tokens (${
    totalSavedTokens > 0
      ? `$${totalSavedCost.toFixed(4)} saved via cache`
      : "No cache savings yet"
  })</div>
      </div>
    </div>

    <!-- Multi-Tier Coverage Breakdown -->
    <h2 class="section-title">Test Coverage Architecture</h2>
    <div class="grid">
      <div class="card">
        <h3>1. Website Discovery Coverage</h3>
        <div class="value">${discCovPercent}%</div>
        <div class="subtitle">${discVisited} of ${discEligible} canonical pages scanned</div>
      </div>
      <div class="card">
        <h3>2. Scenario Generation</h3>
        <div class="value">${scenCovPercent}%</div>
        <div class="subtitle">${scenGen} of ${scenPlanned} planned scenarios</div>
      </div>
      <div class="card">
        <h3>3. QA Approval Coverage</h3>
        <div class="value">${apprvCovPercent}%</div>
        <div class="subtitle">${apprvCount} of ${apprvTotal} tests approved</div>
      </div>
      <div class="card">
        <h3>4. Web Execution Coverage</h3>
        <div class="value">${webExecLifetimePercent}%</div>
        <div class="subtitle">Latest Run: ${webExecLatestPercent}% (${webExecLatestRun}/${webExecApproved})</div>
      </div>
    </div>

    <!-- Domain Telemetry Table -->
    <h2 class="section-title">Execution Telemetry (Web vs API)</h2>
    <div class="card" style="margin-bottom: 24px;">
      <table>
        <thead>
          <tr>
            <th>Testing Domain</th>
            <th>Latest Run Status</th>
            <th>Pass Rate</th>
            <th>Flaky Rate</th>
            <th>Conclusive Coverage</th>
            <th>Outcomes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Web Automation</strong></td>
            <td><span class="badge" style="background: ${
              webHealth.status === "HEALTHY" ? "var(--success)" : "var(--warning)"
            };">${webHealth.status || "NOT_EVALUATED"}</span></td>
            <td>${webHealth.passRate !== null && webHealth.passRate !== undefined ? `${webHealth.passRate}%` : "N/A"}</td>
            <td>${webHealth.flakyRate !== null && webHealth.flakyRate !== undefined ? `${webHealth.flakyRate}%` : "N/A"}</td>
            <td>${webHealth.conclusiveCoverage !== null && webHealth.conclusiveCoverage !== undefined ? `${webHealth.conclusiveCoverage}%` : "N/A"}</td>
            <td>${webHealth.passedResults ?? 0} passed, ${webHealth.failedResults ?? 0} failed</td>
          </tr>
          <tr>
            <td><strong>REST API Testing</strong></td>
            <td><span class="badge" style="background: ${
              apiHealth.status === "HEALTHY" ? "var(--success)" : "var(--warning)"
            };">${apiHealth.status || "NOT_EVALUATED"}</span></td>
            <td>${apiHealth.passRate !== null && apiHealth.passRate !== undefined ? `${apiHealth.passRate}%` : "N/A"}</td>
            <td>${apiHealth.flakyRate !== null && apiHealth.flakyRate !== undefined ? `${apiHealth.flakyRate}%` : "N/A"}</td>
            <td>${apiHealth.conclusiveCoverage !== null && apiHealth.conclusiveCoverage !== undefined ? `${apiHealth.conclusiveCoverage}%` : "N/A"}</td>
            <td>${apiHealth.passedResults ?? 0} passed, ${apiHealth.failedResults ?? 0} failed</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Deterministic Failure Classification -->
    <h2 class="section-title">Failure Analysis & Classification</h2>
    <div class="card">
      ${
        failures.length === 0
          ? "<p style='color: var(--text-muted);'>No test failures or inconclusive outcomes recorded.</p>"
          : `<table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Target</th>
              <th>Classification</th>
              <th>Error Details</th>
              <th>Triage Status</th>
            </tr>
          </thead>
          <tbody>
            ${failures
              .slice(0, 25)
              .map(
                (f) => `<tr>
              <td><code>${escapeHtml((f.runType || "web").toUpperCase())}</code></td>
              <td><strong>${escapeHtml(f.targetName || "Unknown")}</strong></td>
              <td><span class="badge" style="background: #334155;">${escapeHtml(f.classificationLabel || "Unclassified")}</span></td>
              <td>
                <div style="max-width: 450px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                  ${escapeHtml(f.errorMessage || "No error details available")}
                </div>
                ${
                  f.isAiSuggestion && f.probableCauseSuggestion
                    ? `<div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;"><em>[AI Suggestion - Not Verified]: ${escapeHtml(
                        f.probableCauseSuggestion
                      )}</em></div>`
                    : ""
                }
              </td>
              <td>
                ${
                  f.bugReportStatus === "confirmed"
                    ? `<span class="badge" style="background: var(--danger);">Confirmed Bug</span>`
                    : f.bugReportStatus === "suspected"
                    ? `<span class="badge" style="background: var(--warning);">Pending QA</span>`
                    : `<span class="badge" style="background: #475569;">None</span>`
                }
              </td>
            </tr>`
              )
              .join("")}
          </tbody>
        </table>`
      }
    </div>

    <!-- AI Telemetry Section -->
    <h2 class="section-title">AI Provider & Cost Telemetry</h2>
    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Provider</th>
            <th>Total API Calls</th>
            <th>Tokens Consumed</th>
            <th>Cost (USD)</th>
            <th>Billing Type</th>
          </tr>
        </thead>
        <tbody>
          ${
            providersList.length === 0
              ? `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No provider usage recorded</td></tr>`
              : providersList
                  .map(
                    (p: any) => `<tr>
            <td><strong>${escapeHtml(p.provider || "Unknown")}</strong></td>
            <td>${(p.calls ?? p.invocations ?? 0).toLocaleString()}</td>
            <td>${(p.totalTokens ?? 0).toLocaleString()}</td>
            <td>$${(p.estimatedCostUsd ?? 0).toFixed(6)}</td>
            <td>${p.isZeroCostLocal ? "<span class='badge' style='background: var(--success);'>Local / $0</span>" : "Commercial API"}</td>
          </tr>`
                  )
                  .join("")
          }
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`;
}

// ============================================================================
// Concrete CSV Export Schemas
// ============================================================================

export const DISCOVERY_EXPORT_COLUMNS: CsvColumnDefinition<any>[] = [
  { header: "URL", key: "url", type: "text" },
  { header: "Path", key: "path", type: "text" },
  { header: "Depth", key: "depth", type: "trusted_numeric" },
  { header: "Status", key: "status", type: "text" },
  { header: "Page Type", key: "pageType", type: "text" },
  { header: "Title", key: "title", type: "text" },
  { header: "Duration (ms)", key: "durationMs", type: "trusted_numeric" },
  { header: "Error Message", key: "errorMessage", type: "text" },
  { header: "Discovered At", key: "createdAt", type: "date" },
];

export const TEST_RESULTS_EXPORT_COLUMNS: CsvColumnDefinition<any>[] = [
  { header: "Run ID", key: "runId", type: "text" },
  { header: "Target Name", key: "targetName", type: "text" },
  { header: "Testing Type", key: "runType", type: "text" },
  { header: "Execution Status", key: "status", type: "text" },
  { header: "Classification", key: "classificationLabel", type: "text" },
  { header: "Duration (ms)", key: "durationMs", type: "trusted_numeric" },
  { header: "Retry Count", key: "retryCount", type: "trusted_numeric" },
  { header: "Is Flaky", key: "isFlaky", type: "boolean" },
  { header: "Error Message", key: "errorMessage", type: "text" },
  { header: "Executed At", key: "executedAt", type: "date" },
];

export const AI_USAGE_EXPORT_COLUMNS: CsvColumnDefinition<any>[] = [
  { header: "Feature", key: "feature", type: "text" },
  { header: "Provider", key: "provider", type: "text" },
  { header: "Model", key: "model", type: "text" },
  { header: "Prompt Tokens", key: "promptTokens", type: "trusted_numeric" },
  { header: "Completion Tokens", key: "completionTokens", type: "trusted_numeric" },
  { header: "Total Tokens", key: "totalTokens", type: "trusted_numeric" },
  { header: "Estimated Cost ($)", key: "estimatedCostUsd", type: "trusted_numeric" },
  { header: "Duration (ms)", key: "durationMs", type: "trusted_numeric" },
  { header: "Logged At", key: "createdAt", type: "date" },
];
