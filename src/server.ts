import Fastify from "fastify";
import cors from "@fastify/cors";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { env } from "./config/env";
import { createApiKeyHook } from "./services/auth";
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

const app = Fastify({ logger: true });

app.register(cors, {
  origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
  allowedHeaders: ["content-type", "x-api-key"],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
});
app.addHook("onRequest", createApiKeyHook(env.PLATFORM_API_KEY));

app.register(healthRoutes);
app.register(apiEndpointRoutes);
app.register(apiRunRoutes);
app.register(bugReportRoutes);
app.register(generateRoutes);
app.register(projectRoutes);
app.register(testCaseRoutes);
app.register(runRoutes);
app.register(runEvidenceRoutes);
app.register(suiteRoutes);
app.register(visualRoutes);

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
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void start();