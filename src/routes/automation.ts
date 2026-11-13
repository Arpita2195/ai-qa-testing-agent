import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool } from "../config/db";
import {
  convertTestCaseToAutomation,
  validateAutomationInstructions,
  type TestCaseAutomationInput,
} from "../services/automationConverter";
import { runTestCase, redactSecrets, scrubEvidence, type WebEvidence } from "../services/runner";
import { runApiTest, type ApiEndpoint } from "../services/apiRunner";
import { runMobileTestWithRetries } from "../services/executionManager";
import { writeRunReport } from "../services/runReport";
import { assertProjectAccess } from "../services/authService";
import { logAuditEvent } from "../services/auditLogger";
import { resolveMobileDeviceConfiguration } from "../services/mobile/deviceRegistry";

const projectParamsSchema = z.object({
  projectId: z.string().uuid(),
});

const idParamsSchema = z.object({
  id: z.string().uuid(),
});

const generateAutomationSchema = z.object({
  testCaseIds: z.array(z.string().uuid()).min(1).optional(),
  testCaseId: z.string().uuid().optional(),
}).refine((data) => data.testCaseIds || data.testCaseId, {
  message: "Either testCaseIds or testCaseId must be provided",
});

const updateAutomationSchema = z.object({
  status: z.enum(["draft", "ready", "approved", "archived"]).optional(),
  web_steps: z.array(z.string().min(1)).optional(),
  api_method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  api_path: z.string().min(1).optional(),
  api_headers: z.record(z.string(), z.string()).optional(),
  api_body: z.unknown().optional(),
  api_expected_status: z.number().int().min(100).max(599).optional(),
  api_expected_fields: z.record(
    z.string(),
    z.enum(["string", "number", "boolean", "object", "array"]),
  ).optional(),
  api_max_response_ms: z.number().int().positive().nullable().optional(),
  mobile_steps: z.array(z.string().min(1)).optional(),
  app_package: z.string().min(1).optional(),
  app_activity: z.string().min(1).optional(),
  device_udid: z.string().min(1).optional(),
  platform: z.enum(["android", "ios"]).optional(),
});

const batchRunSchema = z.object({
  automationIds: z.array(z.string().uuid()).optional(),
});

interface ProjectRow {
  id: string;
  name: string;
  base_url: string;
}

interface TestCaseRow {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  preconditions: string | null;
  steps: string[];
  expected_result: string | null;
  priority: string | null;
  test_type: string | null;
  review_status: string;
  requirement_doc_id: string | null;
}

