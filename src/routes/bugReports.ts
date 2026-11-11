import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { analyzeFailure } from "../services/failureAnalyzer";
import { readPage } from "../services/pageReader";
import { assertProjectAccess } from "../services/authService";

const idParamsSchema = z.object({
  id: z.string().uuid(),
});

const resultParamsSchema = z.object({
  resultId: z.string().uuid(),
});

const runParamsSchema = z.object({
  runId: z.string().uuid(),
});

const statusBodySchema = z.object({
  status: z.enum(["confirmed", "dismissed", "suspected"]),
});

const bugReportsQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
});

interface FailureRow {
  result_id: string;
  test_case_id: string;
  project_id: string;
  result_status: string;
  error_message: string | null;
  screenshot_path: string | null;
  title: string;
  steps: string[];
  expected_result: string | null;
  base_url: string;
}

interface BugReportRow {
  id: string;
  result_id: string | null;
  api_result_id?: string | null;
  title: string;
  description: string | null;
  severity: string | null;
  created_at: Date;
  test_case_title?: string;
  source?: "web" | "api";
}

async function loadFailure(resultId: string): Promise<FailureRow | undefined> {
  const result = await pool.query<FailureRow>(
    `SELECT tr.id AS result_id, tr.test_case_id, p.id AS project_id, tr.status AS result_status, tr.error_message,
            tr.screenshot_path, tc.title, tc.steps, tc.expected_result, p.base_url
     FROM test_results tr
     JOIN test_cases tc ON tc.id = tr.test_case_id
     JOIN test_runs run ON run.id = tr.run_id
     JOIN projects p ON p.id = run.project_id
     WHERE tr.id = $1`,
    [resultId],
  );
  return result.rows[0];
}

async function createBugReport(failure: FailureRow): Promise<BugReportRow> {
  const existing = await pool.query<BugReportRow>(
    "SELECT * FROM bug_reports WHERE result_id = $1",
    [failure.result_id],
  );
  if (existing.rows[0]) {
    return existing.rows[0];
  }

  const gotoStep = failure.steps.find((step) => step.startsWith("goto "));
  const pageUrl = gotoStep
    ? new URL(gotoStep.slice("goto ".length).trim(), failure.base_url).toString()
    : failure.base_url;
  const pageData = await readPage(pageUrl);
  const analysis = await analyzeFailure({
    title: failure.title,
    steps: failure.steps,
    expected_result: failure.expected_result,
    errorMessage: failure.error_message ?? "Test failed without an error message",
    pageUrl,
    pageText: pageData.text,
  });

  const inserted = await pool.query<BugReportRow>(
    `INSERT INTO bug_reports
       (id, result_id, test_case_id, title, description, severity, classification,
        probable_cause, reproduction_steps, evidence_path, status)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, 'suspected')
     RETURNING *`,
    [
      failure.result_id,
      failure.test_case_id,
      analysis.title,
      analysis.description,
      analysis.severity,
      analysis.classification,
      analysis.probable_cause,
      JSON.stringify(analysis.reproduction_steps),
      failure.screenshot_path,
    ],
  );

  const report = inserted.rows[0];
  if (!report) {
    throw new Error(`Failed to save bug report for result ${failure.result_id}`);
  }
  return report;
}

const bugReportRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { resultId: string } }>(
    "/results/:resultId/analyze",
    async (request, reply) => {
      const params = resultParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid resultId: expected a UUID" });
      }

      const failure = await loadFailure(params.data.resultId);
      if (!failure) {
        return reply.code(404).send({ error: "Test result not found" });
      }
      if (failure.result_status !== "failed") {
        return reply.code(400).send({ error: "Only failed test results can be analyzed" });
      }
      if (request.user) {
        await assertProjectAccess(request.user, failure.project_id, "qa_engineer");
      }

      const existing = await pool.query<BugReportRow>(
        "SELECT * FROM bug_reports WHERE result_id = $1",
        [failure.result_id],
      );
      if (existing.rows[0]) {
        return existing.rows[0];
      }

      const report = await createBugReport(failure);
      return reply.code(201).send(report);
    },
  );

  fastify.post<{ Params: { runId: string } }>(
    "/runs/:runId/analyze",
    async (request, reply) => {
      const params = runParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid runId: expected a UUID" });
      }

      const run = await pool.query<{ project_id: string }>(
        "SELECT project_id FROM test_runs WHERE id = $1",
        [params.data.runId],
      );
      if (run.rowCount === 0) {
        return reply.code(404).send({ error: "Test run not found" });
      }
      if (request.user) {
        await assertProjectAccess(request.user, run.rows[0].project_id, "qa_engineer");
      }

      const failures = await pool.query<FailureRow>(
        `SELECT tr.id AS result_id, tr.test_case_id, p.id AS project_id, tr.status AS result_status, tr.error_message,
                tr.screenshot_path, tc.title, tc.steps, tc.expected_result, p.base_url
         FROM test_results tr
         JOIN test_cases tc ON tc.id = tr.test_case_id
         JOIN test_runs run ON run.id = tr.run_id
         JOIN projects p ON p.id = run.project_id
         WHERE tr.run_id = $1 AND tr.status = 'failed'
           AND NOT EXISTS (
             SELECT 1 FROM bug_reports br WHERE br.result_id = tr.id
           )
         ORDER BY tr.created_at ASC`,
        [params.data.runId],
      );

      const reports: BugReportRow[] = [];
      const errors: Array<{ result_id: string; error: string }> = [];
      for (const failure of failures.rows) {
        try {
          reports.push(await createBugReport(failure));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          fastify.log.warn({ resultId: failure.result_id, err: error }, "Failure analysis skipped");
          errors.push({ result_id: failure.result_id, error: message });
        }
      }

      return reply.send({ reports, errors });
    },
  );

  fastify.get("/bug-reports", async (request, reply) => {
    const query = bugReportsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
    }

    if (query.data.projectId && request.user) {
      try {
        await assertProjectAccess(request.user, query.data.projectId, "viewer");
      } catch (error) {
        return reply.code(403).send({
          error: error instanceof Error ? error.message : "Access denied",
        });
      }
    }

    const userId = request.user?.id;
    const isProjectScopedUser = Boolean(request.user &&
      request.user.role !== "admin" &&
      !request.user.isServiceAccount);
    const filters: string[] = [];
    const values: string[] = [];
    if (query.data.projectId) {
      values.push(query.data.projectId);
      filters.push(
        `COALESCE(tc.project_id, web_run.project_id, api_run.project_id) = $${values.length}`,
      );
    }
    if (isProjectScopedUser && userId) {
      values.push(userId);
      filters.push(
        `EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = COALESCE(tc.project_id, web_run.project_id, api_run.project_id) AND pm.user_id = $${values.length})`,
      );
    }
    const reports = await pool.query<BugReportRow>(
      `SELECT br.*, COALESCE(tc.title, ae.name) AS test_case_title,
              CASE WHEN br.api_result_id IS NULL THEN 'web' ELSE 'api' END AS source
       FROM bug_reports br
       LEFT JOIN test_cases tc ON tc.id = br.test_case_id
       LEFT JOIN api_test_results ar ON ar.id = br.api_result_id
       LEFT JOIN api_endpoints ae ON ae.id = ar.endpoint_id
       LEFT JOIN test_results tr ON tr.id = br.result_id
       LEFT JOIN test_runs web_run ON web_run.id = tr.run_id
       LEFT JOIN test_runs api_run ON api_run.id = ar.run_id
       ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
       ORDER BY br.created_at DESC`,
      values,
    );
    return reports.rows;
  });

  fastify.get<{ Params: { id: string } }>("/bug-reports/:id", async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid bug report id: expected a UUID" });
    }

    const report = await pool.query<BugReportRow & { project_id: string }>(
      `SELECT br.*, COALESCE(tc.title, ae.name) AS test_case_title,
              COALESCE(tc.project_id, web_run.project_id, api_run.project_id) AS project_id
       FROM bug_reports br
       LEFT JOIN test_cases tc ON tc.id = br.test_case_id
       LEFT JOIN api_test_results ar ON ar.id = br.api_result_id
       LEFT JOIN api_endpoints ae ON ae.id = ar.endpoint_id
       LEFT JOIN test_results tr ON tr.id = br.result_id
       LEFT JOIN test_runs web_run ON web_run.id = tr.run_id
       LEFT JOIN test_runs api_run ON api_run.id = ar.run_id
       WHERE br.id = $1`,
      [params.data.id],
    );
    if (!report.rows[0]) {
      return reply.code(404).send({ error: "Bug report not found" });
    }
    if (request.user && report.rows[0].project_id) {
      await assertProjectAccess(request.user, report.rows[0].project_id, "viewer");
    }
    return report.rows[0];
  });

  fastify.patch<{ Params: { id: string } }>(
    "/bug-reports/:id/status",
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid bug report id: expected a UUID" });
      }

      const body = statusBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({
          error: `Invalid request body: ${body.error.issues.map((issue) => issue.message).join(", ")}`,
        });
      }

      const reportCheck = await pool.query<{ project_id: string }>(
        `SELECT COALESCE(tc.project_id, web_run.project_id, api_run.project_id) AS project_id
         FROM bug_reports br
         LEFT JOIN test_cases tc ON tc.id = br.test_case_id
         LEFT JOIN api_test_results ar ON ar.id = br.api_result_id
         LEFT JOIN test_results tr ON tr.id = br.result_id
         LEFT JOIN test_runs web_run ON web_run.id = tr.run_id
         LEFT JOIN test_runs api_run ON api_run.id = ar.run_id
         WHERE br.id = $1`,
        [params.data.id],
      );
      if (reportCheck.rowCount === 0) {
        return reply.code(404).send({ error: "Bug report not found" });
      }
      if (request.user) {
        await assertProjectAccess(request.user, reportCheck.rows[0].project_id, "qa_engineer");
      }

      const result = await pool.query<BugReportRow>(
        "UPDATE bug_reports SET status = $1 WHERE id = $2 RETURNING *",
        [body.data.status, params.data.id],
      );
      if (!result.rows[0]) {
        return reply.code(404).send({ error: "Bug report not found" });
      }
      return result.rows[0];
    },
  );
};

export default bugReportRoutes;
