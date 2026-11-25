import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { assertProjectAccess } from "../services/authService";
import { crawlSite, getCrawledPages, getCrawlSession } from "../services/crawler";
import { enqueueJob } from "../services/jobs/jobQueue";

const paramsSchema = z.object({
  projectId: z.string().uuid(),
});

const crawlBodySchema = z.object({
  maxDepth: z.number().int().min(1).max(5).optional(),
  maxPages: z.number().int().min(1).max(50).optional(),
  timeoutMs: z.number().int().min(5000).max(300000).optional(),
  startPath: z.string().optional(),
  resume: z.boolean().optional(),
  async: z.boolean().optional(),
});

export const crawlRoutes: FastifyPluginAsync = async (fastify) => {
  // Start or trigger an autonomous crawl
  fastify.post<{ Params: { projectId: string } }>(
    "/projects/:projectId/crawl",
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (request.user) {
        await assertProjectAccess(request.user, params.data.projectId, "qa_engineer");
      }

      const body = crawlBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.code(400).send({
          error: `Invalid request body: ${body.error.issues.map((i) => i.message).join(", ")}`,
        });
      }

      const projectRes = await pool.query<{ id: string; name: string; base_url: string }>(
        "SELECT id, name, base_url FROM projects WHERE id = $1",
        [params.data.projectId],
      );
      const project = projectRes.rows[0];
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      // Asynchronous background job mode
      if (body.data.async) {
        const job = await enqueueJob({
          projectId: project.id,
          queueName: "crawler",
          jobType: "site_crawl",
          payload: {
            projectId: project.id,
            maxDepth: body.data.maxDepth,
            maxPages: body.data.maxPages,
            timeoutMs: body.data.timeoutMs,
            startPath: body.data.startPath,
            resume: body.data.resume,
            createdBy: request.user?.id,
          },
          createdBy: request.user?.id,
        });

        return reply.code(202).send({
          message: "Autonomous crawler job enqueued",
          jobId: job.id,
          projectId: project.id,
          status: "pending",
        });
      }

      // Synchronous exploration mode
      try {
        const crawlResult = await crawlSite(project, {
          maxDepth: body.data.maxDepth,
          maxPages: body.data.maxPages,
          timeoutMs: body.data.timeoutMs,
          startPath: body.data.startPath,
          resume: body.data.resume,
          createdBy: request.user?.id,
        });

        return reply.code(200).send({
          success: crawlResult.status !== "failed",
          crawl: crawlResult,
        });
      } catch (crawlErr) {
        const message = crawlErr instanceof Error ? crawlErr.message : "Crawl failed";
        if (message.includes("already in progress")) {
          return reply.code(409).send({ error: message });
        }
        return reply.code(500).send({ error: message });
      }
    },
  );

  // Get crawl overview & latest session for project
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/crawl",
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (request.user) {
        await assertProjectAccess(request.user, params.data.projectId, "viewer");
      }

      const sessionsRes = await pool.query(
        "SELECT * FROM crawl_sessions WHERE project_id = $1 ORDER BY created_at DESC LIMIT 10",
        [params.data.projectId],
      );

      const pagesCountRes = await pool.query<{ count: string }>(
        "SELECT COUNT(*) as count FROM crawled_pages WHERE project_id = $1",
        [params.data.projectId],
      );

      return reply.code(200).send({
        projectId: params.data.projectId,
        totalCrawledPages: parseInt(pagesCountRes.rows[0]?.count || "0", 10),
        recentSessions: sessionsRes.rows,
      });
    },
  );

  // Get all crawled pages with element summaries and page types
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/crawl/pages",
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (request.user) {
        await assertProjectAccess(request.user, params.data.projectId, "viewer");
      }

      const pages = await getCrawledPages(params.data.projectId);
      return reply.code(200).send({
        projectId: params.data.projectId,
        count: pages.length,
        pages,
      });
    },
  );

  // Get a specific crawl session details
  fastify.get<{ Params: { projectId: string; sessionId: string } }>(
    "/projects/:projectId/crawl/sessions/:sessionId",
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (request.user) {
        await assertProjectAccess(request.user, params.data.projectId, "viewer");
      }

      const session = await getCrawlSession(request.params.sessionId);
      if (!session || session.project_id !== params.data.projectId) {
        return reply.code(404).send({ error: "Crawl session not found" });
      }

      const pagesRes = await pool.query(
        "SELECT id, url, path, depth, status, title, page_type, element_counts, duration_ms, created_at FROM crawled_pages WHERE session_id = $1 ORDER BY depth ASC, created_at ASC",
        [session.id],
      );

      return reply.code(200).send({
        session,
        pages: pagesRes.rows,
      });
    },
  );
};

export default crawlRoutes;