interface AutomationRow {
  id: string;
  project_id: string;
  test_case_id: string;
  target_type: "web" | "api" | "mobile";
  status: "draft" | "ready" | "approved" | "archived";
  web_steps: string[];
  api_method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | null;
  api_path: string | null;
  api_headers: Record<string, string>;
  api_body: unknown;
  api_expected_status: number | null;
  api_expected_fields: Record<string, string>;
  api_max_response_ms: number | null;
  mobile_steps?: string[];
  app_package?: string | null;
  app_activity?: string | null;
  device_udid?: string | null;
  platform?: "android" | "ios" | null;
  confidence: number;
  reasoning: string | null;
  last_run_id: string | null;
  last_run_status: string | null;
  last_run_at: Date | null;
  last_error_message: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const automationRoutes: FastifyPluginAsync = async (fastify) => {
  // 1. Generate automation for approved test case(s)
  fastify.post<{ Params: { projectId: string } }>(
    "/projects/:projectId/automations/generate",
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (request.user) {
        await assertProjectAccess(request.user, params.data.projectId, "qa_engineer");
      }

      const body = generateAutomationSchema.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.code(400).send({
          error: `Invalid request body: ${body.error.issues.map((i) => i.message).join(", ")}`,
        });
      }

      const targetIds: string[] = body.data.testCaseIds ?? (body.data.testCaseId ? [body.data.testCaseId] : []);

      const projectRes = await pool.query<ProjectRow>(
        "SELECT id, name, base_url FROM projects WHERE id = $1",
        [params.data.projectId],
      );
      const project = projectRes.rows[0];
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      // Fetch test cases
      const testCasesRes = await pool.query<TestCaseRow>(
        `SELECT id, project_id, title, description, preconditions, steps, expected_result, priority, test_type, review_status, requirement_doc_id
         FROM test_cases
         WHERE project_id = $1 AND id = ANY($2::uuid[])`,
        [project.id, targetIds],
      );

      if (testCasesRes.rowCount === 0) {
        return reply.code(404).send({ error: "No matching test cases found for this project." });
      }

      // Requirement 1: Verify all selected test cases are approved
      const unapproved = testCasesRes.rows.filter((tc) => tc.review_status !== "approved");
      if (unapproved.length > 0) {
        return reply.code(400).send({
          error: `Cannot automate unapproved test case(s). "${unapproved[0].title}" must be approved before generating automation.`,
        });
      }

      const createdAutomations: AutomationRow[] = [];

      for (const tc of testCasesRes.rows) {
        const automationInput = await convertTestCaseToAutomation(
          {
            title: tc.title,
            description: tc.description,
            preconditions: tc.preconditions,
            steps: tc.steps,
            expected_result: tc.expected_result,
            test_type: tc.test_type,
          },
          {
            name: project.name,
            base_url: project.base_url,
          },
        );

        // Security validation (Requirement 7)
        const check = validateAutomationInstructions(automationInput);
        if (!check.valid) {
          return reply.code(400).send({
            error: `Generated automation failed security validation: ${check.errors.join("; ")}`,
          });
        }

        const isMobile = automationInput.target_type === "mobile";
        const mobileSteps = isMobile ? (automationInput as any).mobile_steps ?? [] : [];
        const appPackage = isMobile ? (automationInput as any).app_package ?? null : null;
        const appActivity = isMobile ? (automationInput as any).app_activity ?? null : null;
        const deviceUdid = isMobile ? (automationInput as any).device_udid ?? null : null;
        const platform = isMobile ? (automationInput as any).platform ?? "android" : null;

        const insertRes = await pool.query<AutomationRow>(
          `INSERT INTO test_case_automations (
             id, project_id, test_case_id, target_type, status,
             web_steps, api_method, api_path, api_headers, api_body,
             api_expected_status, api_expected_fields, api_max_response_ms,
             mobile_steps, app_package, app_activity, device_udid, platform,
             confidence, reasoning, created_by, updated_at
           ) VALUES (
             gen_random_uuid(), $1, $2, $3, 'ready',
             $4, $5, $6, $7, $8,
             $9, $10, $11,
             $12, $13, $14, $15, $16,
             $17, $18, $19, NOW()
           )
           ON CONFLICT (test_case_id) DO UPDATE SET
             target_type = EXCLUDED.target_type,
             status = 'ready',
             web_steps = EXCLUDED.web_steps,
             api_method = EXCLUDED.api_method,
             api_path = EXCLUDED.api_path,
             api_headers = EXCLUDED.api_headers,
             api_body = EXCLUDED.api_body,
             api_expected_status = EXCLUDED.api_expected_status,
             api_expected_fields = EXCLUDED.api_expected_fields,
             api_max_response_ms = EXCLUDED.api_max_response_ms,
             mobile_steps = EXCLUDED.mobile_steps,
             app_package = EXCLUDED.app_package,
             app_activity = EXCLUDED.app_activity,
             device_udid = EXCLUDED.device_udid,
             platform = EXCLUDED.platform,
             confidence = EXCLUDED.confidence,
             reasoning = EXCLUDED.reasoning,
             updated_at = NOW()
           RETURNING *`,
          [
            project.id,
            tc.id,
            automationInput.target_type,
            JSON.stringify(automationInput.target_type === "web" ? automationInput.web_steps : []),
            automationInput.target_type === "api" ? automationInput.api_method : null,
            automationInput.target_type === "api" ? automationInput.api_path : null,
            JSON.stringify(automationInput.target_type === "api" ? automationInput.api_headers : {}),
            automationInput.target_type === "api" && automationInput.api_body !== undefined
              ? JSON.stringify(automationInput.api_body)
              : null,
            automationInput.target_type === "api" ? automationInput.api_expected_status : null,
            JSON.stringify(automationInput.target_type === "api" ? automationInput.api_expected_fields : {}),
            automationInput.target_type === "api" ? automationInput.api_max_response_ms ?? null : null,
            JSON.stringify(mobileSteps),
            appPackage,
            appActivity,
            deviceUdid,
            platform,
            automationInput.confidence,
            automationInput.reasoning ?? null,
            request.user?.id ?? null,
          ],
        );

        createdAutomations.push(insertRes.rows[0]);

        await logAuditEvent({
          actorId: request.user?.id,
          action: "TEST_CASE_AUTOMATION_GENERATED",
          projectId: project.id,
          targetResource: tc.title,
          outcome: "success",
          details: {
            testCaseId: tc.id,
            automationId: insertRes.rows[0].id,
            targetType: automationInput.target_type,
          },
          ipAddress: request.ip,
        });
      }

      return reply.code(201).send({
        automations: createdAutomations,
        generated_count: createdAutomations.length,
      });
    },
  );

  // 2. List automations for a project
  fastify.get<{ Params: { projectId: string }; Querystring: { target_type?: string; status?: string } }>(
    "/projects/:projectId/automations",
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (request.user) {
        await assertProjectAccess(request.user, params.data.projectId, "viewer");
      }

      const queryParts = [
        `SELECT
           a.*,
           tc.title as test_case_title,
           tc.description as test_case_description,
           tc.preconditions as test_case_preconditions,
           tc.steps as manual_steps,
           tc.expected_result as test_case_expected_result,
           tc.test_type as test_case_type,
           tc.priority as test_case_priority,
           tc.review_status as test_case_review_status,
           rd.filename as requirement_doc_filename,
           tr.status as last_run_overall_status,
           tr.started_at as last_run_started_at
         FROM test_case_automations a
         JOIN test_cases tc ON tc.id = a.test_case_id
         LEFT JOIN requirement_documents rd ON rd.id = tc.requirement_doc_id
         LEFT JOIN test_runs tr ON tr.id = a.last_run_id
         WHERE a.project_id = $1`,
      ];
      const queryValues: any[] = [params.data.projectId];
      let valIdx = 2;

      if (request.query.target_type) {
        queryParts.push(`AND a.target_type = $${valIdx++}`);
        queryValues.push(request.query.target_type);
      }

      if (request.query.status) {
        queryParts.push(`AND a.status = $${valIdx++}`);
        queryValues.push(request.query.status);
      }

      queryParts.push("ORDER BY a.created_at DESC");

      const result = await pool.query(queryParts.join(" "), queryValues);
      return reply.code(200).send(result.rows);
    },
  );

  // 3. Get single automation details
  fastify.get<{ Params: { id: string } }>("/automations/:id", async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid automation id: expected a UUID" });
    }

    const res = await pool.query(
      `SELECT
         a.*,
         tc.title as test_case_title,
         tc.description as test_case_description,
         tc.preconditions as test_case_preconditions,
         tc.steps as manual_steps,
         tc.expected_result as test_case_expected_result,
         tc.test_type as test_case_type,
         tc.priority as test_case_priority,
         tc.review_status as test_case_review_status,
         rd.filename as requirement_doc_filename
       FROM test_case_automations a
       JOIN test_cases tc ON tc.id = a.test_case_id
       LEFT JOIN requirement_documents rd ON rd.id = tc.requirement_doc_id
       WHERE a.id = $1`,
      [params.data.id],
    );

    if (res.rowCount === 0) {
      return reply.code(404).send({ error: "Automation script not found" });
    }

    const row = res.rows[0];
    if (request.user) {
      await assertProjectAccess(request.user, row.project_id, "viewer");
    }

    return reply.code(200).send(row);
  });

  // 4. Edit automation details (Review & Edit before execution - Requirement 8)
  fastify.patch<{ Params: { id: string } }>("/automations/:id", async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid automation id: expected a UUID" });
    }

    const check = await pool.query<{ project_id: string; target_type: "web" | "api" | "mobile" }>(
      "SELECT project_id, target_type FROM test_case_automations WHERE id = $1",
      [params.data.id],
    );
    if (check.rowCount === 0) {
      return reply.code(404).send({ error: "Automation script not found" });
    }

    const automation = check.rows[0];
    if (request.user) {
      await assertProjectAccess(request.user, automation.project_id, "qa_engineer");
    }

    const body = updateAutomationSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: `Invalid request body: ${body.error.issues.map((i) => i.message).join(", ")}`,
      });
    }

    // Validate instructions before saving
    if (automation.target_type === "web" && body.data.web_steps) {
      const stepCheck = validateAutomationInstructions({
        target_type: "web",
        web_steps: body.data.web_steps,
      });
      if (!stepCheck.valid) {
        return reply.code(400).send({
          error: `Web automation instruction error: ${stepCheck.errors.join("; ")}`,
        });
      }
    } else if (automation.target_type === "api") {
      const apiCheck = validateAutomationInstructions({
        target_type: "api",
        api_method: body.data.api_method ?? "GET",
        api_path: body.data.api_path ?? "/api/test",
        api_expected_status: body.data.api_expected_status ?? 200,
        api_headers: body.data.api_headers ?? {},
      });
      if (!apiCheck.valid) {
        return reply.code(400).send({
          error: `API automation instruction error: ${apiCheck.errors.join("; ")}`,
        });
      }
    } else if (automation.target_type === "mobile" && body.data.mobile_steps) {
      const mobileCheck = validateAutomationInstructions({
        target_type: "mobile",
        mobile_steps: body.data.mobile_steps,
        app_package: body.data.app_package,
        app_activity: body.data.app_activity,
        device_udid: body.data.device_udid,
        platform: body.data.platform,
      });
      if (!mobileCheck.valid) {
        return reply.code(400).send({
          error: `Mobile automation instruction error: ${mobileCheck.errors.join("; ")}`,
        });
      }
    }

    const updates: string[] = ["updated_at = NOW()"];
    const values: any[] = [];
    let idx = 1;

    if (body.data.status !== undefined) {
      updates.push(`status = $${idx++}`);
      values.push(body.data.status);
    }
    if (body.data.web_steps !== undefined) {
      updates.push(`web_steps = $${idx++}`);
      values.push(JSON.stringify(body.data.web_steps));
    }
    if (body.data.api_method !== undefined) {
      updates.push(`api_method = $${idx++}`);
      values.push(body.data.api_method);
    }
    if (body.data.api_path !== undefined) {
      updates.push(`api_path = $${idx++}`);
      values.push(body.data.api_path.trim());
    }
    if (body.data.api_headers !== undefined) {
      updates.push(`api_headers = $${idx++}`);
      values.push(JSON.stringify(body.data.api_headers));
    }
    if (body.data.api_body !== undefined) {
      updates.push(`api_body = $${idx++}`);
      values.push(body.data.api_body !== null ? JSON.stringify(body.data.api_body) : null);
    }
    if (body.data.api_expected_status !== undefined) {
      updates.push(`api_expected_status = $${idx++}`);
      values.push(body.data.api_expected_status);
    }
    if (body.data.api_expected_fields !== undefined) {
      updates.push(`api_expected_fields = $${idx++}`);
      values.push(JSON.stringify(body.data.api_expected_fields));
    }
    if (body.data.api_max_response_ms !== undefined) {
      updates.push(`api_max_response_ms = $${idx++}`);
      values.push(body.data.api_max_response_ms);
    }
    if (body.data.mobile_steps !== undefined) {
      updates.push(`mobile_steps = $${idx++}`);
      values.push(JSON.stringify(body.data.mobile_steps));
    }
    if (body.data.app_package !== undefined) {
      updates.push(`app_package = $${idx++}`);
      values.push(body.data.app_package.trim());
    }
    if (body.data.app_activity !== undefined) {
      updates.push(`app_activity = $${idx++}`);
      values.push(body.data.app_activity.trim());
    }
    if (body.data.device_udid !== undefined) {
      updates.push(`device_udid = $${idx++}`);
      values.push(body.data.device_udid.trim());
    }
    if (body.data.platform !== undefined) {
      updates.push(`platform = $${idx++}`);
      values.push(body.data.platform);
    }

    values.push(params.data.id);
    const updateRes = await pool.query(
      `UPDATE test_case_automations SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
      values,
    );

    await logAuditEvent({
      actorId: request.user?.id,
      action: "TEST_CASE_AUTOMATION_EDITED",
      projectId: automation.project_id,
      targetResource: params.data.id,
      outcome: "success",
      ipAddress: request.ip,
    });

    return reply.code(200).send(updateRes.rows[0]);
  });

  // 5. Run single automated test case (Requirement 9 & 10)
  fastify.post<{ Params: { id: string } }>("/automations/:id/run", async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid automation id: expected a UUID" });
    }

    const autoRes = await pool.query(
      `SELECT a.*, p.base_url, p.name as project_name, tc.requirement_doc_id, tc.title as test_case_title
       FROM test_case_automations a
       JOIN projects p ON p.id = a.project_id
       JOIN test_cases tc ON tc.id = a.test_case_id
       WHERE a.id = $1`,
      [params.data.id],
    );

    if (autoRes.rowCount === 0) {
      return reply.code(404).send({ error: "Automation script not found" });
    }

    const automation = autoRes.rows[0];
    if (request.user) {
      await assertProjectAccess(request.user, automation.project_id, "qa_engineer");
    }

    // Safety check instructions
    const check = validateAutomationInstructions({
      target_type: automation.target_type,
      web_steps: automation.web_steps,
      api_method: automation.api_method,
      api_path: automation.api_path,
      api_headers: automation.api_headers,
      api_body: automation.api_body,
      api_expected_status: automation.api_expected_status,
      api_expected_fields: automation.api_expected_fields,
    } as any);

    if (!check.valid) {
      return reply.code(400).send({
        error: `Cannot execute automation: instructions failed validation: ${check.errors.join("; ")}`,
      });
    }

    const runId = randomUUID();
    const resultId = randomUUID();

    if (automation.target_type === "web") {
      // 1. Create Web Test Run
      await pool.query(
        `INSERT INTO test_runs
           (id, project_id, status, started_at, run_type, test_case_id, automation_id, requirement_doc_id)
         VALUES ($1, $2, 'running', NOW(), 'web', $3, $4, $5)`,
        [runId, automation.project_id, automation.test_case_id, automation.id, automation.requirement_doc_id],
      );

      // 2. Execute via existing Playwright runner
      const execution = await runTestCase(
        automation.base_url,
        automation.web_steps,
        { runId, resultId },
        { projectId: automation.project_id },
      );

      // 3. Save test result
      await pool.query(
        `INSERT INTO test_results
           (id, run_id, test_case_id, automation_id, status, error_message, duration_ms, screenshot_path, trace_path, evidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          resultId,
          runId,
          automation.test_case_id,
          automation.id,
          execution.status,
          execution.errorMessage ? redactSecrets(execution.errorMessage) : null,
          execution.durationMs,
          execution.screenshotPath,
          execution.tracePath ?? null,
          JSON.stringify(scrubEvidence(execution.evidence)),
        ],
      );

      // 4. Update test run
      await pool.query(
        "UPDATE test_runs SET status = $1, finished_at = NOW() WHERE id = $2",
        [execution.status, runId],
      );

      // 5. Update automation tracking
      await pool.query(
        `UPDATE test_case_automations
         SET last_run_id = $1, last_run_status = $2, last_run_at = NOW(), last_error_message = $3, updated_at = NOW()
         WHERE id = $4`,
        [runId, execution.status, execution.errorMessage ? redactSecrets(execution.errorMessage) : null, automation.id],
      );

      // 6. Write run report
      try {
        await writeRunReport({
          runId,
          projectName: automation.project_name,
          baseUrl: automation.base_url,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          tests: [
            {
              id: resultId,
              title: automation.test_case_title,
              steps: automation.web_steps,
              status: execution.status,
              duration_ms: execution.durationMs,
              error_message: execution.errorMessage ?? null,
              evidence: execution.evidence,
            },
          ],
        });
      } catch {}

      await logAuditEvent({
        actorId: request.user?.id,
        action: "AUTOMATED_TEST_EXECUTED",
        projectId: automation.project_id,
        targetResource: automation.test_case_title,
        outcome: execution.status === "passed" ? "success" : "failure",
        details: {
          automationId: automation.id,
          targetType: "web",
          status: execution.status,
          durationMs: execution.durationMs,
        },
        ipAddress: request.ip,
      });

      return reply.code(200).send({
        automation_id: automation.id,
        run_id: runId,
        result_id: resultId,
        target_type: "web",
        status: execution.status,
        duration_ms: execution.durationMs,
        screenshot_path: execution.screenshotPath,
        trace_path: execution.tracePath ?? null,
        error_message: execution.errorMessage ?? null,
        evidence: execution.evidence,
      });
    } else if (automation.target_type === "mobile") {
      if (automation.platform && automation.platform !== "android") {
        return reply.code(400).send({ error: "Mobile execution currently supports Android only." });
      }

      let deviceConfiguration;
      try {
        deviceConfiguration = await resolveMobileDeviceConfiguration(
          automation.project_id,
          automation.device_udid ?? undefined,
        );
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : "Unable to resolve an Android device",
        });
      }
      if (!deviceConfiguration) {
        return reply.code(400).send({ error: "No active Android device is registered for this project." });
      }

      // 1. Create Mobile Test Run
      await pool.query(
        `INSERT INTO test_runs
           (id, project_id, status, started_at, run_type, test_case_id, automation_id, requirement_doc_id)
         VALUES ($1, $2, 'running', NOW(), 'mobile', $3, $4, $5)`,
        [runId, automation.project_id, automation.test_case_id, automation.id, automation.requirement_doc_id],
      );

      // 2. Execute via dedicated Mobile Runner with retries
      const steps = automation.mobile_steps && automation.mobile_steps.length > 0
        ? automation.mobile_steps
        : (automation.web_steps && automation.web_steps.length > 0 ? automation.web_steps : []);

      const execution = await runMobileTestWithRetries(
        steps,
        { runId, resultId },
        {
          projectId: automation.project_id,
          appPackage: automation.app_package,
          appActivity: automation.app_activity,
          deviceUdid: deviceConfiguration.udid,
          appiumUrl: deviceConfiguration.appiumUrl,
          platform: automation.platform || "android",
        },
      );

      // 3. Save test result
      await pool.query(
        `INSERT INTO test_results
           (id, run_id, test_case_id, automation_id, status, error_message, duration_ms, screenshot_path, evidence, retry_count, flaky, attempts, device_info)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          resultId,
          runId,
          automation.test_case_id,
          automation.id,
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

      // 4. Update test run
      await pool.query(
        "UPDATE test_runs SET status = $1, finished_at = NOW(), total_count = 1, flaky_count = $2 WHERE id = $3",
        [execution.status, execution.flaky ? 1 : 0, runId],
      );

      // 5. Update automation tracking
      await pool.query(
        `UPDATE test_case_automations
         SET last_run_id = $1, last_run_status = $2, last_run_at = NOW(), last_error_message = $3, updated_at = NOW()
         WHERE id = $4`,
        [runId, execution.status, execution.errorMessage ? redactSecrets(execution.errorMessage) : null, automation.id],
      );

      // 6. Write run report
      try {
        await writeRunReport({
          runId,
          projectName: automation.project_name,
          baseUrl: automation.base_url || "android://emulator-5554",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          tests: [
            {
              id: resultId,
              title: automation.test_case_title,
              steps,
              status: execution.status,
              duration_ms: execution.durationMs,
              error_message: execution.errorMessage ?? null,
              evidence: execution.evidence as any,
            },
          ],
        });
      } catch {}

      await logAuditEvent({
        actorId: request.user?.id,
        action: "AUTOMATED_TEST_EXECUTED",
        projectId: automation.project_id,
        targetResource: automation.test_case_title,
        outcome: execution.status === "passed" ? "success" : "failure",
        details: {
          automationId: automation.id,
          targetType: "mobile",
          status: execution.status,
          durationMs: execution.durationMs,
        },
        ipAddress: request.ip,
      });

      return reply.code(200).send({
        automation_id: automation.id,
        run_id: runId,
        result_id: resultId,
        target_type: "mobile",
        status: execution.status,
        duration_ms: execution.durationMs,
        screenshot_path: execution.screenshotPath,
        error_message: execution.errorMessage ?? null,
        evidence: execution.evidence,
        device_info: execution.deviceInfo,
      });
    } else {
      // 1. Create API Test Run
      await pool.query(
        `INSERT INTO test_runs
           (id, project_id, status, started_at, run_type, test_case_id, automation_id, requirement_doc_id)
         VALUES ($1, $2, 'running', NOW(), 'api', $3, $4, $5)`,
        [runId, automation.project_id, automation.test_case_id, automation.id, automation.requirement_doc_id],
      );

      // 2. Execute via existing API runner
      const endpointConfig: ApiEndpoint = {
        method: automation.api_method,
        path: automation.api_path,
        headers: automation.api_headers ?? {},
        body: automation.api_body,
        expected_status: automation.api_expected_status ?? 200,
        expected_fields: automation.api_expected_fields ?? {},
        max_response_ms: automation.api_max_response_ms ?? 5000,
      };

      const execution = await runApiTest(automation.base_url, endpointConfig);

      // 3. Save API test result
      await pool.query(
        `INSERT INTO api_test_results
           (id, run_id, test_case_id, automation_id, status, actual_status, response_ms, error_message, response_snippet)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          resultId,
          runId,
          automation.test_case_id,
          automation.id,
          execution.status,
          execution.actualStatus,
          execution.responseMs,
          execution.errorMessage,
          execution.responseSnippet,
        ],
      );

      // 4. Update test run
      await pool.query(
        "UPDATE test_runs SET status = $1, finished_at = NOW() WHERE id = $2",
        [execution.status, runId],
      );

      // 5. Update automation tracking
      await pool.query(
        `UPDATE test_case_automations
         SET last_run_id = $1, last_run_status = $2, last_run_at = NOW(), last_error_message = $3, updated_at = NOW()
         WHERE id = $4`,
        [runId, execution.status, execution.errorMessage, automation.id],
      );

      await logAuditEvent({
        actorId: request.user?.id,
        action: "AUTOMATED_TEST_EXECUTED",
        projectId: automation.project_id,
        targetResource: automation.test_case_title,
        outcome: execution.status === "passed" ? "success" : "failure",
        details: {
          automationId: automation.id,
          targetType: "api",
          status: execution.status,
          actualStatus: execution.actualStatus,
          expectedStatus: automation.api_expected_status,
        },
        ipAddress: request.ip,
      });

      return reply.code(200).send({
        automation_id: automation.id,
        run_id: runId,
        result_id: resultId,
        target_type: "api",
        status: execution.status,
        actual_status: execution.actualStatus,
        expected_status: automation.api_expected_status,
        duration_ms: execution.responseMs,
        error_message: execution.errorMessage,
        response_snippet: execution.responseSnippet,
      });
    }
  });

  // 6. Batch execute automations for project
  fastify.post<{ Params: { projectId: string } }>(
    "/projects/:projectId/automations/batch-run",
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (request.user) {
        await assertProjectAccess(request.user, params.data.projectId, "qa_engineer");
      }

      const body = batchRunSchema.safeParse(request.body ?? {});
      const autoIds = body.success ? body.data.automationIds : undefined;

      const projectRes = await pool.query<ProjectRow>(
        "SELECT id, name, base_url FROM projects WHERE id = $1",
        [params.data.projectId],
      );
      const project = projectRes.rows[0];
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const queryParts = [
        `SELECT a.*, tc.title as test_case_title, tc.requirement_doc_id
         FROM test_case_automations a
         JOIN test_cases tc ON tc.id = a.test_case_id
         WHERE a.project_id = $1 AND a.status IN ('ready', 'approved')`,
      ];
      const queryValues: any[] = [project.id];

      if (autoIds && autoIds.length > 0) {
        queryParts.push("AND a.id = ANY($2::uuid[])");
        queryValues.push(autoIds);
      }

      queryParts.push("ORDER BY a.created_at ASC");
      const listRes = await pool.query(queryParts.join(" "), queryValues);

      const summary = {
        total: listRes.rowCount,
        passed: 0,
        failed: 0,
        inconclusive: 0,
        results: [] as any[],
      };

      for (const auto of listRes.rows) {
        const runId = randomUUID();
        const resultId = randomUUID();

        if (auto.target_type === "web") {
          await pool.query(
            `INSERT INTO test_runs
               (id, project_id, status, started_at, run_type, test_case_id, automation_id, requirement_doc_id)
             VALUES ($1, $2, 'running', NOW(), 'web', $3, $4, $5)`,
            [runId, project.id, auto.test_case_id, auto.id, auto.requirement_doc_id],
          );

          const execution = await runTestCase(
            project.base_url,
            auto.web_steps,
            { runId, resultId },
            { projectId: project.id },
          );

          await pool.query(
            `INSERT INTO test_results
               (id, run_id, test_case_id, automation_id, status, error_message, duration_ms, screenshot_path, trace_path, evidence)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              resultId,
              runId,
              auto.test_case_id,
              auto.id,
              execution.status,
              execution.errorMessage ? redactSecrets(execution.errorMessage) : null,
              execution.durationMs,
              execution.screenshotPath,
              execution.tracePath ?? null,
              JSON.stringify(scrubEvidence(execution.evidence)),
            ],
          );

          await pool.query("UPDATE test_runs SET status = $1, finished_at = NOW() WHERE id = $2", [
            execution.status,
            runId,
          ]);

          await pool.query(
            `UPDATE test_case_automations
             SET last_run_id = $1, last_run_status = $2, last_run_at = NOW(), last_error_message = $3, updated_at = NOW()
             WHERE id = $4`,
            [runId, execution.status, execution.errorMessage ? redactSecrets(execution.errorMessage) : null, auto.id],
          );

          if (execution.status === "passed") summary.passed++;
          else if (execution.status === "failed") summary.failed++;
          else summary.inconclusive++;

          summary.results.push({
            automation_id: auto.id,
            title: auto.test_case_title,
            target_type: "web",
            status: execution.status,
            duration_ms: execution.durationMs,
          });
        } else {
          await pool.query(
            `INSERT INTO test_runs
               (id, project_id, status, started_at, run_type, test_case_id, automation_id, requirement_doc_id)
             VALUES ($1, $2, 'running', NOW(), 'api', $3, $4, $5)`,
            [runId, project.id, auto.test_case_id, auto.id, auto.requirement_doc_id],
          );

          const execution = await runApiTest(project.base_url, {
            method: auto.api_method,
            path: auto.api_path,
            headers: auto.api_headers ?? {},
            body: auto.api_body,
            expected_status: auto.api_expected_status ?? 200,
            expected_fields: auto.api_expected_fields ?? {},
            max_response_ms: auto.api_max_response_ms ?? 5000,
          });

          await pool.query(
            `INSERT INTO api_test_results
               (id, run_id, test_case_id, automation_id, status, actual_status, response_ms, error_message, response_snippet)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              resultId,
              runId,
              auto.test_case_id,
              auto.id,
              execution.status,
              execution.actualStatus,
              execution.responseMs,
              execution.errorMessage,
              execution.responseSnippet,
            ],
          );

          await pool.query("UPDATE test_runs SET status = $1, finished_at = NOW() WHERE id = $2", [
            execution.status,
            runId,
          ]);

          await pool.query(
            `UPDATE test_case_automations
             SET last_run_id = $1, last_run_status = $2, last_run_at = NOW(), last_error_message = $3, updated_at = NOW()
             WHERE id = $4`,
            [runId, execution.status, execution.errorMessage, auto.id],
          );

          if (execution.status === "passed") summary.passed++;
          else if (execution.status === "failed") summary.failed++;
          else summary.inconclusive++;

          summary.results.push({
            automation_id: auto.id,
            title: auto.test_case_title,
            target_type: "api",
            status: execution.status,
            actual_status: execution.actualStatus,
            duration_ms: execution.responseMs,
          });
        }
      }

      await logAuditEvent({
        actorId: request.user?.id,
        action: "BATCH_AUTOMATION_EXECUTED",
        projectId: project.id,
        outcome: summary.failed === 0 ? "success" : "failure",
        details: {
          total: summary.total,
          passed: summary.passed,
          failed: summary.failed,
          inconclusive: summary.inconclusive,
        },
        ipAddress: request.ip,
      });

      return reply.code(200).send(summary);
    },
  );
};

export default automationRoutes;
