import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import {
  compareRuns,
  detectFlakyTests,
  recommendTestsForChanges,
  CrossProjectComparisonError,
  NonexistentRunError,
  InvalidRunComparisonError,
} from "../services/regressionService";
import { assertProjectAccess } from "../services/authService";

const projectParamsSchema = z.object({
  projectId: z.string().uuid(),
});

const compareQuerySchema = z.object({
  baseRunId: z.string().uuid(),
  targetRunId: z.string().uuid(),
});

const recommendBodySchema = z.object({
  changed_files: z.array(z.string().min(1)),
});

const regressionRoutes: FastifyPluginAsync = async (fastify) => {
  // Compare two specific test runs
  fastify.get<{
    Params: { projectId: string };
    Querystring: { baseRunId?: string; targetRunId?: string };
  }>("/projects/:projectId/runs/compare", async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
    }

    const query = compareQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({
        error: "Missing or invalid query parameters: baseRunId and targetRunId must be UUIDs",
      });
    }

    if (query.data.baseRunId === query.data.targetRunId) {
      return reply.code(400).send({
        error: "Cannot compare a run with itself: baseRunId and targetRunId must be distinct",
      });
    }

    // Verify project exists
    const projectCheck = await pool.query<{ id: string }>(
      "SELECT id FROM projects WHERE id = $1",
      [params.data.projectId],
    );
    if (projectCheck.rows.length === 0) {
      return reply.code(404).send({ error: `Project ${params.data.projectId} not found` });
    }

    if (request.user) {
      await assertProjectAccess(request.user, params.data.projectId, "viewer");
    }

    try {
      const comparison = await compareRuns(
        query.data.baseRunId,
        query.data.targetRunId,
        params.data.projectId,
      );
      return reply.send(comparison);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        err instanceof CrossProjectComparisonError ||
        message.includes("Cross-project") ||
        message.includes("does not belong to project")
      ) {
        return reply.code(403).send({ error: message });
      }
      if (err instanceof NonexistentRunError || message.includes("not found")) {
        return reply.code(404).send({ error: message });
      }
      if (err instanceof InvalidRunComparisonError || message.includes("Cannot compare")) {
        return reply.code(400).send({ error: message });
      }
      return reply.code(500).send({ error: message });
    }
  });

  // Automatically compare latest run with previous run
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/runs/latest-comparison",
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      // Verify project exists
      const projectCheck = await pool.query<{ id: string }>(
        "SELECT id FROM projects WHERE id = $1",
        [params.data.projectId],
      );
      if (projectCheck.rows.length === 0) {
        return reply.code(404).send({ error: `Project ${params.data.projectId} not found` });
      }

      if (request.user) {
        await assertProjectAccess(request.user, params.data.projectId, "viewer");
      }

      const recentRuns = await pool.query<{ id: string }>(
        `SELECT id FROM test_runs
         WHERE project_id = $1 AND status IN ('passed', 'failed', 'inconclusive')
         ORDER BY created_at DESC
         LIMIT 2`,
        [params.data.projectId],
      );

      if (recentRuns.rows.length < 2) {
        return reply.code(400).send({
          error: "At least two completed runs are required for comparison",
        });
      }

      const targetRunId = recentRuns.rows[0].id;
      const baseRunId = recentRuns.rows[1].id;

      try {
        const comparison = await compareRuns(baseRunId, targetRunId, params.data.projectId);
        return reply.send(comparison);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (
          err instanceof CrossProjectComparisonError ||
          message.includes("Cross-project") ||
          message.includes("does not belong to project")
        ) {
          return reply.code(403).send({ error: message });
        }
        if (err instanceof NonexistentRunError || message.includes("not found")) {
          return reply.code(404).send({ error: message });
        }
        return reply.code(500).send({ error: message });
      }
    },
  );

  // Detect flaky tests across recent runs
  fastify.get<{
    Params: { projectId: string };
    Querystring: { limit?: string };
  }>("/projects/:projectId/flaky-tests", async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
    }

    // Verify project exists
    const projectCheck = await pool.query<{ id: string }>(
      "SELECT id FROM projects WHERE id = $1",
      [params.data.projectId],
    );
    if (projectCheck.rows.length === 0) {
      return reply.code(404).send({ error: `Project ${params.data.projectId} not found` });
    }

    if (request.user) {
      await assertProjectAccess(request.user, params.data.projectId, "viewer");
    }

    const limit = request.query.limit ? parseInt(request.query.limit, 10) : 30;
    try {
      const flaky = await detectFlakyTests(params.data.projectId, isNaN(limit) ? 30 : limit);
      return reply.send({
        project_id: params.data.projectId,
        flaky_tests_count: flaky.length,
        flaky_tests: flaky,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof NonexistentRunError || message.includes("not found")) {
        return reply.code(404).send({ error: message });
      }
      return reply.code(500).send({ error: message });
    }
  });

  // Recommend tests based on changed files
  fastify.post<{ Params: { projectId: string } }>(
    "/projects/:projectId/recommend-tests",
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      // Verify project exists
      const projectCheck = await pool.query<{ id: string }>(
        "SELECT id FROM projects WHERE id = $1",
        [params.data.projectId],
      );
      if (projectCheck.rows.length === 0) {
        return reply.code(404).send({ error: `Project ${params.data.projectId} not found` });
      }

      if (request.user) {
        await assertProjectAccess(request.user, params.data.projectId, "viewer");
      }

      const body = recommendBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({
          error: "Invalid body: changed_files must be an array of non-empty strings",
        });
      }

      try {
        const result = await recommendTestsForChanges(
          params.data.projectId,
          body.data.changed_files,
        );
        return reply.send(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof NonexistentRunError || message.includes("not found")) {
          return reply.code(404).send({ error: message });
        }
        return reply.code(500).send({ error: message });
      }
    },
  );
};


export default regressionRoutes;
