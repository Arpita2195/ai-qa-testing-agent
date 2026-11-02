import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { orchestrate } from "../services/orchestrator/orchestrator";

const projectParamsSchema = z.object({
  projectId: z.string().uuid(),
});

const orchestrateBodySchema = z.object({
  intent: z.string().min(1).max(1000),
  changed_files: z.array(z.string().min(1)).optional(),
  commit_sha: z.string().min(1).max(100).optional(),
  branch: z.string().min(1).max(100).optional(),
  environment: z.string().min(1).max(50).default("test"),
  max_steps: z.number().int().min(1).max(10).default(5),
});

const orchestratorRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { projectId: string } }>(
    "/projects/:projectId/orchestrate",
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      const body = orchestrateBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({
          error: "Invalid orchestrator request body: intent is required",
          details: body.error.issues,
        });
      }

      // Verify project exists
      const projectResult = await pool.query<{ id: string }>(
        "SELECT id FROM projects WHERE id = $1",
        [params.data.projectId],
      );
      if (projectResult.rows.length === 0) {
        return reply.code(404).send({ error: "Project not found" });
      }

      try {
        const result = await orchestrate({
          projectId: params.data.projectId,
          intent: body.data.intent,
          changedFiles: body.data.changed_files,
          commitSha: body.data.commit_sha,
          branch: body.data.branch,
          environment: body.data.environment,
          maxSteps: body.data.max_steps,
        });

        return reply.code(200).send(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: `Orchestration failed: ${message}` });
      }
    },
  );
};

export default orchestratorRoutes;
