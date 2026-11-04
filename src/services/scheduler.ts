import { randomUUID } from "node:crypto";
import { pool } from "../config/db";
import { classifyRunStatus, redactSecrets, scrubEvidence } from "./runner";
import {
  executeConcurrentPool,
  runWebTestWithRetries,
  runApiTestWithRetries,
  type ExtendedWebExecutionResult,
  type ExtendedApiExecutionResult,
} from "./executionManager";
import { writeRunReport, type RunReportCase } from "./runReport";

export interface TestSchedule {
  id: string;
  project_id: string;
  suite_id: string | null;
  name: string;
  schedule_type: "hourly" | "daily" | "weekly" | "custom_cron";
  cron_expression: string | null;
  concurrency: number;
  retries: number;
  is_active: boolean;
  next_run_at: Date | null;
  last_run_at: Date | null;
  last_run_status: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Checks whether a number matches a single cron field pattern.
 * Supports: "*", "N", "N,M,X", "N-M", and "asterisk/step".
 */
function matchesCronField(val: number, field: string): boolean {
  if (field === "*") return true;
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10);
    return !isNaN(step) && step > 0 && val % step === 0;
  }
  const parts = field.split(",");
  for (const part of parts) {
    if (part.includes("-")) {
      const [startStr, endStr] = part.split("-");
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (!isNaN(start) && !isNaN(end) && val >= start && val <= end) return true;
    } else {
      const num = parseInt(part, 10);
      if (!isNaN(num) && num === val) return true;
    }
  }
  return false;
}

/**
 * Calculates the next execution timestamp for a schedule.
 */
export function computeNextRunDate(
  scheduleType: "hourly" | "daily" | "weekly" | "custom_cron",
  cronExpression?: string | null,
  fromDate: Date = new Date(),
): Date {
  if (scheduleType === "hourly") {
    return new Date(fromDate.getTime() + 60 * 60 * 1000);
  }
  if (scheduleType === "daily") {
    return new Date(fromDate.getTime() + 24 * 60 * 60 * 1000);
  }
  if (scheduleType === "weekly") {
    return new Date(fromDate.getTime() + 7 * 24 * 60 * 60 * 1000);
  }

  // custom_cron: 5 parts (minute hour dayOfMonth month dayOfWeek)
  if (!cronExpression || cronExpression.trim() === "") {
    return new Date(fromDate.getTime() + 24 * 60 * 60 * 1000);
  }

  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) {
    // Fallback if invalid cron expression
    return new Date(fromDate.getTime() + 24 * 60 * 60 * 1000);
  }

  const [minField, hourField, domField, monthField, dowField] = parts;

  // Search ahead up to 35 days minute by minute
  const candidate = new Date(fromDate.getTime() + 60 * 1000);
  candidate.setSeconds(0, 0);

  const maxMinutes = 35 * 24 * 60;
  for (let m = 0; m < maxMinutes; m++) {
    const minute = candidate.getMinutes();
    const hour = candidate.getHours();
    const dom = candidate.getDate();
    const month = candidate.getMonth() + 1; // 1-12
    const dow = candidate.getDay(); // 0-6

    if (
      matchesCronField(minute, minField) &&
      matchesCronField(hour, hourField) &&
      matchesCronField(dom, domField) &&
      matchesCronField(month, monthField) &&
      matchesCronField(dow, dowField)
    ) {
      return candidate;
    }

    candidate.setTime(candidate.getTime() + 60 * 1000);
  }

  return new Date(fromDate.getTime() + 24 * 60 * 60 * 1000);
}

/**
 * Executes a scheduled test suite run with concurrency, retries, and flaky detection.
 */
