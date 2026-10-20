import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import {
  generateSiteTestCases,
  isRetryableGeminiError,
} from "../services/generator";
import { readSite } from "../services/pageReader";
import { checkGenerateRateLimit } from "../services/rateLimiter";

const paramsSchema = z.object({
  projectId: z.string().uuid(),
});

const bodySchema = z.object({
  path: z.string().optional(),
});

interface ProjectRow {
  id: string;
  name: string;
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
        "SELECT id, name, base_url FROM projects WHERE id = $1",
        [params.data.projectId],
      );
      const project = projectResult.rows[0];
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const apiKey = (request.headers["x-api-key"] as string) || "anonymous";
      const rateLimit = checkGenerateRateLimit(apiKey);
      if (!rateLimit.allowed) {
        return reply.code(429).send({
          error: `Rate limit exceeded. Try again in ${rateLimit.retryAfterSeconds} seconds.`,
        });
      }

      let siteData;
      try {
        siteData = await readSite(project, { path: body.data.path });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to read site";
        if (
          message.includes("This app needs a login") ||
          message.includes("Session expired or login needed") ||
          message.includes("Login required but test credentials are missing") ||
          message.includes("needs manual steps")
        ) {
          return reply.code(409).send({
            error: "This app needs a login. Add test credentials or log in manually on the project page.",
            message,
          });
        }
        if (message.includes("URL rejected by security guard")) {
          return reply.code(400).send({ error: message });
        }
        return reply.code(500).send({ error: message });
      }

      let generationResult;
      try {
        generationResult = await generateSiteTestCases(siteData, project.name);
      } catch (error) {
        if (isRetryableGeminiError(error)) {
          return reply.code(503).send({
            error: "AI service is currently unavailable. Please try again later.",
          });
        }
        const message = error instanceof Error ? error.message : "AI generation failed";
        return reply.code(500).send({ error: message });
      }

      const { testCases, skipped_invalid } = generationResult;

      const existingRows = await pool.query<{ title: string }>(
        "SELECT title FROM test_cases WHERE project_id = $1",
        [project.id],
      );
      const existingTitles = new Set(existingRows.rows.map((row) => row.title));

      let skipped_duplicate = 0;
      const createdCases = [];

      for (const testCase of testCases) {
        if (existingTitles.has(testCase.title)) {
          skipped_duplicate++;
          continue;
        }

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
        createdCases.push(result.rows[0]);
        existingTitles.add(testCase.title);
      }

      if (createdCases.length === 0) {
        return reply.code(422).send({
          error: "No test cases created",
          message: `AI generated no new test cases: ${skipped_invalid} invalid, ${skipped_duplicate} duplicate`,
          created: 0,
          skipped_invalid,
          skipped_duplicate,
          test_cases: [],
        });
      }

      return reply.code(201).send({
        created: createdCases.length,
        skipped_invalid,
        skipped_duplicate,
        test_cases: createdCases,
      });
    },
  );
};

export default generateRoutes;
