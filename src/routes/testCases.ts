import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { redactSecrets } from "../services/runner";

const createTestCaseSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(z.string()).min(1),
  expected_result: z.string().optional(),
  review_status: z.enum(["pending", "approved", "rejected"]).optional(),
});

const projectParamsSchema = z.object({
  projectId: z.string().uuid(),
});

const reviewParamsSchema = z.object({
  id: z.string().uuid(),
});

const reviewBodySchema = z.object({
  review_status: z.enum(["pending", "approved", "rejected"]),
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

      const reviewStatus = body.data.review_status ?? "approved";
      const result = await pool.query(
        `INSERT INTO test_cases (id, project_id, title, description, steps, expected_result, review_status)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          params.data.projectId,
          redactSecrets(body.data.title),
          body.data.description ? redactSecrets(body.data.description) : null,
          JSON.stringify(body.data.steps.map((step) => redactSecrets(step))),
          body.data.expected_result ? redactSecrets(body.data.expected_result) : null,
          reviewStatus,
        ],
      );

      const row = result.rows[0];
      return reply.code(201).send({
        ...row,
        title: redactSecrets(row.title),
        description: row.description ? redactSecrets(row.description) : null,
        steps: row.steps.map((step: string) => redactSecrets(step)),
        expected_result: row.expected_result ? redactSecrets(row.expected_result) : null,
      });
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

      return result.rows.map((row) => ({
        ...row,
        title: redactSecrets(row.title),
        description: row.description ? redactSecrets(row.description) : null,
        steps: row.steps.map((step: string) => redactSecrets(step)),
        expected_result: row.expected_result ? redactSecrets(row.expected_result) : null,
      }));
    },
  );

  fastify.patch<{ Params: { id: string } }>("/test-cases/:id/review", async (request, reply) => {
    const params = reviewParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid test case id: expected a UUID" });
    }

    const body = reviewBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: `Invalid request body: ${body.error.issues.map((issue) => issue.message).join(", ")}`,
      });
    }

    const result = await pool.query(
      "UPDATE test_cases SET review_status = $1 WHERE id = $2 RETURNING *",
      [body.data.review_status, params.data.id],
    );
    if (result.rowCount === 0) {
      return reply.code(404).send({ error: "Test case not found" });
    }

    const row = result.rows[0];
    return {
      ...row,
      title: redactSecrets(row.title),
      description: row.description ? redactSecrets(row.description) : null,
      steps: row.steps.map((step: string) => redactSecrets(step)),
      expected_result: row.expected_result ? redactSecrets(row.expected_result) : null,
    };
  });
};

export default testCaseRoutes;
