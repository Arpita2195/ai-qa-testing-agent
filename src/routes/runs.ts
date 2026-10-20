import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { pool } from "../config/db";
import {
  classifyRunStatus,
  redactSecrets,
  runTestCase,
  scrubEvidence,
  type WebEvidence,
  type WebResultStatus,
} from "../services/runner";
import { writeRunReport } from "../services/runReport";

const runBodySchema = z.object({
  include_non_approved: z.boolean().default(false),
  test_case_id: z.string().uuid().optional(),
});

const projectParamsSchema = z.object({
  projectId: z.string().uuid(),
});

const runParamsSchema = z.object({
  id: z.string().uuid(),
});

interface ProjectRow {
  id: string;
  name: string;
  base_url: string;
}

interface TestCaseRow {
  id: string;
  title: string;
  steps: string[];
  review_status: string;
}

interface TestRunRow {
  id: string;
  project_id: string;
  status: string;
  started_at: Date;
  finished_at: Date | null;
  created_at: Date;
}

interface TestResultRow {
  id: string;
  run_id: string;
  test_case_id: string;
  status: WebResultStatus;
  error_message: string | null;
  duration_ms: number;
  screenshot_path: string | null;
  trace_path: string | null;
  evidence: WebEvidence;
  title: string;
  steps: string[];
  created_at: Date;
}

async function writeSkippedEvidence(runId: string, resultId: string, steps: string[]): Promise<WebEvidence> {
  const directory = path.resolve(__dirname, "../../artifacts/runs", runId, resultId);
  const evidence: WebEvidence = {
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
    evidencePath: path.join("artifacts", "runs", runId, resultId, "evidence.json"),
  };
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "evidence.json"), JSON.stringify({
    ...evidence,
    steps: steps.map((step) =>
      redactSecrets(step).replace(/{{STOCKFLOW_TEST_(?:EMAIL|PASSWORD)}}/g, "[hidden]"),
    ),
  }, null, 2), "utf8");
  return evidence;
}

const runRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { projectId: string } }>(
    "/projects/:projectId/runs",
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);

      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      const body = runBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.code(400).send({ error: "include_non_approved must be a boolean" });
      }

      const projectResult = await pool.query<ProjectRow>(
        "SELECT id, name, base_url FROM projects WHERE id = $1",
        [params.data.projectId],
      );
      const project = projectResult.rows[0];

      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const runResult = await pool.query<TestRunRow>(
        `INSERT INTO test_runs (id, project_id, status, started_at, run_type)
         VALUES (gen_random_uuid(), $1, 'running', now(), 'web')
         RETURNING *`,
        [project.id],
      );
      const run = runResult.rows[0];

      if (!run) {
        throw new Error("Failed to create test run");
      }

      const testCasesResult = body.data.test_case_id
        ? await pool.query<TestCaseRow>(
            `SELECT id, title, steps, review_status FROM test_cases
             WHERE project_id = $1 AND id = $2`,
            [project.id, body.data.test_case_id],
          )
        : await pool.query<TestCaseRow>(
            `SELECT id, title, steps, review_status FROM test_cases
             WHERE project_id = $1 AND ($2::boolean OR review_status = 'approved')
             ORDER BY created_at ASC`,
            [project.id, body.data.include_non_approved],
          );
      const results: TestResultRow[] = [];

      for (const testCase of testCasesResult.rows) {
        const resultId = randomUUID();
        const shouldRun =
          testCase.review_status === "approved" ||
          body.data.include_non_approved ||
          Boolean(body.data.test_case_id);

        const execution = shouldRun
          ? await runTestCase(project.base_url, testCase.steps, { runId: run.id, resultId }, { projectId: project.id })
          : {
              status: "skipped" as const,
              errorMessage: "Test case is not approved",
              durationMs: 0,
              screenshotPath: null,
              tracePath: null,
              evidence: await writeSkippedEvidence(run.id, resultId, testCase.steps),
            };

        const result = await pool.query<TestResultRow>(
          `INSERT INTO test_results
             (id, run_id, test_case_id, status, error_message, duration_ms, screenshot_path, trace_path, evidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING *`,
          [
            resultId,
            run.id,
            testCase.id,
            execution.status,
            execution.errorMessage ? redactSecrets(execution.errorMessage) : null,
            execution.durationMs,
            execution.screenshotPath,
            execution.tracePath ?? null,
            JSON.stringify(scrubEvidence(execution.evidence)),
          ],
        );

        const insertedResult = result.rows[0];
        if (!insertedResult) {
          throw new Error(`Failed to save result for test case ${testCase.id}`);
        }
        results.push({
          ...insertedResult,
          title: redactSecrets(testCase.title),
          steps: testCase.steps.map((step) => redactSecrets(step)),
          error_message: insertedResult.error_message ? redactSecrets(insertedResult.error_message) : null,
          evidence: scrubEvidence(insertedResult.evidence),
        });
      }

      const status = classifyRunStatus(results.map((result) => result.status));
      const finishedAt = new Date();
      const updatedRunResult = await pool.query<TestRunRow>(
        `UPDATE test_runs
         SET status = $1, finished_at = now()
         WHERE id = $2
         RETURNING *`,
        [status, run.id],
      );
      const updatedRun = updatedRunResult.rows[0];

      if (!updatedRun) {
        throw new Error(`Failed to finish test run ${run.id}`);
      }

      await writeRunReport({
        runId: run.id,
        projectName: project.name,
        baseUrl: project.base_url,
        startedAt: new Date(run.started_at).toISOString(),
        finishedAt: finishedAt.toISOString(),
        tests: results.map((result) => ({
          id: result.id,
          title: result.title,
          steps: result.steps,
          status: result.status,
          duration_ms: result.duration_ms,
          error_message: result.error_message,
          evidence: result.evidence,
        })),
      });

      return reply.code(201).send({ ...updatedRun, results });
    },
  );

  fastify.get<{ Params: { id: string } }>("/runs/:id", async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid run id: expected a UUID" });
    }

    const runResult = await pool.query<TestRunRow>("SELECT * FROM test_runs WHERE id = $1", [
      params.data.id,
    ]);
    const run = runResult.rows[0];

    if (!run) {
      return reply.code(404).send({ error: "Test run not found" });
    }

    const results = await pool.query<TestResultRow>(
      `SELECT tr.*, tc.title, tc.steps FROM test_results tr
       JOIN test_cases tc ON tc.id = tr.test_case_id
       WHERE tr.run_id = $1 ORDER BY tr.created_at ASC`,
      [run.id],
    );

    const apiResults = await pool.query(
      `SELECT r.*, e.name AS endpoint_name
       FROM api_test_results r
       JOIN api_endpoints e ON e.id = r.endpoint_id
       WHERE r.run_id = $1
       ORDER BY r.created_at ASC`,
      [run.id],
    );

    return {
      ...run,
      results: results.rows.map((result) => ({
        ...result,
        title: redactSecrets(result.title),
        steps: result.steps.map((step) => redactSecrets(step)),
        error_message: result.error_message ? redactSecrets(result.error_message) : null,
        evidence: scrubEvidence(result.evidence),
      })),
      api_results: apiResults.rows,
    };
  });
};

export default runRoutes;
