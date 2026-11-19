import { randomUUID } from "node:crypto";
import { pool } from "../../config/db";
import { env } from "../../config/env";
import { assertSafeAppiumUrl } from "../mobile/appiumClient";
import { resolveMobileDeviceConfiguration, type MobileDeviceConfiguration } from "../mobile/deviceRegistry";
import { classifyRunStatus, redactSecrets, scrubEvidence } from "../runner";
import { createApiProjectAuthState } from "../apiRunner";
import {
  executeConcurrentPool,
  runWebTestWithRetries,
  runApiTestWithRetries,
  runMobileTestWithRetries,
  type ExtendedWebExecutionResult,
  type ExtendedMobileExecutionResult,
} from "../executionManager";
import * as executionManager from "../executionManager";
import { writeRunReport, type RunReportCase } from "../runReport";
import * as runReportService from "../runReport";
import { compareRuns } from "../regressionService";
import { generateTestCases } from "../generator";
import { registerJobHandler } from "./jobQueue";
import { recordStoredArtifact } from "../storage/storageService";
import * as storageService from "../storage/storageService";
import { recordAiUsage, inMemoryMetrics } from "../observability/metricsService";
import { logger } from "../observability/logger";

/**
 * Safely updates test_runs status and counters in the database.
 * Protects against overwriting already-finalized statuses.
 * If zero rows are affected, checks whether the run was already finalized.
 * Returns true if the database confirms the run is finalized.
 */
export async function finalizeTestRunDb(
  runId: string,
  status: string,
  counts: {
    finishedAt?: Date;
    flakyCount: number;
    inconclusiveCount: number;
    skippedCount: number;
    totalCount: number;
  },
): Promise<boolean> {
  const updateRes = await pool.query(
    `UPDATE test_runs
     SET status = $1,
         finished_at = COALESCE($2, finished_at, NOW()),
         flaky_count = $3,
         inconclusive_count = $4,
         skipped_count = $5,
         total_count = $6
     WHERE id = $7 AND status NOT IN ('passed', 'failed', 'skipped', 'inconclusive')`,
    [
      status,
      counts.finishedAt ?? null,
      counts.flakyCount,
      counts.inconclusiveCount,
      counts.skippedCount,
      counts.totalCount,
      runId,
    ],
  );

  if ((updateRes.rowCount ?? 0) > 0) {
    return true;
  }

  // Handle zero affected rows: query the current status
  const checkRes = await pool.query<{ status: string }>(
    "SELECT status FROM test_runs WHERE id = $1",
    [runId],
  );
  const currentStatus = checkRes.rows[0]?.status;
  const isTerminal = Boolean(
    currentStatus && ["passed", "failed", "skipped", "inconclusive"].includes(currentStatus),
  );
  // Return true only if the existing status exactly matches the requested status
  return Boolean(isTerminal && currentStatus === status);
}

/**
 * Registers all core background job handlers.
 */
