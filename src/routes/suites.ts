import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { writeRunReport, type RunReportCase } from "../services/runReport";
import { z } from "zod";
import { pool } from "../config/db";
import { runApiTest, type ApiEndpoint } from "../services/apiRunner";
import { classifyRunStatus, redactSecrets, runTestCase, scrubEvidence } from "../services/runner";

const projectParams = z.object({ projectId: z.string().uuid() });
const idParams = z.object({ id: z.string().uuid() });
const memberBody = z
  .object({
    test_case_id: z.string().uuid().optional(),
    endpoint_id: z.string().uuid().optional(),
  })
  .refine((value) => Boolean(value.test_case_id) !== Boolean(value.endpoint_id), {
    message: "Provide exactly one of test_case_id or endpoint_id",
  });
const suiteCreateBody = z.object({ name: z.string().min(1) });

interface SuiteRow {
  id: string;
  project_id: string;
  name: string;
  created_at: Date;
}

interface SuiteMemberRow {
  test_case_id: string | null;
  test_case_title: string | null;
  steps: string[] | null;
  endpoint_id: string | null;
  endpoint_name: string | null;
  method: ApiEndpoint["method"] | null;
  path: string | null;
  headers: Record<string, string> | null;
  body: unknown;
  expected_status: number | null;
  expected_fields: ApiEndpoint["expected_fields"] | null;
  max_response_ms: number | null;
}

interface RunRow {
  id: string;
  project_id: string;
  suite_id: string;
  run_type: string;
  status: string;
  started_at: Date;
  finished_at: Date | null;
  created_at: Date;
}

const suiteRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/runs",
    async (request, reply) => {
      const params = projectParams.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }
      const result = await pool.query(
        `SELECT r.*,
           COALESCE(web.passed_count, 0) + COALESCE(api.passed_count, 0) AS passed_count,
           COALESCE(web.failed_count, 0) + COALESCE(api.failed_count, 0) AS failed_count
         FROM test_runs r
         LEFT JOIN (
           SELECT run_id, COUNT(*) FILTER (WHERE status = 'passed') AS passed_count,
                  COUNT(*) FILTER (WHERE status = 'failed') AS failed_count
           FROM test_results GROUP BY run_id
         ) web ON web.run_id = r.id
         LEFT JOIN (
           SELECT run_id, COUNT(*) FILTER (WHERE status = 'passed') AS passed_count,
                  COUNT(*) FILTER (WHERE status = 'failed') AS failed_count
           FROM api_test_results GROUP BY run_id
         ) api ON api.run_id = r.id
         WHERE r.project_id = $1
         ORDER BY r.created_at DESC`,
        [params.data.projectId],
      );
      return result.rows;
    },
  );

  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/trends",
    async (request, reply) => {
      const params = projectParams.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }
      const result = await pool.query(
        `WITH recent AS (
           SELECT * FROM test_runs WHERE project_id = $1 ORDER BY created_at DESC LIMIT 20
         ), counts AS (
           SELECT run_id,
             COUNT(*) FILTER (WHERE status = 'passed') AS passed_count,
             COUNT(*) FILTER (WHERE status = 'failed') AS failed_count
           FROM (
             SELECT run_id, status FROM test_results
             UNION ALL
             SELECT run_id, status FROM api_test_results
           ) all_results
           GROUP BY run_id
         )
         SELECT r.id, r.status, r.run_type, r.created_at,
           COALESCE(c.passed_count, 0) AS passed_count,
           COALESCE(c.failed_count, 0) AS failed_count,
           CASE WHEN COALESCE(c.passed_count, 0) + COALESCE(c.failed_count, 0) = 0 THEN 0
             ELSE ROUND(
               COALESCE(c.passed_count, 0)::numeric * 100 /
               (COALESCE(c.passed_count, 0) + COALESCE(c.failed_count, 0)), 2
             )
           END AS pass_rate
         FROM recent r LEFT JOIN counts c ON c.run_id = r.id
         ORDER BY r.created_at ASC`,
        [params.data.projectId],
      );
      return result.rows;
    },
  );

  fastify.post<{ Params: { projectId: string } }>(
    "/projects/:projectId/suites",
    async (request, reply) => {
      const params = projectParams.safeParse(request.params);
      const body = suiteCreateBody.safeParse(request.body);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }
      if (!body.success) {
        return reply.code(400).send({ error: "Invalid suite body: name is required" });
      }
      const exists = await pool.query("SELECT 1 FROM projects WHERE id = $1", [params.data.projectId]);
      if (exists.rowCount === 0) {
        return reply.code(404).send({ error: "Project not found" });
      }
      const result = await pool.query<SuiteRow>(
        "INSERT INTO suites (project_id, name) VALUES ($1, $2) RETURNING *",
        [params.data.projectId, body.data.name],
      );
      return reply.code(201).send(result.rows[0]);
    },
  );

  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/suites",
    async (request, reply) => {
      const params = projectParams.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }
      const exists = await pool.query("SELECT 1 FROM projects WHERE id = $1", [params.data.projectId]);
      if (exists.rowCount === 0) {
        return reply.code(404).send({ error: "Project not found" });
      }
      const result = await pool.query<SuiteRow>(
        "SELECT * FROM suites WHERE project_id = $1 ORDER BY created_at DESC",
        [params.data.projectId],
      );
      return result.rows;
    },
  );

  fastify.post<{ Params: { id: string } }>("/suites/:id/members", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = memberBody.safeParse(request.body);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid suite id: expected a UUID" });
    }
    if (!body.success) {
      return reply.code(400).send({
        error: body.error.issues.map((issue) => issue.message).join(", "),
      });
    }

    const suiteResult = await pool.query<SuiteRow>("SELECT * FROM suites WHERE id = $1", [
      params.data.id,
    ]);
    const suite = suiteResult.rows[0];
    if (!suite) {
      return reply.code(404).send({ error: "Suite not found" });
    }

    if (body.data.test_case_id) {
      const item = await pool.query(
        "SELECT 1 FROM test_cases WHERE id = $1 AND project_id = $2 AND review_status = 'approved'",
        [body.data.test_case_id, suite.project_id],
      );
      if (item.rowCount === 0) {
        return reply.code(400).send({ error: "Test case must exist in this project and be approved" });
      }
    } else if (body.data.endpoint_id) {
      const item = await pool.query(
        "SELECT 1 FROM api_endpoints WHERE id = $1 AND project_id = $2 AND review_status = 'approved'",
        [body.data.endpoint_id, suite.project_id],
      );
      if (item.rowCount === 0) {
        return reply.code(400).send({ error: "API endpoint must exist in this project and be approved" });
      }
    }

    const result = await pool.query(
      `INSERT INTO suite_members (suite_id, test_case_id, endpoint_id)
       VALUES ($1, $2, $3) RETURNING *`,
      [params.data.id, body.data.test_case_id ?? null, body.data.endpoint_id ?? null],
    );
    return reply.code(201).send(result.rows[0]);
  });

  fastify.get<{ Params: { id: string } }>("/suites/:id", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid suite id: expected a UUID" });
    }
    const suiteResult = await pool.query<SuiteRow>("SELECT * FROM suites WHERE id = $1", [
      params.data.id,
    ]);
    const suite = suiteResult.rows[0];
    if (!suite) {
      return reply.code(404).send({ error: "Suite not found" });
    }
    const members = await pool.query(
      `SELECT sm.*, tc.title AS test_case_title, ae.name AS endpoint_name
       FROM suite_members sm
       LEFT JOIN test_cases tc ON tc.id = sm.test_case_id
       LEFT JOIN api_endpoints ae ON ae.id = sm.endpoint_id
       WHERE sm.suite_id = $1`,
      [suite.id],
    );
    return { ...suite, members: members.rows };
  });

  fastify.post<{ Params: { id: string } }>("/suites/:id/run", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid suite id: expected a UUID" });
    }
    const suiteResult = await pool.query<SuiteRow>("SELECT * FROM suites WHERE id = $1", [
      params.data.id,
    ]);
    const suite = suiteResult.rows[0];
    if (!suite) {
      return reply.code(404).send({ error: "Suite not found" });
    }
    const projectResult = await pool.query<{ name: string; base_url: string }>(
      "SELECT name, base_url FROM projects WHERE id = $1",
      [suite.project_id],
    );
    const baseUrl = projectResult.rows[0]?.base_url;
    const projectName = projectResult.rows[0]?.name;
    if (!baseUrl) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const runResult = await pool.query<RunRow>(
      `INSERT INTO test_runs (id, project_id, suite_id, run_type, status, started_at)
       VALUES (gen_random_uuid(), $1, $2, 'suite', 'running', now()) RETURNING *`,
      [suite.project_id, suite.id],
    );
    const run = runResult.rows[0];
    if (!run) {
      throw new Error("Failed to create suite run");
    }

    const members = await pool.query<SuiteMemberRow>(
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
      [suite.id],
    );
    const results: Array<Record<string, unknown>> = [];
    const reportCases: RunReportCase[] = [];
    for (const member of members.rows) {
      if (member.test_case_id && member.steps) {
        const resultId = randomUUID();
        const execution = await runTestCase(baseUrl, member.steps, { runId: run.id, resultId }, { projectId: suite.project_id });
        const saved = await pool.query(
          `INSERT INTO test_results
             (id, run_id, test_case_id, status, error_message, duration_ms, screenshot_path, trace_path, evidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
          [
            resultId,
            run.id,
            member.test_case_id,
            execution.status,
            execution.errorMessage ? redactSecrets(execution.errorMessage) : null,
            execution.durationMs,
            execution.screenshotPath,
            execution.tracePath ?? null,
            JSON.stringify(scrubEvidence(execution.evidence)),
          ],
        );
        const savedResult = {
          ...saved.rows[0],
          test_case_title: redactSecrets(member.test_case_title ?? "Web test case"),
          steps: member.steps.map((step) => redactSecrets(step)),
          error_message: saved.rows[0].error_message ? redactSecrets(saved.rows[0].error_message) : null,
          evidence: scrubEvidence(saved.rows[0].evidence),
        };
        results.push(savedResult);
        reportCases.push({
          id: resultId,
          title: redactSecrets(member.test_case_title ?? "Web test case"),
          steps: member.steps.map((step) => redactSecrets(step)),
          status: execution.status,
          duration_ms: execution.durationMs,
          error_message: execution.errorMessage ? redactSecrets(execution.errorMessage) : null,
          evidence: scrubEvidence(execution.evidence),
        });
      } else if (member.endpoint_id && member.method && member.path) {
        const execution = await runApiTest(baseUrl, {
          method: member.method,
          path: member.path,
          headers: member.headers ?? {},
          body: member.body,
          expected_status: member.expected_status ?? 200,
          expected_fields: member.expected_fields ?? {},
          max_response_ms: member.max_response_ms,
        });
        const saved = await pool.query(
          `INSERT INTO api_test_results
             (run_id, endpoint_id, status, actual_status, response_ms, error_message, response_snippet)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [
            run.id,
            member.endpoint_id,
            execution.status,
            execution.actualStatus,
            execution.responseMs,
            execution.errorMessage,
            execution.responseSnippet,
          ],
        );
        results.push({ ...saved.rows[0], endpoint_name: member.endpoint_name });
      }
    }

    const status = classifyRunStatus(results.map((result) => String(result.status)));
    const finishedAt = new Date();
    const updated = await pool.query<RunRow>(
      "UPDATE test_runs SET status = $1, finished_at = now() WHERE id = $2 RETURNING *",
      [status, run.id],
    );
    if (projectName) {
      await writeRunReport({
        runId: run.id,
        projectName,
        baseUrl,
        startedAt: new Date(run.started_at).toISOString(),
        finishedAt: finishedAt.toISOString(),
        tests: reportCases,
      });
    }
    return reply.code(201).send({ ...updated.rows[0], results });
  });
};

export default suiteRoutes;
