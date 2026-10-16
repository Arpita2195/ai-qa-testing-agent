import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { generateTestCases } from "../services/generator";
import { readPage } from "../services/pageReader";

const paramsSchema = z.object({
  projectId: z.string().uuid(),
});

const bodySchema = z.object({
  path: z.string().default("/"),
});

interface ProjectRow {
  id: string;
  base_url: string;
}

const generateRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { projectId: string } }>(
    "/projects/:projectId/generate",
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      const body = bodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.code(400).send({
          error: `Invalid request body: ${body.error.issues.map((issue) => issue.message).join(", ")}`,
        });
      }

      const projectResult = await pool.query<ProjectRow>(
        "SELECT id, base_url FROM projects WHERE id = $1",
        [params.data.projectId],
      );
      const project = projectResult.rows[0];
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      let pageUrl: URL;
      try {
        pageUrl = new URL(body.data.path, project.base_url);
      } catch {
        return reply.code(400).send({ error: "Invalid path or project base URL" });
      }

      const pageData = await readPage(pageUrl.toString());
      const generatedCases = await generateTestCases(pageData);
      const rows = [];

      for (const testCase of generatedCases) {
        const result = await pool.query(
          `INSERT INTO test_cases
             (id, project_id, title, description, steps, expected_result, review_status)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'pending')
           RETURNING *`,
          [
            project.id,
            testCase.title,
            testCase.description,
            JSON.stringify(testCase.steps),
            testCase.expected_result,
          ],
        );

        if (!result.rows[0]) {
          throw new Error(`Failed to save generated test case "${testCase.title}"`);
        }
        rows.push(result.rows[0]);
      }

      return reply.code(201).send(rows);
    },
  );
};

export default generateRoutes;