export async function executeScheduledSuite(scheduleId: string): Promise<string | null> {
  const scheduleRes = await pool.query<TestSchedule>(
    `SELECT * FROM test_schedules WHERE id = $1 AND is_active = true`,
    [scheduleId],
  );
  const schedule = scheduleRes.rows[0];
  if (!schedule || !schedule.suite_id) return null;

  const projectRes = await pool.query<{ name: string; base_url: string }>(
    `SELECT name, base_url FROM projects WHERE id = $1`,
    [schedule.project_id],
  );
  const project = projectRes.rows[0];
  if (!project) return null;

  // Create schedule run record
  const scheduleRunRes = await pool.query<{ id: string }>(
    `INSERT INTO test_schedule_runs (schedule_id, project_id, status, started_at)
     VALUES ($1, $2, 'running', now()) RETURNING id`,
    [schedule.id, schedule.project_id],
  );
  const scheduleRunId = scheduleRunRes.rows[0].id;

  // Create test run record
  const runRes = await pool.query<{ id: string }>(
    `INSERT INTO test_runs (project_id, suite_id, run_type, status, concurrency, retries, started_at)
     VALUES ($1, $2, 'suite', 'running', $3, $4, now()) RETURNING id`,
    [schedule.project_id, schedule.suite_id, schedule.concurrency, schedule.retries],
  );
  const runId = runRes.rows[0].id;

  await pool.query(`UPDATE test_schedule_runs SET run_id = $1 WHERE id = $2`, [runId, scheduleRunId]);

  try {
    // Fetch suite members
    const membersRes = await pool.query<{
      test_case_id: string | null;
      test_case_title: string | null;
      steps: string[] | null;
      endpoint_id: string | null;
      endpoint_name: string | null;
      method: any;
      path: string | null;
      headers: Record<string, string> | null;
      body: unknown;
      expected_status: number | null;
      expected_fields: any;
      max_response_ms: number | null;
    }>(
      `SELECT sm.test_case_id, tc.title AS test_case_title, tc.steps,
              sm.endpoint_id, ae.name AS endpoint_name, ae.method, ae.path, ae.headers,
              ae.body, ae.expected_status, ae.expected_fields, ae.max_response_ms
       FROM suite_members sm
       LEFT JOIN test_cases tc ON tc.id = sm.test_case_id
       LEFT JOIN api_endpoints ae ON ae.id = sm.endpoint_id
       WHERE sm.suite_id = $1
         AND ((sm.test_case_id IS NOT NULL AND tc.review_status = 'approved')
           OR (sm.endpoint_id IS NOT NULL AND ae.review_status = 'approved'))
       ORDER BY sm.ctid`,
      [schedule.suite_id],
    );

    const members = membersRes.rows;
    const reportCases: RunReportCase[] = [];
    const executionStatuses: string[] = [];

    let passedCount = 0;
    let failedCount = 0;
    let inconclusiveCount = 0;
    let skippedCount = 0;
    let flakyCount = 0;

    await executeConcurrentPool(
      members,
      async (member) => {
        if (member.test_case_id && member.steps) {
          const resultId = randomUUID();
          const execution: ExtendedWebExecutionResult = await runWebTestWithRetries(
            project.base_url,
            member.steps,
            { runId, resultId },
            { projectId: schedule.project_id, retries: schedule.retries },
          );

          executionStatuses.push(execution.status);
          if (execution.status === "passed") passedCount++;
          else if (execution.status === "failed") failedCount++;
          else if (execution.status === "inconclusive") inconclusiveCount++;
          else if (execution.status === "skipped") skippedCount++;

          if (execution.flaky) flakyCount++;

          await pool.query(
            `INSERT INTO test_results
               (id, run_id, test_case_id, status, error_message, duration_ms, screenshot_path, trace_path, evidence, retry_count, flaky, attempts)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              resultId,
              runId,
              member.test_case_id,
              execution.status,
              execution.errorMessage ? redactSecrets(execution.errorMessage) : null,
              execution.durationMs,
              execution.screenshotPath,
              execution.tracePath ?? null,
              JSON.stringify(scrubEvidence(execution.evidence)),
              execution.retryCount,
              execution.flaky,
              JSON.stringify(execution.attempts),
            ],
          );

          reportCases.push({
            id: resultId,
            title: redactSecrets(member.test_case_title ?? "Web test case"),
            steps: member.steps.map((s) => redactSecrets(s)),
            status: execution.status,
            duration_ms: execution.durationMs,
            error_message: execution.errorMessage ? redactSecrets(execution.errorMessage) : null,
            evidence: scrubEvidence(execution.evidence),
          });
        } else if (member.endpoint_id && member.method && member.path) {
          const execution: ExtendedApiExecutionResult = await runApiTestWithRetries(
            project.base_url,
            {
              method: member.method,
              path: member.path,
              headers: member.headers ?? {},
              body: member.body,
              expected_status: member.expected_status ?? 200,
              expected_fields: member.expected_fields ?? {},
              max_response_ms: member.max_response_ms,
            },
            { retries: schedule.retries },
          );

          executionStatuses.push(execution.status);
          if (execution.status === "passed") passedCount++;
          else if (execution.status === "failed") failedCount++;
          else if (execution.status === "inconclusive") inconclusiveCount++;
          else if (execution.status === "skipped") skippedCount++;

          if (execution.flaky) flakyCount++;

          await pool.query(
            `INSERT INTO api_test_results
               (run_id, endpoint_id, status, actual_status, response_ms, error_message, response_snippet, retry_count, flaky, attempts, step_results)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              runId,
              member.endpoint_id,
              execution.status,
              execution.actualStatus,
              execution.responseMs,
              execution.errorMessage,
              execution.responseSnippet,
              execution.retryCount,
              execution.flaky,
              JSON.stringify(execution.attempts),
              JSON.stringify(execution.stepResults ?? []),
            ],
          );
        }
      },
      schedule.concurrency,
    );

    const overallStatus = classifyRunStatus(executionStatuses);
    const finishedAt = new Date();

    await pool.query(
      `UPDATE test_runs
       SET status = $1, finished_at = now(),
           flaky_count = $2, inconclusive_count = $3, skipped_count = $4, total_count = $5
       WHERE id = $6`,
      [overallStatus, flakyCount, inconclusiveCount, skippedCount, members.length, runId],
    );

    const summary = {
      total: members.length,
      passed: passedCount,
      failed: failedCount,
      inconclusive: inconclusiveCount,
      skipped: skippedCount,
      flaky: flakyCount,
      durationMs: finishedAt.getTime() - new Date().getTime(),
    };

    await pool.query(
      `UPDATE test_schedule_runs
       SET status = 'completed', completed_at = now(), summary = $1
       WHERE id = $2`,
      [JSON.stringify(summary), scheduleRunId],
    );

    const nextRun = computeNextRunDate(schedule.schedule_type, schedule.cron_expression);
    await pool.query(
      `UPDATE test_schedules
       SET last_run_at = now(), last_run_status = $1, next_run_at = $2, updated_at = now()
       WHERE id = $3`,
      [overallStatus, nextRun, schedule.id],
    );

    if (project.name) {
      await writeRunReport({
        runId,
        projectName: project.name,
        baseUrl: project.base_url,
        startedAt: new Date().toISOString(),
        finishedAt: finishedAt.toISOString(),
        tests: reportCases,
      });
    }

    return runId;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await pool.query(
      `UPDATE test_schedule_runs SET status = 'failed', completed_at = now(), error_message = $1 WHERE id = $2`,
      [errorMsg, scheduleRunId],
    );
    await pool.query(
      `UPDATE test_schedules SET last_run_status = 'failed', updated_at = now() WHERE id = $1`,
      [schedule.id],
    );
    return null;
  }
}

let schedulerTimer: NodeJS.Timeout | null = null;

/**
 * Periodically polls and executes due schedules.
 */
export async function tickScheduler(): Promise<void> {
  try {
    const dueSchedules = await pool.query<{ id: string }>(
      `SELECT id FROM test_schedules
       WHERE is_active = true AND (next_run_at IS NULL OR next_run_at <= now())
       LIMIT 5`,
    );

    for (const row of dueSchedules.rows) {
      await executeScheduledSuite(row.id).catch((err) => {
        console.error(`[Scheduler] Error running schedule ${row.id}:`, err);
      });
    }
  } catch (err) {
    // Database or connection error during poll tick
  }
}

export function startScheduler(pollIntervalMs: number = 30_000): void {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    tickScheduler().catch(() => undefined);
  }, pollIntervalMs);
  if (typeof schedulerTimer.unref === "function") {
    schedulerTimer.unref();
  }
}

export function stopScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}
