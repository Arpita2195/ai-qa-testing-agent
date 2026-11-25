import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../services/auth";
import { assertProjectAccess } from "../services/authService";
import { logAuditEvent } from "../services/auditLogger";
import {
  getProjectAiConfig,
  saveProjectAiConfig,
  deleteProjectAiConfig,
  testProjectAiConfig,
} from "../services/ai/projectAiConfigService";
import {
  getProjectAiBudgetStatus,
  updateProjectAiBudgetLimits,
} from "../services/ai/aiBudgetService";
import {
  getProjectAiCacheStats,
  invalidateProjectAiCache,
} from "../services/ai/aiCacheService";
import { type AIProviderType } from "../services/ai/types";

const projectParamsSchema = z.object({
  id: z.string().uuid(),
});

const updateAiConfigSchema = z.object({
  provider: z.enum(["gemini", "openai", "ollama", "groq"]),
  model: z.string().trim().max(100).optional().nullable(),
  apiKey: z.string().trim().optional().nullable(),
  clearApiKey: z.boolean().optional(),
  baseUrl: z.string().trim().max(500).optional().nullable(),
  twoStageReviewEnabled: z.boolean().optional(),
  reviewModel: z.string().trim().max(100).optional().nullable(),
  reviewerApiKey: z.string().trim().optional().nullable(),
  clearReviewerApiKey: z.boolean().optional(),
});

const testAiConfigSchema = z.object({
  provider: z.enum(["gemini", "openai", "ollama", "groq"]).optional(),
  model: z.string().trim().max(100).optional().nullable(),
  apiKey: z.string().trim().optional().nullable(),
  baseUrl: z.string().trim().max(500).optional().nullable(),
  testReviewer: z.boolean().optional(),
  reviewModel: z.string().trim().max(100).optional().nullable(),
  reviewerApiKey: z.string().trim().optional().nullable(),
});

const updateAiBudgetLimitsSchema = z.object({
  usageLimitPeriod: z.enum(["monthly", "daily"]).optional(),
  maxCostLimitUsd: z.number().nonnegative().nullable().optional(),
  maxTokenLimit: z.number().int().nonnegative().nullable().optional(),
  warningThresholdPercent: z.number().min(1).max(100).optional(),
  cacheEnabled: z.boolean().optional(),
  cacheTtlSeconds: z.number().int().min(60).max(2592000).optional(),
});

