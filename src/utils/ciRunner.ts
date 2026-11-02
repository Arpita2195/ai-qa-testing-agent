import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "../config/db";
import { runApiTest, type ApiEndpoint } from "../services/apiRunner";
import { analyzeFailure } from "../services/failureAnalyzer";
import { compareRuns } from "../services/regressionService";
import {
  classifyRunStatus,
  redactSecrets,
  runTestCase,
  scrubEvidence,
  type WebResultStatus,
} from "../services/runner";

interface CiRunnerOptions {
  projectId?: string;
  commitSha?: string;
  branch?: string;
  prNumber?: string;
  blockRelease?: boolean;
  outputFile?: string;
}

function parseCliArgs(): CiRunnerOptions {
  const args = process.argv.slice(2);
  const options: CiRunnerOptions = {
    projectId: process.env.CI_PROJECT_ID,
    commitSha: process.env.GITHUB_SHA,
    branch: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME,
    prNumber: process.env.PR_NUMBER,
    blockRelease: process.env.BLOCK_ON_REGRESSION === "true",
    outputFile: path.resolve(process.cwd(), "artifacts/ci-report.md"),
  };

  for (const arg of args) {
    if (arg.startsWith("--project-id=")) {
      options.projectId = arg.split("=")[1];
    } else if (arg.startsWith("--commit-sha=")) {
      options.commitSha = arg.split("=")[1];
    } else if (arg.startsWith("--branch=")) {
      options.branch = arg.split("=")[1];
    } else if (arg.startsWith("--pr-number=")) {
      options.prNumber = arg.split("=")[1];
    } else if (arg === "--block-release") {
      options.blockRelease = true;
    } else if (arg.startsWith("--output-file=")) {
      options.outputFile = path.resolve(process.cwd(), arg.split("=")[1]);
    }
  }

  return options;
}

