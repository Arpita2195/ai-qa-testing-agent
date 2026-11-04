import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool } from "../config/db";
import { enqueueJob, getJob, listJobs, cancelJob } from "../services/jobs/jobQueue";
import type { JobType, JobStatus } from "../services/jobs/types";
import { requireAuth, requireProjectRole } from "../services/auth";
import { assertProjectAccess } from "../services/authService";
import { logger } from "../services/observability/logger";

const jobParamsSchema = z.object({
  id: z.string().uuid(),
});

const listJobsQuerySchema = z.object({
  status: z.enum(["pending", "active", "completed", "failed", "retrying", "cancelled"]).optional(),
  queueName: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const enqueueWebExecutionSchema = z.object({
  testCaseId: z.string().uuid().optional(),
  includeNonApproved: z.boolean().optional(),
  concurrency: z.number().int().min(1).max(10).optional(),
  retries: z.number().int().min(0).max(5).optional(),
});

const enqueueApiExecutionSchema = z.object({
  endpointId: z.string().uuid().optional(),
  retries: z.number().int().min(0).max(5).optional(),
});

const enqueueRegressionSchema = z.object({
  baseRunId: z.string().uuid(),
  targetRunId: z.string().uuid(),
});

const enqueueAiGenerationSchema = z.object({
  prompt: z.string().min(1).optional(),
  requirementText: z.string().min(1).optional(),
  pageData: z.record(z.string(), z.any()).optional(),
});

export const jobRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /jobs/:id
   * Retrieve background job details and execution progress.
   */
  app.get("/jobs/:id", { preHandler: [requireAuth] }, async (request, reply) => {
    const params = jobParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid job ID" });
    }

    const job = await getJob(params.data.id);
    if (!job) {
      return reply.code(404).send({ error: "Job not found" });
    }

    if (job.projectId && request.user) {
      try {
        await assertProjectAccess(request.user, job.projectId, "viewer");
      } catch (err: any) {
        return reply.code(403).send({ error: err.message });
      }
    }

    return reply.send({ job });
  });

  /**
   * GET /projects/:projectId/jobs
   * List jobs for a specific project.
   */
  app.get(
    "/projects/:projectId/jobs",
    { preHandler: [requireAuth, requireProjectRole("projectId", "viewer")] },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const query = listJobsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.code(400).send({ error: "Invalid query parameters" });
      }

      const { jobs, total } = await listJobs({
        projectId,
        status: query.data.status as JobStatus | undefined,
        queueName: query.data.queueName,
        limit: query.data.limit,
        offset: query.data.offset,
      });

      return reply.send({ jobs, total, limit: query.data.limit ?? 20, offset: query.data.offset ?? 0 });
    },
  );

  /**
   * POST /jobs/:id/cancel
   * Cancel a pending or active job.
   */
  app.post("/jobs/:id/cancel", { preHandler: [requireAuth] }, async (request, reply) => {
    const params = jobParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid job ID" });
    }

    const job = await getJob(params.data.id);
    if (!job) {
      return reply.code(404).send({ error: "Job not found" });
    }

    if (job.projectId && request.user) {
      try {
        await assertProjectAccess(request.user, job.projectId, "qa_engineer");
      } catch (err: any) {
        return reply.code(403).send({ error: err.message });
      }
    }

    const cancelled = await cancelJob(job.id);
    if (!cancelled) {
      return reply.code(400).send({ error: "Job could not be cancelled (may have already completed or failed)" });
    }

    logger.info(`Job ${job.id} cancelled by user ${request.user?.id}`, { jobId: job.id });
    return reply.send({ success: true, message: "Job cancelled successfully", jobId: job.id });
  });

  /**
   * POST /projects/:projectId/jobs/web-execution
   * Enqueue web test run as a background job.
   */
  app.post(
    "/projects/:projectId/jobs/web-execution",
    { preHandler: [requireAuth, requireProjectRole("projectId", "qa_engineer")] },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const body = enqueueWebExecutionSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: body.error.issues.map((i) => i.message).join(", ") });
      }

      // Create pending test_run entry in PostgreSQL
      const runId = randomUUID();
      await pool.query(
        `INSERT INTO test_runs (id, project_id, status, started_at)
         VALUES ($1, $2, 'running', NOW())`,
        [runId, projectId],
      );

      const job = await enqueueJob({
        projectId,
        queueName: "web_tests",
        jobType: "web_execution",
        payload: {
          runId,
          projectId,
          testCaseId: body.data.testCaseId,
          includeNonApproved: body.data.includeNonApproved,
          concurrency: body.data.concurrency ?? 2,
          retries: body.data.retries ?? 1,
        },
        deduplicationId: `web_run_${runId}`,
        createdBy: request.user?.id,
      });

      return reply.code(202).send({
        success: true,
        runId,
        jobId: job.id,
        status: job.status,
      });
    },
  );

  /**
   * POST /projects/:projectId/jobs/api-execution
   * Enqueue API test run as a background job.
   */
  app.post(
    "/projects/:projectId/jobs/api-execution",
    { preHandler: [requireAuth, requireProjectRole("projectId", "qa_engineer")] },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const body = enqueueApiExecutionSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: body.error.issues.map((i) => i.message).join(", ") });
      }

      const runId = randomUUID();
      await pool.query(
        `INSERT INTO test_runs (id, project_id, status, started_at)
         VALUES ($1, $2, 'running', NOW())`,
        [runId, projectId],
      );

      const job = await enqueueJob({
        projectId,
        queueName: "api_tests",
        jobType: "api_execution",
        payload: {
          runId,
          projectId,
          endpointId: body.data.endpointId,
          retries: body.data.retries ?? 1,
        },
        deduplicationId: `api_run_${runId}`,
        createdBy: request.user?.id,
      });

      return reply.code(202).send({
        success: true,
        runId,
        jobId: job.id,
        status: job.status,
      });
    },
  );

  /**
   * POST /projects/:projectId/jobs/regression-run
   * Enqueue regression comparison as a background job.
   */
  app.post(
    "/projects/:projectId/jobs/regression-run",
    { preHandler: [requireAuth, requireProjectRole("projectId", "qa_engineer")] },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const body = enqueueRegressionSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: body.error.issues.map((i) => i.message).join(", ") });
      }

      const dedupId = `regression_${projectId}_${body.data.baseRunId}_${body.data.targetRunId}`;
      const job = await enqueueJob({
        projectId,
        queueName: "regression",
        jobType: "regression_run",
        payload: {
          projectId,
          baseRunId: body.data.baseRunId,
          targetRunId: body.data.targetRunId,
        },
        deduplicationId: dedupId,
        createdBy: request.user?.id,
      });

      return reply.code(202).send({
        success: true,
        jobId: job.id,
        status: job.status,
      });
    },
  );

  /**
   * POST /projects/:projectId/jobs/ai-generation
   * Enqueue AI test generation as a background job.
   */
  app.post(
    "/projects/:projectId/jobs/ai-generation",
    { preHandler: [requireAuth, requireProjectRole("projectId", "qa_engineer")] },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const body = enqueueAiGenerationSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: body.error.issues.map((i) => i.message).join(", ") });
      }

      const job = await enqueueJob({
        projectId,
        queueName: "ai_generation",
        jobType: "ai_generation",
        payload: {
          projectId,
          prompt: body.data.prompt,
          requirementText: body.data.requirementText,
          pageData: body.data.pageData,
          createdBy: request.user?.id,
        },
        createdBy: request.user?.id,
      });

      return reply.code(202).send({
        success: true,
        jobId: job.id,
        status: job.status,
      });
    },
  );
};
