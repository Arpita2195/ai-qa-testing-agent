import { pool } from "../../config/db";
import { logger } from "./logger";

export interface TestExecutionMetric {
  status: "passed" | "failed" | "skipped" | "inconclusive" | "flaky";
  durationMs: number;
  projectId?: string;
  executionType?: "web" | "api";
}

export interface AiUsageRecordParams {
  projectId?: string;
  feature: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  durationMs?: number;
  createdBy?: string;
}

export interface AlertRule {
  id: string;
  name: string;
  metric: "failure_rate" | "queue_delay" | "worker_retries" | "api_errors";
  threshold: number;
  severity: "info" | "warning" | "critical";
  message: string;
}

export interface ActiveAlert {
  ruleId: string;
  ruleName: string;
  severity: "info" | "warning" | "critical";
  message: string;
  currentValue: number;
  threshold: number;
  triggeredAt: string;
}

// In-memory sliding window counters for real-time observability
class MetricsTracker {
  private executionDurations: number[] = [];
  private queueDelays: number[] = [];
  private workerRetries: number = 0;
  private workerFailures: number = 0;
  private apiErrorsByRoute: Map<string, number> = new Map();
  private totalApiRequests: number = 0;

  // Maximum items retained in sliding windows to avoid memory leaks
  private readonly MAX_WINDOW_SIZE = 1000;

  trackTestExecution(metric: TestExecutionMetric): void {
    if (metric.durationMs >= 0) {
      this.executionDurations.push(metric.durationMs);
      if (this.executionDurations.length > this.MAX_WINDOW_SIZE) {
        this.executionDurations.shift();
      }
    }
  }

  trackQueueDelay(delayMs: number): void {
    if (delayMs >= 0) {
      this.queueDelays.push(delayMs);
      if (this.queueDelays.length > this.MAX_WINDOW_SIZE) {
        this.queueDelays.shift();
      }
    }
  }

  trackWorkerRetry(): void {
    this.workerRetries++;
  }

  trackWorkerFailure(): void {
    this.workerFailures++;
  }

  trackApiRequest(statusCode: number, route: string = "unknown"): void {
    this.totalApiRequests++;
    if (statusCode >= 400) {
      const key = `${statusCode} ${route}`;
      const count = this.apiErrorsByRoute.get(key) || 0;
      this.apiErrorsByRoute.set(key, count + 1);
    }
  }

  private calculatePercentile(values: number[], percentile: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return Math.round(sorted[Math.max(0, index)]);
  }

  private calculateAverage(values: number[]): number {
    if (values.length === 0) return 0;
    const sum = values.reduce((acc, v) => acc + v, 0);
    return Math.round(sum / values.length);
  }

  getExecutionDurationStats() {
    return {
      count: this.executionDurations.length,
      avgMs: this.calculateAverage(this.executionDurations),
      p50Ms: this.calculatePercentile(this.executionDurations, 50),
      p95Ms: this.calculatePercentile(this.executionDurations, 95),
      p99Ms: this.calculatePercentile(this.executionDurations, 99),
      minMs: this.executionDurations.length ? Math.min(...this.executionDurations) : 0,
      maxMs: this.executionDurations.length ? Math.max(...this.executionDurations) : 0,
    };
  }

  getQueueDelayStats() {
    return {
      count: this.queueDelays.length,
      avgMs: this.calculateAverage(this.queueDelays),
      p50Ms: this.calculatePercentile(this.queueDelays, 50),
      p95Ms: this.calculatePercentile(this.queueDelays, 95),
      minMs: this.queueDelays.length ? Math.min(...this.queueDelays) : 0,
      maxMs: this.queueDelays.length ? Math.max(...this.queueDelays) : 0,
    };
  }

  getWorkerStats() {
    return {
      retries: this.workerRetries,
      failures: this.workerFailures,
    };
  }

  getApiStats() {
    const errors: Record<string, number> = {};
    for (const [k, v] of this.apiErrorsByRoute.entries()) {
      errors[k] = v;
    }
    return {
      totalRequests: this.totalApiRequests,
      errors,
    };
  }

