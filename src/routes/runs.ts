import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { runTestCase } from "../services/runner";

const projectParamsSchema = z.object({
  projectId: z.string().uuid(),
});

const runParamsSchema = z.object({
  id: z.string().uuid(),
});

interface ProjectRow {
  id: string;
  base_url: string;
}

interface TestCaseRow {
  id: string;
  steps: string[];
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
  status: string;
  error_message: string | null;
  duration_ms: number;
  screenshot_path: string | null;
  created_at: Date;
}

const runRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { projectId: string } }>(
    "/projects/:projectId/runs",
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);

      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      const projectResult = await pool.query<ProjectRow>(
        "SELECT id, base_url FROM projects WHERE id = $1",
        [params.data.projectId],
      );
      const project = projectResult.rows[0];

      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const runResult = await pool.query<TestRunRow>(
        `INSERT INTO test_runs (id, project_id, status, started_at)
         VALUES (gen_random_uuid(), $1, 'running', now())
         RETURNING *`,
        [project.id],
      );
      const run = runResult.rows[0];

      if (!run) {
        throw new Error("Failed to create test run");
      }

      const testCasesResult = await pool.query<TestCaseRow>(
        "SELECT id, steps FROM test_cases WHERE project_id = $1 ORDER BY created_at ASC",
        [project.id],
      );
      const results: TestResultRow[] = [];

      for (const testCase of testCasesResult.rows) {
        let execution;
        try {
          execution = await runTestCase(project.base_url, testCase.steps);
        } catch (error) {
          execution = {
            status: "failed" as const,
            errorMessage: error instanceof Error ? error.message : String(error),
            durationMs: 0,
            screenshotPath: null,
          };
        }

        const result = await pool.query<TestResultRow>(
          `INSERT INTO test_results
             (id, run_id, test_case_id, status, error_message, duration_ms, screenshot_path)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [
            run.id,
            testCase.id,
            execution.status,
            execution.errorMessage ?? null,
            execution.durationMs,
            execution.screenshotPath,
          ],
        );

        const insertedResult = result.rows[0];
        if (!insertedResult) {
          throw new Error(`Failed to save result for test case ${testCase.id}`);
        }
        results.push(insertedResult);
      }

      const status = results.every((result) => result.status === "passed") ? "passed" : "failed";
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
      "SELECT * FROM test_results WHERE run_id = $1 ORDER BY created_at ASC",
      [run.id],
    );

    return { ...run, results: results.rows };
  });
};

export default runRoutes;