export function initializeJobHandlers(): void {
  // 1. Web Test Execution Handler
  registerJobHandler("web_execution", async (payload, job) => {
    const { runId, projectId, testCaseId, includeNonApproved, concurrency = 2, retries = 1 } = payload;

    const projectRes = await pool.query<{ name: string; base_url: string }>(
      "SELECT name, base_url FROM projects WHERE id = $1",
      [projectId],
    );
    const project = projectRes.rows[0];
    if (!project) throw new Error(`Project ${projectId} not found`);

    const testCasesRes = testCaseId
      ? await pool.query<{ id: string; title: string; steps: string[]; review_status: string }>(
          "SELECT id, title, steps, review_status FROM test_cases WHERE project_id = $1 AND id = $2",
          [projectId, testCaseId],
        )
      : await pool.query<{ id: string; title: string; steps: string[]; review_status: string }>(
          "SELECT id, title, steps, review_status FROM test_cases WHERE project_id = $1 AND ($2::boolean OR review_status = 'approved') ORDER BY created_at ASC",
          [projectId, Boolean(includeNonApproved)],
        );

    const testCases = testCasesRes.rows;
    const reportCases: RunReportCase[] = [];
    let passedCount = 0;
    let failedCount = 0;
    let inconclusiveCount = 0;
    let skippedCount = 0;
    let flakyCount = 0;

    await executeConcurrentPool(
      testCases,
      async (tc) => {
        const resultId = randomUUID();
        const shouldRun = tc.review_status === "approved" || includeNonApproved || Boolean(testCaseId);

        let execution: ExtendedWebExecutionResult;
        if (shouldRun) {
          execution = await runWebTestWithRetries(
            project.base_url,
            tc.steps,
            { runId, resultId },
            { projectId, retries },
          );
        } else {
          execution = {
            status: "skipped",
            errorMessage: "Test case is not approved",
            durationMs: 0,
            screenshotPath: null,
            tracePath: null,
            flaky: false,
            retryCount: 0,
            attempts: [],
            evidence: {
              status: "skipped",
              durationMs: 0,
              failureStep: null,
              failureStepIndex: null,
              errorMessage: "Test case is not approved",
              browserErrors: [],
              failedRequests: [],
              httpErrors: [],
              finalUrl: "",
              finalTitle: "",
              screenshotPath: null,
              tracePath: null,
              traceNote: null,
              evidencePath: null,
            },
          };
        }

        if (execution.status === "passed") passedCount++;
        else if (execution.status === "failed") {
          failedCount++;
          logger.testFailure(`Test case "${tc.title}" failed: ${execution.errorMessage}`, {
            runId,
            testCaseId: tc.id,
            errorMessage: execution.errorMessage,
          });
        } else if (execution.status === "inconclusive") inconclusiveCount++;
        else if (execution.status === "skipped") skippedCount++;

        if (execution.flaky) flakyCount++;

        inMemoryMetrics.trackTestExecution({
          status: execution.status as any,
          durationMs: execution.durationMs,
          projectId,
          executionType: "web",
        });

        // Save result to PostgreSQL
        await pool.query(
          `INSERT INTO test_results
             (id, run_id, test_case_id, status, error_message, duration_ms, screenshot_path, trace_path, evidence, retry_count, flaky, attempts)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
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
            execution.retryCount,
            execution.flaky,
            JSON.stringify(execution.attempts),
          ],
        );

        // Record artifacts in storage metadata if present
        if (execution.screenshotPath) {
          await recordStoredArtifact({
            projectId,
            runId,
            resultId,
            artifactType: "screenshot",
            storageKey: `runs/${runId}/${resultId}/screenshot.png`,
            contentType: "image/png",
          });
        }

        reportCases.push({
          id: resultId,
          title: redactSecrets(tc.title),
          steps: tc.steps.map((s) => redactSecrets(s)),
          status: execution.status,
          duration_ms: execution.durationMs,
          error_message: execution.errorMessage ? redactSecrets(execution.errorMessage) : null,
          evidence: scrubEvidence(execution.evidence),
        });
      },
      concurrency,
    );

    const overallStatus = classifyRunStatus(reportCases.map((c) => c.status));
    const finishedAt = new Date();

    await pool.query(
      `UPDATE test_runs
       SET status = $1, finished_at = $2, flaky_count = $3, inconclusive_count = $4, skipped_count = $5, total_count = $6
       WHERE id = $7`,
      [overallStatus, finishedAt, flakyCount, inconclusiveCount, skippedCount, testCases.length, runId],
    );

    // Generate HTML and JSON report
    await writeRunReport({
      runId,
      projectName: project.name,
      baseUrl: project.base_url,
      startedAt: job.startedAt?.toISOString() || new Date().toISOString(),
      finishedAt: finishedAt.toISOString(),
      tests: reportCases,
    });

    return {
      runId,
      status: overallStatus,
      totalCount: testCases.length,
      passedCount,
      failedCount,
      flakyCount,
    };
  });

  // 2. API Test Execution Handler
  registerJobHandler("api_execution", async (payload, job) => {
    const { runId, projectId, endpointId, retries = 1 } = payload;

    const projectRes = await pool.query<{ base_url: string }>(
      "SELECT base_url FROM projects WHERE id = $1",
      [projectId],
    );
    const project = projectRes.rows[0];
    if (!project) throw new Error(`Project ${projectId} not found`);

    const endpointsRes = endpointId
      ? await pool.query("SELECT * FROM api_endpoints WHERE project_id = $1 AND id = $2", [projectId, endpointId])
      : await pool.query("SELECT * FROM api_endpoints WHERE project_id = $1 AND review_status = 'approved' ORDER BY created_at ASC", [projectId]);

    const endpoints = endpointsRes.rows;
    const results: any[] = [];
    const authState = createApiProjectAuthState();

    for (const endpoint of endpoints) {
      const execution = await runApiTestWithRetries(project.base_url, endpoint, { retries, projectId, authState });
      inMemoryMetrics.trackTestExecution({
        status: execution.status as any,
        durationMs: execution.responseMs,
        projectId,
        executionType: "api",
      });

      if (execution.status === "failed") {
        logger.testFailure(`API endpoint "${endpoint.path}" [${endpoint.method}] failed: ${execution.errorMessage}`, {
          runId,
          endpointId: endpoint.id,
          actualStatus: execution.actualStatus,
        });
      }

      const insertRes = await pool.query(
        `INSERT INTO api_test_results
           (run_id, endpoint_id, status, actual_status, response_ms, error_message, response_snippet, retry_count, flaky, attempts, step_results)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          runId,
          endpoint.id,
          execution.status,
          execution.actualStatus,
          execution.responseMs,
          execution.errorMessage,
          execution.responseSnippet,
          execution.retryCount,
          execution.flaky,
          JSON.stringify(execution.attempts),
          JSON.stringify(execution.stepResults || []),
        ],
      );
      results.push(insertRes.rows[0]);
    }

    const overallStatus = classifyRunStatus(results.map((r) => r.status));
    await pool.query(
      "UPDATE test_runs SET status = $1, finished_at = NOW() WHERE id = $2",
      [overallStatus, runId],
    );

    return {
      runId,
      status: overallStatus,
      totalCount: endpoints.length,
      passedCount: results.filter((r) => r.status === "passed").length,
      failedCount: results.filter((r) => r.status === "failed").length,
    };
  });

  // 3. Mobile (Android/iOS) Test Execution Handler
  registerJobHandler("mobile_execution", async (payload, job) => {
    const {
      runId,
      projectId,
      testCaseId,
      includeNonApproved,
      retries = 1,
      appPackage = "com.android.settings",
      appActivity,
      deviceUdid: requestedDeviceUdid,
      platform = "android",
      appiumUrl: requestedAppiumUrl,
    } = payload;

    let isFinalized = false;
    let passedCount = 0;
    let failedCount = 0;
    let inconclusiveCount = 0;
    let skippedCount = 0;
    let flakyCount = 0;
    let totalCasesCount = 0;
    const reportCases: RunReportCase[] = [];

    let project: { name: string; base_url: string } | null = null;

    const finalizeRunOnFailure = async (err: unknown) => {
      if (isFinalized || !runId) return;

      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Mobile execution job ${job.id} aborted: ${errorMsg}`, err, {
        runId,
        projectId,
        error: errorMsg,
      });

      try {
        const confirmed = await finalizeTestRunDb(runId, "failed", {
          flakyCount,
          inconclusiveCount,
          skippedCount,
          totalCount: totalCasesCount,
        });
        if (confirmed) {
          isFinalized = true;
        }
      } catch (dbErr) {
        logger.error(
          `Failed to update test_runs status for failed run ${runId}: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
          dbErr,
          {
            runId,
            projectId,
            secondaryError: dbErr instanceof Error ? dbErr.message : String(dbErr),
          },
        );
      }

      try {
        await runReportService.writeRunReport({
          runId,
          projectName: project?.name || "Mobile Project",
          baseUrl: project?.base_url || "Android Emulator",
          startedAt: job.startedAt?.toISOString() || new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          tests: reportCases,
        });
      } catch {
        // Ignore secondary report failure during error finalization
      }
    };

    try {
      const projectRes = await pool.query<{ name: string; base_url: string }>(
        "SELECT name, base_url FROM projects WHERE id = $1",
        [projectId],
      );
      project = projectRes.rows[0];
      if (!project) {
        job.maxRetries = 0;
        throw new Error(`Project ${projectId} not found`);
      }
      if (platform !== "android") {
        job.maxRetries = 0;
        throw new Error("Mobile background execution currently supports Android only.");
      }

      let deviceConfiguration: MobileDeviceConfiguration;
      try {
        const resolved = await resolveMobileDeviceConfiguration(
          projectId,
          requestedDeviceUdid,
          false,
        );
        if (!resolved) {
          throw new Error("No active Android device is registered for this project.");
        }
        deviceConfiguration = resolved;
      } catch (deviceErr) {
        job.maxRetries = 0;
        const errorMsg = deviceErr instanceof Error ? deviceErr.message : String(deviceErr);
        throw new Error(`Device authorization failed: ${errorMsg}`);
      }

      const deviceUdid = deviceConfiguration.udid;
      const rawAppiumUrl = env.APPIUM_TRUSTED_REMOTE_URL
        ? env.APPIUM_URL
        : (deviceConfiguration.appiumUrl || env.APPIUM_URL);

      let appiumUrl: string;
      try {
        appiumUrl = assertSafeAppiumUrl(rawAppiumUrl, env.APPIUM_TRUSTED_REMOTE_URL).toString().replace(/\/$/, "");
      } catch (urlErr) {
        job.maxRetries = 0;
        const errorMsg = urlErr instanceof Error ? urlErr.message : String(urlErr);
        throw new Error(`Appium URL validation failed: ${errorMsg}`);
      }

      const testCasesRes = testCaseId
        ? await pool.query<{
            id: string;
            title: string;
            steps: string[];
            review_status: string;
            mobile_steps?: string[];
            app_package?: string;
            app_activity?: string;
          }>(
            `SELECT tc.id, tc.title, tc.steps, tc.review_status,
                    tca.mobile_steps, tca.app_package, tca.app_activity
             FROM test_cases tc
             LEFT JOIN test_case_automations tca ON tca.test_case_id = tc.id
             WHERE tc.project_id = $1 AND tc.id = $2`,
            [projectId, testCaseId],
          )
        : await pool.query<{
            id: string;
            title: string;
            steps: string[];
            review_status: string;
            mobile_steps?: string[];
            app_package?: string;
            app_activity?: string;
          }>(
            `SELECT tc.id, tc.title, tc.steps, tc.review_status,
                    tca.mobile_steps, tca.app_package, tca.app_activity
             FROM test_cases tc
             LEFT JOIN test_case_automations tca ON tca.test_case_id = tc.id
             WHERE tc.project_id = $1 AND ($2::boolean OR tc.review_status = 'approved')
             ORDER BY tc.created_at ASC`,
            [projectId, Boolean(includeNonApproved)],
          );

      const testCases = testCasesRes.rows;
      totalCasesCount = testCases.length;

      if (testCases.length === 0) {
        await runReportService.writeRunReport({
          runId,
          projectName: project.name,
          baseUrl: project.base_url || "Android Emulator",
          startedAt: job.startedAt?.toISOString() || new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          tests: [],
        });

        const confirmed = await finalizeTestRunDb(runId, "skipped", {
          flakyCount: 0,
          inconclusiveCount: 0,
          skippedCount: 0,
          totalCount: 0,
        });
        if (!confirmed) {
          throw new Error(`Failed to finalize test run ${runId} as skipped`);
        }
        isFinalized = true;

        return {
          runId,
          status: "skipped",
          totalCount: 0,
          passedCount: 0,
          failedCount: 0,
          inconclusiveCount: 0,
          flakyCount: 0,
          skippedCount: 0,
          message: "No approved mobile test cases found to execute.",
        };
      }

      for (const tc of testCases) {
        const resultId = randomUUID();
        const shouldRun = tc.review_status === "approved" || includeNonApproved || Boolean(testCaseId);

        const effectiveSteps =
          tc.mobile_steps && tc.mobile_steps.length > 0
            ? tc.mobile_steps
            : tc.steps;

        const effectiveAppPackage = tc.app_package || appPackage;
        const effectiveAppActivity = tc.app_activity || appActivity;

        let execution: ExtendedMobileExecutionResult;
        if (shouldRun) {
          execution = await executionManager.runMobileTestWithRetries(
            effectiveSteps,
            { runId, resultId },
            {
              projectId,
              retries,
              appPackage: effectiveAppPackage,
              appActivity: effectiveAppActivity,
              deviceUdid,
              platform,
              appiumUrl,
            },
          );
        } else {
          execution = {
            status: "skipped",
            errorMessage: "Test case is not approved",
            durationMs: 0,
            screenshotPath: null,
            deviceInfo: {
              platform,
              deviceName: deviceUdid,
              osVersion: "Android",
              udid: deviceUdid,
            },
            flaky: false,
            retryCount: 0,
            attempts: [],
            stepResults: [],
            evidence: {
              status: "skipped",
              durationMs: 0,
              failureStep: null,
              failureStepIndex: null,
              errorMessage: "Test case is not approved",
              screenshotPath: null,
              deviceLogs: [],
              crashEvidence: { crashed: false },
              stepResults: [],
              deviceInfo: {
                platform,
                deviceName: deviceUdid,
                osVersion: "Android",
                udid: deviceUdid,
              },
              evidencePath: null,
            },
          };
        }

        if (execution.status === "passed") passedCount++;
        else if (execution.status === "failed") {
          failedCount++;
          logger.testFailure(`Mobile test case "${tc.title}" failed: ${execution.errorMessage}`, {
            runId,
            testCaseId: tc.id,
            errorMessage: execution.errorMessage,
          });
        } else if (execution.status === "inconclusive") inconclusiveCount++;
        else if (execution.status === "skipped") skippedCount++;

        if (execution.flaky) flakyCount++;

        inMemoryMetrics.trackTestExecution({
          status: execution.status as any,
          durationMs: execution.durationMs,
          projectId,
          executionType: "mobile" as any,
        });

        // Save result to PostgreSQL
        await pool.query(
          `INSERT INTO test_results
             (id, run_id, test_case_id, status, error_message, duration_ms, screenshot_path, evidence, retry_count, flaky, attempts, device_info)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            resultId,
            runId,
            tc.id,
            execution.status,
            execution.errorMessage ? redactSecrets(execution.errorMessage) : null,
            execution.durationMs,
            execution.screenshotPath,
            JSON.stringify(scrubEvidence(execution.evidence as any)),
            execution.retryCount,
            execution.flaky,
            JSON.stringify(execution.attempts),
            JSON.stringify(execution.deviceInfo),
          ],
        );

        // Record artifacts in storage metadata if screenshot is present
        if (execution.screenshotPath) {
          await storageService.recordStoredArtifact({
            projectId,
            runId,
            resultId,
            artifactType: "screenshot",
            storageKey: `runs/${runId}/${resultId}/screenshot.png`,
            contentType: "image/png",
          });
        }

        reportCases.push({
          id: resultId,
          title: redactSecrets(tc.title),
          steps: effectiveSteps.map((s) => redactSecrets(s)),
          status: execution.status,
          duration_ms: execution.durationMs,
          error_message: execution.errorMessage ? redactSecrets(execution.errorMessage) : null,
          evidence: scrubEvidence(execution.evidence as any),
        });
      }

      const overallStatus = classifyRunStatus(reportCases.map((c) => c.status));
      const finishedAt = new Date();

      // Generate HTML and JSON report first
      await runReportService.writeRunReport({
        runId,
        projectName: project.name,
        baseUrl: project.base_url || "Android Emulator",
        startedAt: job.startedAt?.toISOString() || new Date().toISOString(),
        finishedAt: finishedAt.toISOString(),
        tests: reportCases,
      });

      // 2. Finalize test_runs in the database
      const confirmed = await finalizeTestRunDb(runId, overallStatus, {
        finishedAt,
        flakyCount,
        inconclusiveCount,
        skippedCount,
        totalCount: testCases.length,
      });

      // 3. Set isFinalized = true only after database update succeeds
      if (!confirmed) {
        throw new Error(`Failed to finalize test run ${runId} with status ${overallStatus}`);
      }
      isFinalized = true;

      return {
        runId,
        status: overallStatus,
        totalCount: testCases.length,
        passedCount,
        failedCount,
        inconclusiveCount,
        flakyCount,
      };
    } catch (unexpectedErr) {
      await finalizeRunOnFailure(unexpectedErr);
      throw unexpectedErr;
    }
  });

  // 4. Regression Comparison Handler
  registerJobHandler("regression_run", async (payload) => {
    const { projectId, baseRunId, targetRunId } = payload;
    const comparison = await compareRuns(baseRunId, targetRunId, projectId);
    return comparison;
  });

  // 4. AI Test Generation & Analysis Handler
  registerJobHandler("ai_generation", async (payload) => {
    const { projectId, prompt, pageData, requirementText, createdBy } = payload;
    const t0 = Date.now();

    const generated = await generateTestCases(prompt || requirementText, pageData || { elements: [] });
    const durationMs = Date.now() - t0;

    // Track approximate token telemetry
    const promptLen = (prompt || requirementText || "").length;
    const completionLen = JSON.stringify(generated).length;
    const promptTokens = Math.ceil(promptLen / 4);
    const completionTokens = Math.ceil(completionLen / 4);

    await recordAiUsage({
      projectId,
      feature: "test_generation",
      model: "gemini-2.5-flash",
      promptTokens,
      completionTokens,
      durationMs,
      createdBy,
    });

    return {
      testCaseCount: generated.length,
      generated,
      promptTokens,
      completionTokens,
    };
  });
}
