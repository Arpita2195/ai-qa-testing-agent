import { readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { redactSecrets, scrubEvidence, type StockFlowCredentials, type WebEvidence, type WebResultStatus } from "./runner";

export interface RunReportCase {
  id: string;
  title: string;
  steps: string[];
  status: WebResultStatus;
  duration_ms: number;
  error_message: string | null;
  evidence: WebEvidence;
}

export interface RunReportInput {
  runId: string;
  projectName: string;
  baseUrl: string;
  startedAt: string;
  finishedAt: string;
  tests: RunReportCase[];
}

export interface RunReport extends RunReportInput {
  durationMs: number;
  totals: {
    passed: number;
    failed: number;
    skipped: number;
    inconclusive: number;
    total: number;
    successRate: number;
  };
  infrastructure: RunReportCase[];
}

function redactTree<T>(value: T, credentials?: StockFlowCredentials): T {
  if (typeof value === "string") return redactSecrets(value, credentials) as T;
  if (Array.isArray(value)) return value.map((item) => redactTree(item, credentials)) as T;
  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (["authorization", "cookie", "set-cookie", "x-api-key", "storagestate", "session"].includes(key.toLowerCase())) continue;
      output[key] = redactTree(child, credentials);
    }
    return output as T;
  }
  return value;
}

export function buildRunReport(input: RunReportInput, credentials?: StockFlowCredentials): RunReport {
  const safeInput = scrubEvidence(redactTree(input, credentials), credentials);
  const totals = {
    passed: safeInput.tests.filter((test) => test.status === "passed").length,
    failed: safeInput.tests.filter((test) => test.status === "failed").length,
    skipped: safeInput.tests.filter((test) => test.status === "skipped").length,
    inconclusive: safeInput.tests.filter((test) => test.status === "inconclusive").length,
    total: safeInput.tests.length,
    successRate: safeInput.tests.length === 0
      ? 0
      : Number(((safeInput.tests.filter((test) => test.status === "passed").length / safeInput.tests.length) * 100).toFixed(2)),
  };
  return {
    ...safeInput,
    durationMs: Math.max(0, Date.parse(input.finishedAt) - Date.parse(input.startedAt)),
    totals,
    infrastructure: safeInput.tests.filter((test) => test.status === "inconclusive"),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function caseHtml(test: RunReportCase, imageData: string | null): string {
  const steps = test.steps.map((step, index) => {
    const failed = test.evidence.failureStepIndex === index;
    return `<li${failed ? ' class="failed-step"' : ""}>${failed ? "<strong>FAILED STEP: </strong>" : ""}${escapeHtml(step)}</li>`;
  }).join("");
  const browserErrors = test.evidence.browserErrors.map((error) => `<li>${escapeHtml(error)}</li>`).join("");
  const failedRequests = test.evidence.failedRequests.map((request) =>
    `<li>${escapeHtml(`${request.method} ${request.url} — ${request.failure}`)}</li>`,
  ).join("");
  const httpErrors = test.evidence.httpErrors.map((response) =>
    `<li>${escapeHtml(`${response.method} ${response.url} — HTTP ${response.status}`)}</li>`,
  ).join("");
  const image = imageData
    ? `<img alt="Test screenshot" src="data:image/png;base64,${imageData}">`
    : "<p>Screenshot unavailable</p>";
  return `<article class="case"><h3>${escapeHtml(test.title)}</h3>
    <p><b>Status:</b> ${escapeHtml(test.status)} · <b>Duration:</b> ${test.duration_ms} ms</p>
    ${test.error_message ? `<p class="error">${escapeHtml(test.error_message)}</p>` : ""}
    <p><b>Final page:</b> ${escapeHtml(test.evidence.finalTitle)} — ${escapeHtml(test.evidence.finalUrl)}</p>
    <h4>Steps</h4><ol>${steps}</ol>
    <h4>Browser errors</h4>${browserErrors ? `<ul>${browserErrors}</ul>` : "<p>None</p>"}
    <h4>Failed network requests</h4>${failedRequests ? `<ul>${failedRequests}</ul>` : "<p>None</p>"}
    <h4>HTTP errors</h4>${httpErrors ? `<ul>${httpErrors}</ul>` : "<p>None</p>"}
    <p>Trace: ${escapeHtml(test.evidence.tracePath ?? test.evidence.traceNote ?? "not captured")}</p>
    ${image}</article>`;
}

export async function renderRunReportHtml(report: RunReport): Promise<string> {
  const sections = await Promise.all(report.tests.map(async (test) => {
    let imageData: string | null = null;
    if (test.evidence.screenshotPath) {
      const filename = path.resolve(
        __dirname,
        "../../",
        test.evidence.screenshotPath,
      );
      try {
        imageData = (await readFile(filename)).toString("base64");
      } catch {
        imageData = null;
      }
    }
    return caseHtml(test, imageData);
  }));
  const ordinary = report.tests.filter((test) => test.status !== "inconclusive");
  const infrastructure = report.infrastructure;
  const totals = report.totals;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Run ${escapeHtml(report.runId)} report</title>
  <style>body{font:15px/1.5 system-ui,sans-serif;max-width:1050px;margin:32px auto;padding:0 18px;color:#202b37;background:#f5f7f9}h1,h2,h3{color:#17324d}.summary,.case{background:white;border:1px solid #dbe2ea;border-radius:8px;padding:18px;margin:14px 0}.totals{display:flex;gap:14px;flex-wrap:wrap}.totals span{padding:8px;background:#eef3f6;border-radius:6px}.case img{max-width:100%;max-height:650px;border:1px solid #dbe2ea}.failed-step,.error{color:#a13232}.failed-step{background:#fff0ef;padding:4px}.muted{color:#69788a}</style></head><body>
  <h1>Web test run report</h1><section class="summary"><p><b>Run:</b> ${escapeHtml(report.runId)}</p>
  <p><b>Project:</b> ${escapeHtml(report.projectName)}</p><p><b>Base URL:</b> ${escapeHtml(report.baseUrl)}</p>
  <p><b>Started:</b> ${escapeHtml(report.startedAt)} · <b>Finished:</b> ${escapeHtml(report.finishedAt)} · <b>Duration:</b> ${report.durationMs} ms</p>
  <div class="totals"><span>Passed ${totals.passed}</span><span>Failed ${totals.failed}</span><span>Skipped ${totals.skipped}</span><span>Inconclusive ${totals.inconclusive}</span><span>Success rate ${totals.successRate}%</span></div></section>
  <h2>Test cases</h2>${ordinary.map((test) => sections[report.tests.indexOf(test)]).join("") || '<p class="muted">No test cases in this section.</p>'}
  <h2>Infrastructure (inconclusive)</h2>${infrastructure.map((test) => sections[report.tests.indexOf(test)]).join("") || '<p class="muted">No infrastructure failures.</p>'}
  </body></html>`;
}

export async function writeRunReport(input: RunReportInput): Promise<RunReport> {
  const report = buildRunReport(input);
  const directory = path.resolve(__dirname, "../../artifacts/runs", report.runId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2), "utf8");
  await writeFile(path.join(directory, "report.html"), await renderRunReportHtml(report), "utf8");
  return report;
}
