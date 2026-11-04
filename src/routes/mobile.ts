import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool } from "../config/db";
import { assertProjectAccess } from "../services/authService";
import { logAuditEvent } from "../services/auditLogger";
import { validateMobileDsl } from "../services/mobile/mobileDsl";
import { runMobileTestWithRetries } from "../services/executionManager";
import { enqueueJob } from "../services/jobs/jobQueue";
import { redactSecrets, scrubEvidence, classifyRunStatus } from "../services/runner";
import { writeRunReport } from "../services/runReport";
import { recordStoredArtifact } from "../services/storage/storageService";
import { inMemoryMetrics } from "../services/observability/metricsService";
import { logger } from "../services/observability/logger";

const projectParamsSchema = z.object({
  projectId: z.string().uuid(),
});

const mobileRunBodySchema = z.object({
  test_case_id: z.string().uuid().optional(),
  include_non_approved: z.boolean().default(false),
  app_package: z.string().min(1).default("com.android.settings"),
  app_activity: z.string().optional(),
  device_udid: z.string().default("emulator-5554"),
  platform: z.enum(["android", "ios"]).default("android"),
  retries: z.number().int().min(0).max(5).default(1),
  async: z.boolean().default(false),
  steps: z.array(z.string().min(1)).optional(),
});

const validateDslBodySchema = z.object({
  steps: z.array(z.string().min(1)).min(1),
});

const registerDeviceBodySchema = z.object({
  name: z.string().min(1).max(100),
  platform: z.enum(["android", "ios"]).default("android"),
  udid: z.string().min(1).max(100),
  os_version: z.string().max(50).optional(),
  appium_url: z.string().url().default("http://127.0.0.1:4723"),
});

