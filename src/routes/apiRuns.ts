import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { runApiTest, type ApiEndpoint, type ApiTestResult } from "../services/apiRunner";

const projectParamsSchema = z.object({ projectId: z.string().uuid() });
const idParamsSchema = z.object({ id: z.string().uuid() });

interface ProjectRow {
  id: string;
  base_url: string;
}

interface EndpointRow extends ApiEndpoint {
  id: string;
  name: string;
}

interface RunRow {
  id: string;
  project_id: string;
  status: string;
  started_at: Date;
  finished_at: Date | null;
  created_at: Date;
}

interface ApiResultRow extends ApiTestResult {
  id: string;
  run_id: string;
  endpoint_id: string;
  created_at: Date;
}

const apiRunRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { projectId: string } }>(
    "/projects/:projectId/api-runs",
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

      const runResult = await pool.query<RunRow>(
        `INSERT INTO test_runs (id, project_id, status, started_at, run_type)
         VALUES (gen_random_uuid(), $1, 'running', now(), 'api') RETURNING *`,
        [project.id],
      );
      const run = runResult.rows[0];
      if (!run) {
        throw new Error("Failed to create API test run");
      }

      const endpoints = await pool.query<EndpointRow>(
        `SELECT id, name, method, path, headers, body, expected_status,
                expected_fields, max_response_ms
         FROM api_endpoints
         WHERE project_id = $1 AND review_status = 'approved'
         ORDER BY created_at ASC`,
        [project.id],
      );
      const results: Array<ApiResultRow & { name: string }> = [];
      for (const endpoint of endpoints.rows) {
        const execution = await runApiTest(project.base_url, endpoint);
        const result = await pool.query<ApiResultRow>(
          `INSERT INTO api_test_results
             (run_id, endpoint_id, status, actual_status, response_ms, error_message, response_snippet)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [
            run.id,
            endpoint.id,
            execution.status,
            execution.actualStatus,
            execution.responseMs,
            execution.errorMessage,
            execution.responseSnippet,
          ],
        );
        if (!result.rows[0]) {
          throw new Error(`Failed to save API result for endpoint ${endpoint.id}`);
        }
        results.push({ ...result.rows[0], name: endpoint.name });
      }

      const status = results.every((result) => result.status === "passed") ? "passed" : "failed";
      const updated = await pool.query<RunRow>(
        "UPDATE test_runs SET status = $1, finished_at = now() WHERE id = $2 RETURNING *",
        [status, run.id],
      );
      if (!updated.rows[0]) {
        throw new Error(`Failed to finish API run ${run.id}`);
      }
      return reply.code(201).send({ ...updated.rows[0], results });
    },
  );

  fastify.get<{ Params: { id: string } }>("/api-runs/:id", async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid run id: expected a UUID" });
    }
    const runResult = await pool.query<RunRow>(
      "SELECT * FROM test_runs WHERE id = $1 AND run_type = 'api'",
      [params.data.id],
    );
    const run = runResult.rows[0];
    if (!run) {
      return reply.code(404).send({ error: "API run not found" });
    }
    const results = await pool.query(
      `SELECT r.*, e.name AS endpoint_name
       FROM api_test_results r JOIN api_endpoints e ON e.id = r.endpoint_id
       WHERE r.run_id = $1 ORDER BY r.created_at ASC`,
      [run.id],
    );
    return { ...run, results: results.rows };
  });
};

export default apiRunRoutes;