export const projectAiConfigRoutes: FastifyPluginAsync = async (fastify) => {
  // 1. GET /projects/:id/ai-config (Viewer+)
  fastify.get<{ Params: { id: string } }>(
    "/projects/:id/ai-config",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (!request.user) {
        return reply.code(401).send({ error: "Authentication required" });
      }

      await assertProjectAccess(request.user, params.data.id, "viewer");

      const config = await getProjectAiConfig(params.data.id);
      return reply.code(200).send(config);
    },
  );

  // 2. PUT /projects/:id/ai-config (QA Manager / Admin only)
  fastify.put<{ Params: { id: string } }>(
    "/projects/:id/ai-config",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (!request.user) {
        return reply.code(401).send({ error: "Authentication required" });
      }

      await assertProjectAccess(request.user, params.data.id, "qa_manager");

      const body = updateAiConfigSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({
          error: `Invalid request payload: ${body.error.issues.map((i) => i.message).join(", ")}`,
        });
      }

      try {
        const auditActorId = request.user.isServiceAccount ? undefined : request.user.id;
        const saved = await saveProjectAiConfig(
          params.data.id,
          {
            provider: body.data.provider as AIProviderType,
            model: body.data.model,
            apiKey: body.data.apiKey,
            clearApiKey: body.data.clearApiKey,
            baseUrl: body.data.baseUrl,
            twoStageReviewEnabled: body.data.twoStageReviewEnabled,
            reviewModel: body.data.reviewModel,
            reviewerApiKey: body.data.reviewerApiKey,
            clearReviewerApiKey: body.data.clearReviewerApiKey,
          },
          auditActorId,
        );

        // Invalidate project AI cache on configuration update
        await invalidateProjectAiCache(params.data.id);

        await logAuditEvent({
          actorId: auditActorId,
          action: "PROJECT_AI_CONFIG_UPDATED",
          projectId: params.data.id,
          outcome: "success",
          details: {
            provider: saved.provider,
            model: saved.model,
            hasApiKey: saved.hasApiKey,
            hasPrimaryApiKey: saved.hasPrimaryApiKey,
            hasReviewerApiKey: saved.hasReviewerApiKey,
            twoStageReviewEnabled: saved.twoStageReviewEnabled,
            reviewModel: saved.reviewModel,
            hasBaseUrl: Boolean(saved.baseUrl),
          },
        });

        return reply.code(200).send(saved);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: message });
      }
    },
  );

  // 3. DELETE /projects/:id/ai-config (QA Manager / Admin only)
  fastify.delete<{ Params: { id: string } }>(
    "/projects/:id/ai-config",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (!request.user) {
        return reply.code(401).send({ error: "Authentication required" });
      }

      await assertProjectAccess(request.user, params.data.id, "qa_manager");

      await deleteProjectAiConfig(params.data.id);

      // Invalidate project AI cache on configuration deletion/reset
      await invalidateProjectAiCache(params.data.id);

      const auditActorId = request.user.isServiceAccount ? undefined : request.user.id;
      await logAuditEvent({
        actorId: auditActorId,
        action: "PROJECT_AI_CONFIG_DELETED",
        projectId: params.data.id,
        outcome: "success",
        details: { resetToDefault: true },
      });

      return reply.code(200).send({
        success: true,
        message: "Project AI configuration reset to Gemini default",
      });
    },
  );

  // 4. POST /projects/:id/ai-config/test (QA Manager / Admin only)
  fastify.post<{ Params: { id: string } }>(
    "/projects/:id/ai-config/test",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (!request.user) {
        return reply.code(401).send({ error: "Authentication required" });
      }

      await assertProjectAccess(request.user, params.data.id, "qa_manager");

      const body = testAiConfigSchema.safeParse(request.body || {});
      if (!body.success) {
        return reply.code(400).send({
          error: `Invalid test request payload: ${body.error.issues.map((i) => i.message).join(", ")}`,
        });
      }

      const testResult = await testProjectAiConfig(params.data.id, {
        provider: body.data.provider as AIProviderType | undefined,
        model: body.data.model,
        apiKey: body.data.apiKey,
        baseUrl: body.data.baseUrl,
        testReviewer: body.data.testReviewer,
        reviewModel: body.data.reviewModel,
        reviewerApiKey: body.data.reviewerApiKey,
      });

      return reply.code(200).send(testResult);
    },
  );

  // 5. GET /projects/:id/ai-config/usage (Viewer+)
  fastify.get<{ Params: { id: string } }>(
    "/projects/:id/ai-config/usage",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (!request.user) {
        return reply.code(401).send({ error: "Authentication required" });
      }

      await assertProjectAccess(request.user, params.data.id, "viewer");

      const [config, budget, cache] = await Promise.all([
        getProjectAiConfig(params.data.id),
        getProjectAiBudgetStatus(params.data.id),
        getProjectAiCacheStats(params.data.id),
      ]);

      return reply.code(200).send({
        projectId: params.data.id,
        provider: config.provider,
        model: config.model,
        budget,
        cache,
      });
    },
  );

  // 6. PUT /projects/:id/ai-config/limits (QA Manager / Admin only)
  fastify.put<{ Params: { id: string } }>(
    "/projects/:id/ai-config/limits",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (!request.user) {
        return reply.code(401).send({ error: "Authentication required" });
      }

      await assertProjectAccess(request.user, params.data.id, "qa_manager");

      const body = updateAiBudgetLimitsSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({
          error: `Invalid limit parameters: ${body.error.issues.map((i) => i.message).join(", ")}`,
        });
      }

      const auditActorId = request.user.isServiceAccount ? undefined : request.user.id;
      const updatedBudget = await updateProjectAiBudgetLimits(
        params.data.id,
        body.data,
        auditActorId,
      );

      await logAuditEvent({
        actorId: auditActorId,
        action: "PROJECT_AI_BUDGET_LIMITS_UPDATED",
        projectId: params.data.id,
        outcome: "success",
        details: {
          period: updatedBudget.period,
          maxCostLimitUsd: updatedBudget.maxCostLimitUsd,
          maxTokenLimit: updatedBudget.maxTokenLimit,
          warningThresholdPercent: updatedBudget.warningThresholdPercent,
        },
      });

      return reply.code(200).send({
        success: true,
        budget: updatedBudget,
      });
    },
  );

  // 7. POST /projects/:id/ai-config/cache/clear (QA Manager / Admin only)
  fastify.post<{ Params: { id: string } }>(
    "/projects/:id/ai-config/cache/clear",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (!request.user) {
        return reply.code(401).send({ error: "Authentication required" });
      }

      await assertProjectAccess(request.user, params.data.id, "qa_manager");

      const cleared = await invalidateProjectAiCache(params.data.id);

      const auditActorId = request.user.isServiceAccount ? undefined : request.user.id;
      await logAuditEvent({
        actorId: auditActorId,
        action: "PROJECT_AI_CACHE_CLEARED",
        projectId: params.data.id,
        outcome: "success",
        details: { clearedEntries: cleared },
      });

      return reply.code(200).send({
        success: true,
        clearedEntries: cleared,
        message: `Successfully flushed ${cleared} cached AI responses for this project.`,
      });
    },
  );
};

export default projectAiConfigRoutes;