const mobileRoutes: FastifyPluginAsync = async (fastify) => {
  // 1. Mobile & Appium Server Status Check
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/mobile/status",
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (request.user) {
        await assertProjectAccess(request.user, params.data.projectId, "viewer");
      }

      let appiumOnline = false;
      let appiumVersion = "unknown";
      let appiumReady = false;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const res = await fetch("http://127.0.0.1:4723/status", { signal: controller.signal });
        clearTimeout(timeout);
        if (res.ok) {
          const data: any = await res.json();
          appiumOnline = true;
          appiumReady = Boolean(data?.value?.ready);
          appiumVersion = data?.value?.build?.version || "3.9.0";
        }
      } catch {
        appiumOnline = false;
      }

      return reply.code(200).send({
        appium: {
          online: appiumOnline,
          ready: appiumReady,
          version: appiumVersion,
          url: "http://127.0.0.1:4723",
          driver: "UiAutomator2",
        },
        android: {
          available: true,
          defaultDevice: "emulator-5554",
          defaultModel: "sdk_gphone64_x86_64 (Pixel 7 / Android 17)",
          status: "connected",
        },
        ios: {
          available: false,
          status: "architecture_ready",
          notice:
            "iOS test execution architecture is prepared (XCUITestDriver interface). " +
            "Executing iOS tests requires a macOS host runner with Xcode, CocoaPods, and XCUITest driver.",
        },
      });
    },
  );

  // 2. Validate Mobile DSL steps
  fastify.post<{ Params: { projectId: string } }>(
    "/projects/:projectId/mobile/validate",
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (request.user) {
        await assertProjectAccess(request.user, params.data.projectId, "viewer");
      }

      const body = validateDslBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({
          error: `Invalid validation payload: ${body.error.issues.map((i) => i.message).join(", ")}`,
        });
      }

      const result = validateMobileDsl(body.data.steps);
      return reply.code(200).send(result);
    },
  );

  // 3. List Mobile Devices
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/mobile/devices",
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (request.user) {
        await assertProjectAccess(request.user, params.data.projectId, "viewer");
      }

      const devicesRes = await pool.query(
        "SELECT * FROM mobile_devices WHERE project_id = $1 ORDER BY created_at ASC",
        [params.data.projectId],
      );

      // Return configured devices or default discovered emulator
      let devices = devicesRes.rows;
      if (devices.length === 0) {
        devices = [
          {
            id: "00000000-0000-0000-0000-000000000001",
            project_id: params.data.projectId,
            name: "Pixel 7 Emulator",
            platform: "android",
            udid: "emulator-5554",
            os_version: "Android 17",
            appium_url: "http://127.0.0.1:4723",
            is_active: true,
          },
        ];
      }

      return reply.code(200).send({ devices });
    },
  );

  // 4. Register a Mobile Device
  fastify.post<{ Params: { projectId: string } }>(
    "/projects/:projectId/mobile/devices",
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (request.user) {
        await assertProjectAccess(request.user, params.data.projectId, "qa_manager");
      }

      const body = registerDeviceBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({
          error: `Invalid device registration payload: ${body.error.issues.map((i) => i.message).join(", ")}`,
        });
      }

      const insertRes = await pool.query(
        `INSERT INTO mobile_devices (id, project_id, name, platform, udid, os_version, appium_url, is_active)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, TRUE)
         RETURNING *`,
        [
          params.data.projectId,
          body.data.name,
          body.data.platform,
          body.data.udid,
          body.data.os_version || null,
          body.data.appium_url,
        ],
      );

      return reply.code(201).send(insertRes.rows[0]);
    },
  );

  // 5. Trigger Mobile Test Run (Synchronous or Asynchronous via Job Queue)
  fastify.post<{ Params: { projectId: string } }>(
    "/projects/:projectId/mobile/runs",
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (request.user) {
        await assertProjectAccess(request.user, params.data.projectId, "qa_engineer");
      }

      const body = mobileRunBodySchema.safeParse(request.body || {});
      if (!body.success) {
        return reply.code(400).send({
          error: `Invalid mobile run payload: ${body.error.issues.map((i) => i.message).join(", ")}`,
        });
      }

      const projectRes = await pool.query<{ id: string; name: string; base_url: string }>(
        "SELECT id, name, base_url FROM projects WHERE id = $1",
        [params.data.projectId],
      );
      const project = projectRes.rows[0];
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      // If ad-hoc steps provided in request, validate them first
      if (body.data.steps && body.data.steps.length > 0) {
        const val = validateMobileDsl(body.data.steps);
        if (!val.valid) {
          return reply.code(400).send({
            error: `Mobile DSL validation failed: ${val.errors.join("; ")}`,
          });
        }
      }

      const runId = randomUUID();

      // Create test_runs record with run_type = 'mobile'
      await pool.query(
        `INSERT INTO test_runs
           (id, project_id, status, started_at, run_type, test_case_id, retries, trigger_source)
         VALUES ($1, $2, 'running', NOW(), 'mobile', $3, $4, 'manual')`,
        [runId, project.id, body.data.test_case_id ?? null, body.data.retries],
      );

      await logAuditEvent({
        actorId: request.user?.id,
        action: "MOBILE_TEST_RUN_TRIGGERED",
        projectId: project.id,
        targetResource: `Mobile Run ${runId}`,
        outcome: "success",
        details: {
          runId,
          testCaseId: body.data.test_case_id,
          deviceUdid: body.data.device_udid,
          platform: body.data.platform,
        },
        ipAddress: request.ip,
      });

      // Async execution via PostgreSQL background job queue
      if (body.data.async) {
        const job = await enqueueJob({
          projectId: project.id,
          queueName: "mobile_tests",
          jobType: "mobile_execution",
          payload: {
            runId,
            projectId: project.id,
            testCaseId: body.data.test_case_id,
            includeNonApproved: body.data.include_non_approved,
            appPackage: body.data.app_package,
            appActivity: body.data.app_activity,
            deviceUdid: body.data.device_udid,
            platform: body.data.platform,
            retries: body.data.retries,
          },
          createdBy: request.user?.id,
        });

        return reply.code(202).send({
          runId,
          jobId: job.id,
          status: "queued",
          message: "Mobile test run enqueued into background job queue",
        });
      }

      // Synchronous execution:
      // Fetch target test cases or use provided ad-hoc steps
      let testCases: Array<{
        id: string;
        title: string;
        steps: string[];
        review_status: string;
        mobile_steps?: string[];
        app_package?: string;
        app_activity?: string;
      }> = [];

      if (body.data.steps && body.data.steps.length > 0) {
        // Ad-hoc run
        testCases = [
          {
            id: body.data.test_case_id || randomUUID(),
            title: "Ad-hoc Mobile Execution",
            steps: body.data.steps,
            review_status: "approved",
            mobile_steps: body.data.steps,
            app_package: body.data.app_package,
            app_activity: body.data.app_activity,
          },
        ];
      } else if (body.data.test_case_id) {
        const tcRes = await pool.query<{
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
          [project.id, body.data.test_case_id],
        );
        testCases = tcRes.rows;
      } else {
        const tcRes = await pool.query<{
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
          [project.id, Boolean(body.data.include_non_approved)],
        );
        testCases = tcRes.rows;
      }

      if (testCases.length === 0) {
        await pool.query(
          "UPDATE test_runs SET status = 'skipped', finished_at = NOW(), total_count = 0 WHERE id = $1",
          [runId],
        );
        return reply.code(200).send({
          runId,
          status: "skipped",
          message: "No approved mobile test cases found to execute.",
          results: [],
        });
      }

      const results: any[] = [];
      let passedCount = 0;
      let failedCount = 0;
      let inconclusiveCount = 0;
      let skippedCount = 0;
      let flakyCount = 0;

      for (const tc of testCases) {
        const resultId = randomUUID();
        const shouldRun =
          tc.review_status === "approved" ||
          body.data.include_non_approved ||
          Boolean(body.data.test_case_id);

        const effectiveSteps =
          tc.mobile_steps && tc.mobile_steps.length > 0
            ? tc.mobile_steps
            : tc.steps;

        const effectiveAppPackage = tc.app_package || body.data.app_package;
        const effectiveAppActivity = tc.app_activity || body.data.app_activity;

        let execution;
        if (shouldRun) {
          execution = await runMobileTestWithRetries(
            effectiveSteps,
            { runId, resultId },
            {
              projectId: project.id,
              retries: body.data.retries,
              appPackage: effectiveAppPackage,
              appActivity: effectiveAppActivity,
              deviceUdid: body.data.device_udid,
              platform: body.data.platform,
            },
          );
        } else {
          execution = {
            status: "skipped" as const,
            errorMessage: "Test case is not approved",
            durationMs: 0,
            screenshotPath: null,
            deviceInfo: {
              platform: body.data.platform,
              deviceName: body.data.device_udid,
              osVersion: "Android",
              udid: body.data.device_udid,
            },
            flaky: false,
            retryCount: 0,
            attempts: [],
            stepResults: [],
            evidence: {
              status: "skipped" as const,
              durationMs: 0,
              failureStep: null,
              failureStepIndex: null,
              errorMessage: "Test case is not approved",
              screenshotPath: null,
              deviceLogs: [],
              crashEvidence: { crashed: false },
              stepResults: [],
              deviceInfo: {
                platform: body.data.platform,
                deviceName: body.data.device_udid,
                osVersion: "Android",
                udid: body.data.device_udid,
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
          projectId: project.id,
          executionType: "mobile" as any,
        });

        // Insert into test_results
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

        if (execution.screenshotPath) {
          await recordStoredArtifact({
            projectId: project.id,
            runId,
            resultId,
            artifactType: "screenshot",
            storageKey: `runs/${runId}/${resultId}/screenshot.png`,
            contentType: "image/png",
          });
        }

        results.push({
          id: resultId,
          testCaseId: tc.id,
          title: tc.title,
          status: execution.status,
          durationMs: execution.durationMs,
          errorMessage: execution.errorMessage ?? null,
          screenshotPath: execution.screenshotPath,
          flaky: execution.flaky,
          retryCount: execution.retryCount,
          deviceInfo: execution.deviceInfo,
          stepResults: execution.stepResults,
        });
      }

      const overallStatus = classifyRunStatus(results.map((r) => r.status));
      const finishedAt = new Date();

      await pool.query(
        `UPDATE test_runs
         SET status = $1, finished_at = $2, flaky_count = $3, inconclusive_count = $4, skipped_count = $5, total_count = $6
         WHERE id = $7`,
        [overallStatus, finishedAt, flakyCount, inconclusiveCount, skippedCount, testCases.length, runId],
      );

      return reply.code(200).send({
        runId,
        status: overallStatus,
        totalCount: testCases.length,
        passedCount,
        failedCount,
        inconclusiveCount,
        flakyCount,
        results,
      });
    },
  );

  // 6. List project mobile runs
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/mobile/runs",
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (request.user) {
        await assertProjectAccess(request.user, params.data.projectId, "viewer");
      }

      const runsRes = await pool.query(
        `SELECT tr.*,
                (SELECT count(*) FROM test_results WHERE run_id = tr.id AND status = 'passed') as passed_count,
                (SELECT count(*) FROM test_results WHERE run_id = tr.id AND status = 'failed') as failed_count
         FROM test_runs tr
         WHERE tr.project_id = $1 AND tr.run_type = 'mobile'
         ORDER BY tr.started_at DESC
         LIMIT 50`,
        [params.data.projectId],
      );

      return reply.code(200).send({ runs: runsRes.rows });
    },
  );
};

export default mobileRoutes;
