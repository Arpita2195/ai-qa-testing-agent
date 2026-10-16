import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";

const createTestCaseSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(z.string()).min(1),
  expected_result: z.string().optional(),
});

const projectParamsSchema = z.object({
  projectId: z.string().uuid(),
});

const testCaseRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { projectId: string } }>(
    "/projects/:projectId/test-cases",
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);

      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      const body = createTestCaseSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({
          error: `Invalid request body: ${body.error.issues.map((issue) => issue.message).join(", ")}`,
        });
      }

      const project = await pool.query("SELECT 1 FROM projects WHERE id = $1", [
        params.data.projectId,
      ]);

      if (project.rowCount === 0) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const result = await pool.query(
        `INSERT INTO test_cases (id, project_id, title, description, steps, expected_result)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
         RETURNING *`,
        [
          params.data.projectId,
          body.data.title,
          body.data.description ?? null,
          JSON.stringify(body.data.steps),
          body.data.expected_result ?? null,
        ],
      );

      return reply.code(201).send(result.rows[0]);
    },
  );

  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/test-cases",
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);

      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      const result = await pool.query(
        "SELECT * FROM test_cases WHERE project_id = $1 ORDER BY created_at DESC",
        [params.data.projectId],
      );

      return result.rows;
    },
  );
};

export default testCaseRoutes;
