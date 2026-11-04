import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { env } from "./config/env";
import { createAuthHook } from "./services/auth";
import { AccessDeniedError } from "./services/authService";
import authRoutes from "./routes/auth";
import apiEndpointRoutes from "./routes/apiEndpoints";
import apiRunRoutes from "./routes/apiRuns";
import bugReportRoutes from "./routes/bugReports";
import generateRoutes from "./routes/generate";
import healthRoutes from "./routes/health";
import projectRoutes from "./routes/projects";
import runRoutes from "./routes/runs";
import runEvidenceRoutes from "./routes/runEvidence";
import suiteRoutes from "./routes/suites";
import testCaseRoutes from "./routes/testCases";
import visualRoutes from "./routes/visual";
import regressionRoutes from "./routes/regression";
import orchestratorRoutes from "./routes/orchestrator";
import webhookRoutes from "./routes/webhooks";
import requirementRoutes from "./routes/requirements";
import automationRoutes from "./routes/automation";
import scheduleRoutes from "./routes/schedules";
import { artifactRoutes } from "./routes/artifactRoutes";
import { jobRoutes } from "./routes/jobRoutes";
import { monitoringRoutes } from "./routes/monitoringRoutes";
import mobileRoutes from "./routes/mobile";
import { startScheduler } from "./services/scheduler";
import { initializeJobHandlers } from "./services/jobs/jobHandlers";
import { startJobWorkerLoop, stopJobWorkerLoop, closeBullQueues } from "./services/jobs/jobQueue";
import { asyncLogStorage, logger } from "./services/observability/logger";
import { inMemoryMetrics } from "./services/observability/metricsService";
import { randomUUID } from "node:crypto";
import multipart from "@fastify/multipart";

const app = Fastify({
  logger: false, // Replaced by structured JSON logger
  bodyLimit: 10 * 1024 * 1024, // 10MB request body size limit
});

app.setErrorHandler((error, request, reply) => {
  const err = error as { name?: string; statusCode?: number; message?: string };
  if (
    error instanceof AccessDeniedError ||
    err.statusCode === 403 ||
    err.name === "AccessDeniedError"
  ) {
    return reply.code(403).send({ error: err.message || "Access denied" });
  }
  if (err.statusCode) {
    return reply.code(err.statusCode).send({ error: err.message || "Error" });
  }
  request.log.error(error);
  return reply.code(500).send({ error: err.message || "Internal Server Error" });
});

// Configure CORS: explicit production origins or local development origins
const configuredOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

const allowedOrigins =
  configuredOrigins.length > 0
    ? process.env.NODE_ENV === "production"
      ? configuredOrigins
      : Array.from(
          new Set([
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:5174",
            "http://127.0.0.1:5174",
            ...configuredOrigins,
          ]),
        )
    : [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
      ];

app.register(cors, {
  origin: allowedOrigins,
  credentials: true,
  allowedHeaders: ["content-type", "x-api-key", "x-csrf-token", "authorization", "x-correlation-id"],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
});

// Register secure signed cookies
app.register(cookie, {
  secret: env.COOKIE_SECRET || process.env.COOKIE_SECRET,
});

app.register(multipart, {
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB file upload limit
    files: 1,
  },
  attachFieldsToBody: false,
});

// Correlation ID & Context Hook
app.addHook("onRequest", async (request, reply) => {
  const correlationId = (request.headers["x-correlation-id"] as string) || randomUUID();
  reply.header("x-correlation-id", correlationId);
  asyncLogStorage.enterWith({
    correlationId,
    service: "ai-qa-backend",
    userId: request.user?.id,
  });
});

// HTTP Metrics Hook
app.addHook("onResponse", async (request, reply) => {
  const route = request.routeOptions?.url || request.url;
  inMemoryMetrics.trackApiRequest(reply.statusCode, route);
});

// HTTP Security Headers Hook
app.addHook("onSend", async (_request, reply) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none';");
  if (process.env.NODE_ENV === "production") {
    reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
});

app.addHook("onRequest", createAuthHook(env.PLATFORM_API_KEY));

app.register(healthRoutes);
app.register(authRoutes);
app.register(apiEndpointRoutes);
app.register(apiRunRoutes);
app.register(bugReportRoutes);
app.register(generateRoutes);
app.register(projectRoutes);
app.register(testCaseRoutes);
app.register(requirementRoutes);
app.register(automationRoutes);
app.register(runRoutes);
app.register(runEvidenceRoutes);
app.register(suiteRoutes);
app.register(visualRoutes);
app.register(regressionRoutes);
app.register(orchestratorRoutes);
app.register(webhookRoutes);
app.register(scheduleRoutes);
app.register(artifactRoutes);
app.register(jobRoutes);
app.register(monitoringRoutes);
app.register(mobileRoutes);

app.get<{ Params: { filename: string } }>("/artifacts/:filename", async (request, reply) => {
  const { filename } = request.params;
  if (
    filename.includes("..") ||
    filename.includes("/") ||
    filename.includes("\\") ||
    path.basename(filename) !== filename
  ) {
    return reply.code(400).send({ error: "Invalid artifact filename" });
  }

  const artifactsDirectory = path.resolve(__dirname, "../artifacts");
  const filePath = path.resolve(artifactsDirectory, filename);
  if (path.dirname(filePath) !== artifactsDirectory) {
    return reply.code(400).send({ error: "Invalid artifact filename" });
  }
  try {
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile()) {
      return reply.code(404).send({ error: "Artifact not found" });
    }
    return reply.type("image/png").send(createReadStream(filePath));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return reply.code(404).send({ error: "Artifact not found" });
    }
    throw error;
  }
});

async function start(): Promise<void> {
  try {
    // 1. Initialize background job handlers and worker loop
    initializeJobHandlers();
    startJobWorkerLoop();

    // 2. Start cron scheduler
    startScheduler();

    // 3. Start Fastify server
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    logger.info(`Server running on port ${env.PORT}`);

    // Graceful shutdown
    const handleShutdown = async (signal: string) => {
      logger.info(`Received ${signal}, initiating graceful shutdown...`);
      stopJobWorkerLoop();
      await closeBullQueues();
      await app.close();
      process.exit(0);
    };

    process.once("SIGINT", () => handleShutdown("SIGINT"));
    process.once("SIGTERM", () => handleShutdown("SIGTERM"));
  } catch (error) {
    logger.error("Fatal error starting server", error);
    process.exit(1);
  }
}

void start();