function getChangedFiles(): string[] {
  try {
    const output = execSync("git diff --name-only HEAD~1 HEAD", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return output.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export async function runCiPipeline(options: CiRunnerOptions): Promise<{
  runId: string;
  status: string;
  regressionDetected: boolean;
  reportMarkdown: string;
}> {
  console.log("=== AI QA Testing Agent: CI Pipeline Started ===");

  // 1. Resolve Project
  let projectQuery;
  if (options.projectId) {
    projectQuery = await pool.query<{ id: string; name: string; base_url: string }>(
      "SELECT id, name, base_url FROM projects WHERE id = $1",
      [options.projectId],
    );
  } else {
    projectQuery = await pool.query<{ id: string; name: string; base_url: string }>(
      "SELECT id, name, base_url FROM projects ORDER BY created_at ASC LIMIT 1",
    );
  }

  const project = projectQuery.rows[0];
  if (!project) {
    throw new Error("No project found in database to test");
  }

  console.log(`Target Project: ${project.name} (${project.base_url})`);
  const commitSha = options.commitSha || "local-head";
  const branch = options.branch || "main";
  const changedFiles = getChangedFiles();
  if (changedFiles.length > 0) {
    console.log(`Detected ${changedFiles.length} changed file(s):`, changedFiles.slice(0, 5));
  }

  // 2. Create CI Test Run
  const runId = randomUUID();
  await pool.query(
    `INSERT INTO test_runs
       (id, project_id, status, started_at, run_type, commit_sha, branch, environment, trigger_source)
     VALUES ($1, $2, 'running', now(), 'web', $3, $4, 'test', 'ci')`,
    [runId, project.id, commitSha, branch],
  );

  // 3. Fetch and Execute Approved Web Test Cases
  const testCasesQuery = await pool.query<{ id: string; title: string; steps: string[] }>(
    `SELECT id, title, steps FROM test_cases
     WHERE project_id = $1 AND review_status = 'approved'
     ORDER BY created_at ASC`,
    [project.id],
  );

  const webResults: Array<{
    id: string;
    testCaseId: string;
    title: string;
    steps: string[];
    status: WebResultStatus;
    durationMs: number;
    error_message: string | null;
    screenshot_path: string | null;
    trace_path: string | null;
  }> = [];

  for (const tc of testCasesQuery.rows) {
    const resultId = randomUUID();
    console.log(`Running Web Test: "${tc.title}"`);
    const execution = await runTestCase(
      project.base_url,
      tc.steps,
      { runId, resultId },
      { projectId: project.id },
    );

    await pool.query(
      `INSERT INTO test_results
         (id, run_id, test_case_id, status, error_message, duration_ms, screenshot_path, trace_path, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
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

    webResults.push({
      id: resultId,
      testCaseId: tc.id,
      title: redactSecrets(tc.title),
      steps: tc.steps.map((s) => redactSecrets(s)),
      status: execution.status,
      durationMs: execution.durationMs,
      error_message: execution.errorMessage ? redactSecrets(execution.errorMessage) : null,
      screenshot_path: execution.screenshotPath,
      trace_path: execution.tracePath ?? null,
    });
  }

  // 4. Fetch and Execute Approved API Endpoints
  const endpointsQuery = await pool.query<ApiEndpoint & { id: string; name: string }>(
    `SELECT id, name, method, path, headers, body, expected_status, expected_fields, max_response_ms
     FROM api_endpoints
     WHERE project_id = $1 AND review_status = 'approved'`,
    [project.id],
  );

  const apiResults: Array<{
    id: string;
    name: string;
    status: string;
    responseMs: number;
    error_message: string | null;
  }> = [];

  for (const ep of endpointsQuery.rows) {
    console.log(`Running API Endpoint: ${ep.method} ${ep.path}`);
    const execution = await runApiTest(project.base_url, ep);
    const resultId = randomUUID();

    await pool.query(
      `INSERT INTO api_test_results
         (id, run_id, endpoint_id, status, actual_status, response_ms, error_message, response_snippet)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        resultId,
        runId,
        ep.id,
        execution.status,
        execution.actualStatus,
        execution.responseMs,
        execution.errorMessage,
        execution.responseSnippet,
      ],
    );

    apiResults.push({
      id: ep.id,
      name: ep.name,
      status: execution.status,
      responseMs: execution.responseMs,
      error_message: execution.errorMessage,
    });
  }

  // 5. Finalize Run Status
  const allStatuses = [
    ...webResults.map((r) => r.status),
    ...apiResults.map((r) => r.status as WebResultStatus),
  ];
  const finalStatus = classifyRunStatus(allStatuses);
  await pool.query(
    "UPDATE test_runs SET status = $1, finished_at = now() WHERE id = $2",
    [finalStatus, runId],
  );

  // 6. Build Comparison against previous baseline run
  let comparisonResult = null;
  const prevRunQuery = await pool.query<{ id: string }>(
    `SELECT id FROM test_runs
     WHERE project_id = $1 AND id != $2 AND status IN ('passed', 'failed', 'inconclusive')
     ORDER BY created_at DESC LIMIT 1`,
    [project.id, runId],
  );

  if (prevRunQuery.rows.length > 0) {
    try {
      comparisonResult = await compareRuns(prevRunQuery.rows[0].id, runId, project.id);
    } catch (err) {
      console.warn("Could not compute run comparison:", err);
    }
  }

  // 7. AI Failure Analysis for any failed tests
  const bugReports: Array<{
    title: string;
    severity: string;
    classification: string;
    cause: string;
    steps: string[];
  }> = [];

  const failedWebTests = webResults.filter((r) => r.status === "failed");
  for (const failed of failedWebTests) {
    try {
      console.log(`Analyzing failure for "${failed.title}" with AI...`);
      const analysis = await analyzeFailure({
        title: failed.title,
        steps: failed.steps,
        expected_result: null,
        errorMessage: failed.error_message ?? "Assertion failed",
        pageUrl: project.base_url,
      });

      await pool.query(
        `INSERT INTO bug_reports
           (id, result_id, test_case_id, title, description, severity, classification, probable_cause, reproduction_steps, status)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, 'suspected')
         ON CONFLICT (result_id) DO NOTHING`,
        [
          failed.id,
          failed.testCaseId,
          analysis.title,
          analysis.description,
          analysis.severity,
          analysis.classification,
          analysis.probable_cause,
          JSON.stringify(analysis.reproduction_steps),
        ],
      );

      bugReports.push({
        title: analysis.title,
        severity: analysis.severity,
        classification: analysis.classification,
        cause: analysis.probable_cause,
        steps: analysis.reproduction_steps,
      });
    } catch (err) {
      console.warn(`Failure analysis failed for ${failed.id}:`, err);
    }
  }

  // 8. Generate Rich Markdown Report
  const totalCount = webResults.length + apiResults.length;
  const passedCount = webResults.filter((r) => r.status === "passed").length +
    apiResults.filter((r) => r.status === "passed").length;
  const failedCount = failedWebTests.length + apiResults.filter((r) => r.status === "failed").length;
  const regressionDetected = comparisonResult?.summary.regression_detected ?? false;

  let verdictBadge = "✅ **PASSED — Clean Build**";
  if (regressionDetected) {
    verdictBadge = "🚨 **REGRESSION DETECTED**";
  } else if (failedCount > 0) {
    verdictBadge = "❌ **FAILED TESTS DETECTED**";
  }

  const modeText = options.blockRelease
    ? "🔒 **Release-Blocking Mode** (PR will be blocked on regressions)"
    : "ℹ️ **Report-Only Mode** (Release blocking turned off for pilot)";

  let markdown = `## 🤖 AI QA Testing Agent — CI Report

${verdictBadge}
*${modeText}*

- **Project**: ${project.name} (\`${project.base_url}\`)
- **Commit**: \`${commitSha.slice(0, 7)}\` | **Branch**: \`${branch}\`
- **Run ID**: \`${runId}\`

---

### 📊 Results Summary

| Total Tests | Passed | Failed | New Failures | Recurring | Fixed | Duration Δ |
|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **${totalCount}** | 🟢 ${passedCount} | 🔴 ${failedCount} | 🚨 ${comparisonResult?.summary.new_failures_count ?? 0} | 🔁 ${comparisonResult?.summary.recurring_failures_count ?? 0} | 🎉 ${comparisonResult?.summary.fixed_tests_count ?? 0} | ${(comparisonResult?.summary.duration_delta_ms ?? 0) >= 0 ? "+" : ""}${comparisonResult?.summary.duration_delta_ms ?? 0}ms |

`;

  if (regressionDetected && comparisonResult) {
    const newFailures = comparisonResult.items.filter((i) => i.change_type === "new_failure");
    markdown += `### 🚨 Newly Introduced Failures\n\n`;
    for (const item of newFailures) {
      markdown += `- **${item.title}** (${item.type})\n`;
      if (item.error_message) {
        markdown += `  - Error: \`${item.error_message}\`\n`;
      }
      if (item.screenshot_path) {
        markdown += `  - Screenshot evidence: \`${item.screenshot_path}\`\n`;
      }
    }
    markdown += `\n`;
  }

  if (bugReports.length > 0) {
    markdown += `### 🧠 AI Failure Diagnostics & Root Causes\n\n`;
    for (const report of bugReports) {
      markdown += `#### ${report.title} (\`${report.severity}\` · \`${report.classification}\`)\n`;
      markdown += `> **Probable Cause**: ${report.cause}\n\n`;
      if (report.steps && report.steps.length > 0) {
        markdown += `**Reproduction Steps**:\n`;
        for (const step of report.steps) {
          markdown += `1. ${step}\n`;
        }
        markdown += `\n`;
      }
    }
  }

  if (comparisonResult && comparisonResult.summary.fixed_tests_count > 0) {
    const fixed = comparisonResult.items.filter((i) => i.change_type === "fixed");
    markdown += `### 🎉 Fixed Tests in this Build\n\n`;
    for (const item of fixed) {
      markdown += `- ✅ **${item.title}** (${item.type})\n`;
    }
    markdown += `\n`;
  }

  markdown += `*Generated automatically by AI QA Testing Agent platform.*\n`;

  // Write out markdown report
  if (options.outputFile) {
    await mkdir(path.dirname(options.outputFile), { recursive: true });
    await writeFile(options.outputFile, markdown, "utf8");
    console.log(`Saved CI Report to: ${options.outputFile}`);
  }

  // Also write to GITHUB_STEP_SUMMARY if available
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      await writeFile(process.env.GITHUB_STEP_SUMMARY, markdown, { flag: "a" });
      console.log("Appended report to GITHUB_STEP_SUMMARY");
    } catch (err) {
      console.warn("Could not write to GITHUB_STEP_SUMMARY:", err);
    }
  }

  return {
    runId,
    status: finalStatus,
    regressionDetected,
    reportMarkdown: markdown,
  };
}

async function main() {
  const options = parseCliArgs();
  try {
    const result = await runCiPipeline(options);
    console.log(`\nCI Run completed with status: ${result.status}`);

    if (options.blockRelease && result.regressionDetected) {
      console.error("Release Blocked: Regression detected in release-blocking mode.");
      process.exit(1);
    }
  } catch (error) {
    console.error("CI Pipeline failed:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  void main();
}
