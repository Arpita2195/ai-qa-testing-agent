import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { assertProjectAccess } from "../services/authService";
import { reportingService } from "../services/reportingService";
import {
  exportToCsv,
  generateStandaloneHtmlReport,
  DISCOVERY_EXPORT_COLUMNS,
  TEST_RESULTS_EXPORT_COLUMNS,
  AI_USAGE_EXPORT_COLUMNS,
} from "../services/reportExportService";

const paramsSchema = z.object({
  projectId: z.string().uuid(),
});

const exportQuerySchema = z.object({
  format: z.enum(["html", "csv", "json"]).default("html"),
  reportType: z
    .enum(["summary", "discovery", "coverage", "execution", "failures", "ai-usage"])
    .default("summary"),
  runId: z.string().uuid().optional(),
});

const failureQuerySchema = z.object({
  runId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const reportRoutes: FastifyPluginAsync = async (fastify) => {
  // Helper to validate project existence and viewer authorization
  async function validateProjectAccess(request: any, reply: any, projectId: string) {
    if (request.user) {
      await assertProjectAccess(request.user, projectId, "viewer");
    }
    const projRes = await pool.query<{ id: string; name: string }>(
      "SELECT id, name FROM projects WHERE id = $1",
      [projectId]
    );
    if (!projRes.rows[0]) {
      reply.code(404).send({ error: "Project not found" });
      return null;
    }
    return projRes.rows[0];
  }

  // 1. Executive Summary & Deterministic Project Health
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/reports/executive-summary",
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      const project = await validateProjectAccess(request, reply, params.data.projectId);
      if (!project) return;

      const summary = await reportingService.getExecutiveSummary(params.data.projectId);
      return reply.code(200).send(summary);
    }
  );

  // 2. Canonical Website Discovery Report
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/reports/discovery",
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      const project = await validateProjectAccess(request, reply, params.data.projectId);
      if (!project) return;

      const metrics = await reportingService.getDiscoveryMetrics(params.data.projectId);
      const pagesRes = await pool.query(
        `SELECT DISTINCT ON (url) url, path, depth, status, page_type, title, duration_ms, error_message, created_at
         FROM crawled_pages
         WHERE project_id = $1
         ORDER BY url, updated_at DESC
         LIMIT 200`,
        [params.data.projectId]
      );

      const pages = pagesRes.rows.map((r) => ({
        url: r.url,
        path: r.path,
        depth: r.depth,
        status: r.status,
        pageType: r.page_type,
        title: r.title,
        durationMs: r.duration_ms || 0,
        errorMessage: r.error_message,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
      }));

      return reply.code(200).send({
        projectId: params.data.projectId,
        totalCrawledPages: metrics.totalDiscovered,
        summary: metrics,
        pages,
      });
    }
  );

  // 3. Multi-Tier Coverage Report
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/reports/coverage",
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      const project = await validateProjectAccess(request, reply, params.data.projectId);
      if (!project) return;

      const coverage = await reportingService.getCoverageReport(params.data.projectId);
      return reply.code(200).send(coverage);
    }
  );

  // 4. Execution Telemetry (Lifetime vs Latest-Run Separated)
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/reports/execution",
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      const project = await validateProjectAccess(request, reply, params.data.projectId);
      if (!project) return;

      const execution = await reportingService.getExecutionReport(params.data.projectId);
      return reply.code(200).send(execution);
    }
  );

  // 5. Deterministic Failure Analysis & Classification
  fastify.get<{ Params: { projectId: string }; Querystring: { runId?: string; limit?: number } }>(
    "/projects/:projectId/reports/failures",
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      const query = failureQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.code(400).send({ error: "Invalid query parameters" });
      }

      const project = await validateProjectAccess(request, reply, params.data.projectId);
      if (!project) return;

      const failures = await reportingService.getFailures(params.data.projectId, {
        runId: query.data.runId,
        limit: query.data.limit,
      });

      return reply.code(200).send({
        projectId: params.data.projectId,
        totalFailures: failures.length,
        failures,
      });
    }
  );

  // 6. AI Usage & Cost Analytics
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/reports/ai-usage",
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      const project = await validateProjectAccess(request, reply, params.data.projectId);
      if (!project) return;

      const aiUsage = await reportingService.getAiUsageMetrics(params.data.projectId);
      return reply.code(200).send(aiUsage);
    }
  );

  // 7. Data and Report Export (Standalone HTML, Formula-Safe CSV, JSON)
  fastify.get<{ Params: { projectId: string }; Querystring: { format?: string; reportType?: string; runId?: string } }>(
    "/projects/:projectId/reports/export",
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      const query = exportQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.code(400).send({
          error: `Invalid export parameters: ${query.error.issues.map((i) => i.message).join(", ")}`,
        });
      }

      const project = await validateProjectAccess(request, reply, params.data.projectId);
      if (!project) return;

      const { format, reportType, runId } = query.data;
      const sanitizedProjectName = project.name.replace(/[^a-zA-Z0-9_-]/g, "_");
      const timestamp = new Date().toISOString().slice(0, 10);

      // --- FORMAT: HTML ---
      if (format === "html") {
        const [summary, coverage, failures, aiUsage] = await Promise.all([
          reportingService.getExecutiveSummary(params.data.projectId),
          reportingService.getCoverageReport(params.data.projectId),
          reportingService.getFailures(params.data.projectId, { runId, limit: 100 }),
          reportingService.getAiUsageMetrics(params.data.projectId),
        ]);

        const htmlReport = generateStandaloneHtmlReport({
          summary,
          coverage,
          failures,
          aiUsage,
        });

        return reply
          .header("Content-Type", "text/html; charset=utf-8")
          .header("Content-Disposition", `inline; filename="QA_Report_${sanitizedProjectName}_${timestamp}.html"`)
          .code(200)
          .send(htmlReport);
      }

      // --- FORMAT: CSV ---
      if (format === "csv") {
        let csvContent = "";
        let filename = `export_${sanitizedProjectName}_${reportType}_${timestamp}.csv`;

        if (reportType === "discovery") {
          const pagesRes = await pool.query(
            `SELECT DISTINCT ON (url) url, path, depth, status, page_type, title, duration_ms, error_message, created_at
             FROM crawled_pages
             WHERE project_id = $1
             ORDER BY url, updated_at DESC`,
            [params.data.projectId]
          );
          const mappedPages = pagesRes.rows.map((r) => ({
            url: r.url,
            path: r.path,
            depth: r.depth,
            status: r.status,
            pageType: r.page_type,
            title: r.title,
            durationMs: r.duration_ms || 0,
            errorMessage: r.error_message,
            createdAt: r.created_at,
          }));
          csvContent = exportToCsv(mappedPages, DISCOVERY_EXPORT_COLUMNS);
        } else if (reportType === "ai-usage") {
          const aiData = await reportingService.getAiUsageMetrics(params.data.projectId);
          csvContent = exportToCsv(aiData.recentLogs, AI_USAGE_EXPORT_COLUMNS);
        } else {
          // Default: Test results / failures
          const failures = await reportingService.getFailures(params.data.projectId, { runId, limit: 500 });
          csvContent = exportToCsv(failures, TEST_RESULTS_EXPORT_COLUMNS);
        }

        return reply
          .header("Content-Type", "text/csv; charset=utf-8")
          .header("Content-Disposition", `attachment; filename="${filename}"`)
          .code(200)
          .send(csvContent);
      }

      // --- FORMAT: JSON ---
      const [summary, coverage, execution, aiUsage] = await Promise.all([
        reportingService.getExecutiveSummary(params.data.projectId),
        reportingService.getCoverageReport(params.data.projectId),
        reportingService.getExecutionReport(params.data.projectId),
        reportingService.getAiUsageMetrics(params.data.projectId),
      ]);

      const jsonExport = {
        project: { id: project.id, name: project.name },
        exportedAt: new Date().toISOString(),
        summary,
        coverage,
        execution,
        aiUsage,
      };

      return reply
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="QA_Telemetry_${sanitizedProjectName}_${timestamp}.json"`)
        .code(200)
        .send(JSON.stringify(jsonExport, null, 2));
    }
  );
};