  reset(): void {
    this.executionDurations = [];
    this.queueDelays = [];
    this.workerRetries = 0;
    this.workerFailures = 0;
    this.apiErrorsByRoute.clear();
    this.totalApiRequests = 0;
  }
}

export const inMemoryMetrics = new MetricsTracker();

/**
 * Calculates estimated cost for AI tokens in USD.
 * Rates based on Gemini standard pricing:
 * - gemini-2.5-flash / gemini-1.5-flash: $0.075 / 1M prompt tokens, $0.30 / 1M completion tokens.
 * - gemini-1.5-pro: $3.50 / 1M prompt tokens, $10.50 / 1M completion tokens.
 */
export function calculateEstimatedCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const isPro = model.toLowerCase().includes("pro");
  const promptRatePerMillion = isPro ? 3.5 : 0.075;
  const completionRatePerMillion = isPro ? 10.5 : 0.3;

  const promptCost = (promptTokens / 1_000_000) * promptRatePerMillion;
  const completionCost = (completionTokens / 1_000_000) * completionRatePerMillion;
  return Number((promptCost + completionCost).toFixed(6));
}

/**
 * Records AI token usage and estimated cost into the `ai_usage_logs` table.
 */
export async function recordAiUsage(params: AiUsageRecordParams): Promise<void> {
  const totalTokens = params.promptTokens + params.completionTokens;
  const estimatedCost = calculateEstimatedCostUsd(params.model, params.promptTokens, params.completionTokens);

  try {
    await pool.query(
      `INSERT INTO ai_usage_logs
         (project_id, feature, model, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, duration_ms, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        params.projectId || null,
        params.feature,
        params.model,
        params.promptTokens,
        params.completionTokens,
        totalTokens,
        estimatedCost,
        params.durationMs ?? null,
        params.createdBy ?? null,
      ],
    );

    logger.info("Recorded AI token usage and cost estimate", {
      feature: params.feature,
      model: params.model,
      totalTokens,
      estimatedCostUsd: estimatedCost,
      projectId: params.projectId,
    });
  } catch (err) {
    logger.warn("Failed to persist AI usage log to database", { error: err });
  }
}

/**
 * Aggregates comprehensive test execution, background queue, worker, and AI telemetry.
 */
export async function getSystemMetrics(projectId?: string): Promise<{
  tests: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    inconclusive: number;
    flaky: number;
    passRatePercent: number;
    duration: ReturnType<MetricsTracker["getExecutionDurationStats"]>;
  };
  jobs: {
    pending: number;
    active: number;
    completed: number;
    failed: number;
    retrying: number;
    cancelled: number;
    total: number;
    queueDelay: ReturnType<MetricsTracker["getQueueDelayStats"]>;
    worker: ReturnType<MetricsTracker["getWorkerStats"]>;
  };
  ai: {
    totalRequests: number;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    estimatedCostUsd: number;
    breakdownByFeature: Record<string, { requests: number; tokens: number; costUsd: number }>;
  };
  api: ReturnType<MetricsTracker["getApiStats"]>;
  alerts: ActiveAlert[];
}> {
  // 1. Database test execution counts
  const testFilter = projectId ? "WHERE r.project_id = $1" : "";
  const testValues = projectId ? [projectId] : [];

  const testCountsRes = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE tr.status = 'passed')::int AS passed,
       COUNT(*) FILTER (WHERE tr.status = 'failed')::int AS failed,
       COUNT(*) FILTER (WHERE tr.status = 'skipped')::int AS skipped,
       COUNT(*) FILTER (WHERE tr.status = 'inconclusive')::int AS inconclusive,
       COUNT(*) FILTER (WHERE tr.flaky = true)::int AS flaky
     FROM test_results tr
     JOIN test_runs r ON r.id = tr.run_id
     ${testFilter}`,
    testValues,
  );

  const testCounts = testCountsRes.rows[0] || { total: 0, passed: 0, failed: 0, skipped: 0, inconclusive: 0, flaky: 0 };
  const evaluatedTests = (testCounts.passed || 0) + (testCounts.failed || 0);
  const passRatePercent = evaluatedTests > 0 ? Number(((testCounts.passed / evaluatedTests) * 100).toFixed(1)) : 100;

  // 2. Background Jobs counts
  const jobFilter = projectId ? "WHERE project_id = $1" : "";
  const jobValues = projectId ? [projectId] : [];

  const jobCountsRes = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
       COUNT(*) FILTER (WHERE status = 'active')::int AS active,
       COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
       COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
       COUNT(*) FILTER (WHERE status = 'retrying')::int AS retrying,
       COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
       AVG(queue_delay_ms)::numeric AS avg_delay,
       AVG(duration_ms)::numeric AS avg_duration
     FROM background_jobs
     ${jobFilter}`,
    jobValues,
  );

  const jobCounts = jobCountsRes.rows[0] || {
    total: 0,
    pending: 0,
    active: 0,
    completed: 0,
    failed: 0,
    retrying: 0,
    cancelled: 0,
  };

  // 3. AI Usage aggregation
  const aiFilter = projectId ? "WHERE project_id = $1" : "";
  const aiValues = projectId ? [projectId] : [];

  const aiRes = await pool.query(
    `SELECT
       COUNT(*)::int AS total_requests,
       COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
       COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
       COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
       COALESCE(SUM(estimated_cost_usd), 0)::numeric AS total_cost_usd
     FROM ai_usage_logs
     ${aiFilter}`,
    aiValues,
  );

  const aiRow = aiRes.rows[0] || { total_requests: 0, total_tokens: 0, prompt_tokens: 0, completion_tokens: 0, total_cost_usd: 0 };

  const aiBreakdownRes = await pool.query(
    `SELECT
       feature,
       COUNT(*)::int AS reqs,
       COALESCE(SUM(total_tokens), 0)::bigint AS toks,
       COALESCE(SUM(estimated_cost_usd), 0)::numeric AS cost
     FROM ai_usage_logs
     ${aiFilter}
     GROUP BY feature`,
    aiValues,
  );

  const featureBreakdown: Record<string, { requests: number; tokens: number; costUsd: number }> = {};
  for (const row of aiBreakdownRes.rows) {
    featureBreakdown[row.feature] = {
      requests: row.reqs,
      tokens: Number(row.toks),
      costUsd: Number(row.cost),
    };
  }

  // 4. Alert evaluations
  const activeAlerts: ActiveAlert[] = [];
  const failureRate = testCounts.total > 0 ? (testCounts.failed / testCounts.total) * 100 : 0;
  if (failureRate > 25 && testCounts.total >= 5) {
    activeAlerts.push({
      ruleId: "high_test_failure_rate",
      ruleName: "High Test Failure Rate",
      severity: "warning",
      message: `Test failure rate is currently ${failureRate.toFixed(1)}% (exceeds 25% threshold).`,
      currentValue: Number(failureRate.toFixed(1)),
      threshold: 25,
      triggeredAt: new Date().toISOString(),
    });
  }

  const workerStats = inMemoryMetrics.getWorkerStats();
  if (workerStats.failures > 3) {
    activeAlerts.push({
      ruleId: "worker_failures_detected",
      ruleName: "Background Worker Failures Detected",
      severity: "critical",
      message: `Worker has encountered ${workerStats.failures} job failures.`,
      currentValue: workerStats.failures,
      threshold: 3,
      triggeredAt: new Date().toISOString(),
    });
  }

  const queueStats = inMemoryMetrics.getQueueDelayStats();
  if (queueStats.avgMs > 15000) {
    activeAlerts.push({
      ruleId: "high_queue_delay",
      ruleName: "High Background Job Queue Delay",
      severity: "warning",
      message: `Average background job queue delay is ${queueStats.avgMs}ms (threshold 15000ms).`,
      currentValue: queueStats.avgMs,
      threshold: 15000,
      triggeredAt: new Date().toISOString(),
    });
  }

  return {
    tests: {
      total: testCounts.total,
      passed: testCounts.passed,
      failed: testCounts.failed,
      skipped: testCounts.skipped,
      inconclusive: testCounts.inconclusive,
      flaky: testCounts.flaky,
      passRatePercent,
      duration: inMemoryMetrics.getExecutionDurationStats(),
    },
    jobs: {
      pending: jobCounts.pending,
      active: jobCounts.active,
      completed: jobCounts.completed,
      failed: jobCounts.failed,
      retrying: jobCounts.retrying,
      cancelled: jobCounts.cancelled,
      total: jobCounts.total,
      queueDelay: queueStats,
      worker: workerStats,
    },
    ai: {
      totalRequests: aiRow.total_requests,
      totalTokens: Number(aiRow.total_tokens),
      promptTokens: Number(aiRow.prompt_tokens),
      completionTokens: Number(aiRow.completion_tokens),
      estimatedCostUsd: Number(Number(aiRow.total_cost_usd).toFixed(4)),
      breakdownByFeature: featureBreakdown,
    },
    api: inMemoryMetrics.getApiStats(),
    alerts: activeAlerts,
  };
}

/**
 * Generates Prometheus exposition format metrics for scraping via `/metrics`.
 */
export async function getPrometheusMetrics(): Promise<string> {
  const metrics = await getSystemMetrics();
  const lines: string[] = [];

  // Helper
  const line = (metric: string, type: "counter" | "gauge" | "histogram", help: string, val: number, labels: Record<string, string> = {}) => {
    lines.push(`# HELP ${metric} ${help}`);
    lines.push(`# TYPE ${metric} ${type}`);
    const labelStr = Object.entries(labels)
      .map(([k, v]) => `${k}="${v}"`)
      .join(",");
    const target = labelStr ? `${metric}{${labelStr}}` : metric;
    lines.push(`${target} ${val}`);
  };

  // Test executions
  line("aiqa_test_executions_total", "counter", "Total test executions by status", metrics.tests.passed, { status: "passed" });
  line("aiqa_test_executions_total", "counter", "Total test executions by status", metrics.tests.failed, { status: "failed" });
  line("aiqa_test_executions_total", "counter", "Total test executions by status", metrics.tests.skipped, { status: "skipped" });
  line("aiqa_test_executions_total", "counter", "Total test executions by status", metrics.tests.inconclusive, { status: "inconclusive" });
  line("aiqa_test_executions_total", "counter", "Total test executions by status", metrics.tests.flaky, { status: "flaky" });

  // Test execution durations
  line("aiqa_test_duration_milliseconds_avg", "gauge", "Average test execution duration in ms", metrics.tests.duration.avgMs);
  line("aiqa_test_duration_milliseconds_p95", "gauge", "95th percentile test execution duration in ms", metrics.tests.duration.p95Ms);

  // Background Jobs
  line("aiqa_jobs_status_count", "gauge", "Current count of background jobs by status", metrics.jobs.pending, { status: "pending" });
  line("aiqa_jobs_status_count", "gauge", "Current count of background jobs by status", metrics.jobs.active, { status: "active" });
  line("aiqa_jobs_status_count", "gauge", "Current count of background jobs by status", metrics.jobs.completed, { status: "completed" });
  line("aiqa_jobs_status_count", "gauge", "Current count of background jobs by status", metrics.jobs.failed, { status: "failed" });
  line("aiqa_jobs_queue_delay_milliseconds_avg", "gauge", "Average queue delay in ms", metrics.jobs.queueDelay.avgMs);
  line("aiqa_worker_retries_total", "counter", "Total worker retry attempts", metrics.jobs.worker.retries);
  line("aiqa_worker_failures_total", "counter", "Total worker terminal failures", metrics.jobs.worker.failures);

  // AI Usage
  line("aiqa_ai_tokens_total", "counter", "Total AI tokens consumed", metrics.ai.totalTokens);
  line("aiqa_ai_cost_usd_total", "counter", "Estimated total AI expenditure in USD", metrics.ai.estimatedCostUsd);

  // API errors
  line("aiqa_api_requests_total", "counter", "Total API requests processed", metrics.api.totalRequests);

  return lines.join("\n") + "\n";
}
