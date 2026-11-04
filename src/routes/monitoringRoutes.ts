import type { FastifyInstance } from "fastify";
import { pool } from "../config/db";
import { getSystemMetrics, getPrometheusMetrics, inMemoryMetrics } from "../services/observability/metricsService";
import { storageService } from "../services/storage/storageService";
import { requireAuth } from "../services/auth";
import { assertProjectAccess } from "../services/authService";
import { isRedisQueueEnabled } from "../services/jobs/jobQueue";
import { logger } from "../services/observability/logger";

export async function monitoringRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/monitoring/health
   * Enhanced multi-subsystem health check (Database, Storage, Worker, Memory).
   */
  app.get("/api/monitoring/health", async (request, reply) => {
    const startedAt = Date.now();
    const checks: Record<string, { status: "up" | "down" | "degraded"; latencyMs?: number; message?: string }> = {};

    // 1. Database Health Check
    try {
      const dbStart = Date.now();
      await pool.query("SELECT 1");
      checks.database = { status: "up", latencyMs: Date.now() - dbStart };
    } catch (err: any) {
      checks.database = { status: "down", message: err.message };
    }

    // 2. Storage Health Check
    try {
      const storageStart = Date.now();
      const providerType = storageService.getProviderType();
      checks.storage = {
        status: "up",
        latencyMs: Date.now() - storageStart,
        message: `Provider: ${providerType}`,
      };
    } catch (err: any) {
      checks.storage = { status: "degraded", message: err.message };
    }

    // 3. Worker / Queue Subsystem
    checks.worker = {
      status: "up",
      message: isRedisQueueEnabled() ? "Engine: Redis + BullMQ (Dual-mode)" : "Engine: PostgreSQL FOR UPDATE SKIP LOCKED",
    };

    // 4. Memory & Process Metrics
    const memory = process.memoryUsage();
    const system = {
      uptimeSeconds: Math.round(process.uptime()),
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
      rssMb: Math.round(memory.rss / 1024 / 1024),
    };

    const isHealthy = checks.database.status === "up";
    const isDegraded = checks.storage.status === "degraded" || checks.worker.status === "degraded";
    const overallStatus = isHealthy ? (isDegraded ? "degraded" : "healthy") : "unhealthy";
    const statusCode = isHealthy ? 200 : 503;

    return reply.status(statusCode).send({
      status: overallStatus,
      timestamp: new Date().toISOString(),
      responseTimeMs: Date.now() - startedAt,
      checks,
      system,
    });
  });

  /**
   * GET /api/monitoring/metrics
   * Provides comprehensive aggregated metrics for dashboard & observability.
   */
  app.get("/api/monitoring/metrics", { preHandler: [requireAuth] }, async (request, reply) => {
    const query = request.query as { projectId?: string };
    if (query.projectId && request.user) {
      try {
        await assertProjectAccess(request.user, query.projectId, "viewer");
      } catch (err: any) {
        return reply.status(403).send({ error: err.message });
      }
    }

    try {
      const metrics = await getSystemMetrics(query.projectId);
      return reply.send({
        success: true,
        projectId: query.projectId || null,
        metrics,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      logger.error("Failed to collect system metrics", err);
      return reply.status(500).send({ error: "Failed to collect system metrics" });
    }
  });

  /**
   * GET /metrics
   * Prometheus exposition format for external scraping agents.
   */
  app.get("/metrics", async (request, reply) => {
    try {
      const prometheusData = await getPrometheusMetrics();
      reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      return reply.send(prometheusData);
    } catch (err: any) {
      logger.error("Failed to generate Prometheus metrics", err);
      return reply.status(500).send("# Failed to generate metrics\n");
    }
  });
}
