import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { redactSecrets } from "../services/runner";
import { assertProjectAccess } from "../services/authService";

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

      if (request.user) {
        await assertProjectAccess(request.user, params.data.projectId, "qa_engineer");
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

      if (request.user) {
        await assertProjectAccess(request.user, params.data.projectId, "viewer");
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

    const tcCheck = await pool.query<{ project_id: string }>(
      "SELECT project_id FROM test_cases WHERE id = $1",
      [params.data.id],
    );
    if (tcCheck.rowCount === 0) {
      return reply.code(404).send({ error: "Test case not found" });
    }

    if (request.user) {
      await assertProjectAccess(request.user, tcCheck.rows[0].project_id, "qa_manager");
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

  // Edit test case details (title, description, preconditions, steps, expected_result, priority, test_type, review_status)
  fastify.patch<{ Params: { id: string } }>("/test-cases/:id", async (request, reply) => {
    const params = reviewParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid test case id: expected a UUID" });
    }

    const updateSchema = z.object({
      title: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      preconditions: z.string().nullable().optional(),
      steps: z.array(z.string().min(1)).min(1).optional(),
      expected_result: z.string().nullable().optional(),
      priority: z.enum(["low", "medium", "high", "critical"]).optional(),
      test_type: z.enum(["positive", "negative", "boundary", "edge_case"]).optional(),
      review_status: z.enum(["pending", "approved", "rejected"]).optional(),
    });

    const body = updateSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: `Invalid request body: ${body.error.issues.map((i) => i.message).join(", ")}`,
      });
    }

    const tcCheck = await pool.query<{ project_id: string }>(
      "SELECT project_id FROM test_cases WHERE id = $1",
      [params.data.id],
    );
    if (tcCheck.rowCount === 0) {
      return reply.code(404).send({ error: "Test case not found" });
    }

    const projectId = tcCheck.rows[0].project_id;

    // RBAC: If updating review_status, require qa_manager. Otherwise, require qa_engineer.
    const requiredRole = body.data.review_status !== undefined ? "qa_manager" : "qa_engineer";
    if (request.user) {
      await assertProjectAccess(request.user, projectId, requiredRole);
    }

    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (body.data.title !== undefined) {
      updates.push(`title = $${idx++}`);
      values.push(redactSecrets(body.data.title.trim()));
    }
    if (body.data.description !== undefined) {
      updates.push(`description = $${idx++}`);
      values.push(body.data.description ? redactSecrets(body.data.description.trim()) : null);
    }
    if (body.data.preconditions !== undefined) {
      updates.push(`preconditions = $${idx++}`);
      values.push(body.data.preconditions ? redactSecrets(body.data.preconditions.trim()) : null);
    }
    if (body.data.steps !== undefined) {
      updates.push(`steps = $${idx++}`);
      values.push(JSON.stringify(body.data.steps.map((s) => redactSecrets(s.trim()))));
    }
    if (body.data.expected_result !== undefined) {
      updates.push(`expected_result = $${idx++}`);
      values.push(body.data.expected_result ? redactSecrets(body.data.expected_result.trim()) : null);
    }
    if (body.data.priority !== undefined) {
      updates.push(`priority = $${idx++}`);
      values.push(body.data.priority);
    }
    if (body.data.test_type !== undefined) {
      updates.push(`test_type = $${idx++}`);
      values.push(body.data.test_type);
    }
    if (body.data.review_status !== undefined) {
      updates.push(`review_status = $${idx++}`);
      values.push(body.data.review_status);
    }

    if (updates.length === 0) {
      return reply.code(400).send({ error: "No fields provided to update" });
    }

    values.push(params.data.id);
    const query = `UPDATE test_cases SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`;
    const result = await pool.query(query, values);

    if (result.rowCount === 0) {
      return reply.code(404).send({ error: "Test case not found" });
    }

    const row = result.rows[0];
    return {
      ...row,
      title: redactSecrets(row.title),
      description: row.description ? redactSecrets(row.description) : null,
      preconditions: row.preconditions ? redactSecrets(row.preconditions) : null,
      steps: row.steps.map((s: string) => redactSecrets(s)),
      expected_result: row.expected_result ? redactSecrets(row.expected_result) : null,
    };
  });
};

export default testCaseRoutes;
