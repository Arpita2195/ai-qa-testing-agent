import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { pool } from "../config/db";

const runParams = z.object({ id: z.string().uuid() });
const evidenceParams = z.object({
  runId: z.string().uuid(),
  resultId: z.string().uuid(),
  file: z.enum(["screenshot.png", "trace.zip", "evidence.json"]),
});

async function sendFile(
  absolutePath: string,
  contentType: string,
  reply: FastifyReply,
): Promise<unknown> {
  try {
    const info = await stat(absolutePath);
    if (!info.isFile()) return reply.code(404).send({ error: "Report or evidence file not found" });
    const contents = await readFile(absolutePath);
    return reply.type(contentType).send(contents);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return reply.code(404).send({ error: "Report or evidence file not found" });
    }
    throw error;
  }
}

const runEvidenceRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { id: string } }>("/runs/:id/report", async (request, reply) => {
    const params = runParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid run id: expected a UUID" });
    const run = await pool.query("SELECT 1 FROM test_runs WHERE id = $1", [params.data.id]);
    if (run.rowCount === 0) return reply.code(404).send({ error: "Test run not found" });
    const reportPath = path.resolve(__dirname, "../../artifacts/runs", params.data.id, "report.html");
    return sendFile(reportPath, "text/html; charset=utf-8", reply);
  });

  fastify.get<{ Params: { id: string } }>("/runs/:id/report.json", async (request, reply) => {
    const params = runParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid run id: expected a UUID" });
    const run = await pool.query("SELECT 1 FROM test_runs WHERE id = $1", [params.data.id]);
    if (run.rowCount === 0) return reply.code(404).send({ error: "Test run not found" });
    const reportPath = path.resolve(__dirname, "../../artifacts/runs", params.data.id, "report.json");
    return sendFile(reportPath, "application/json; charset=utf-8", reply);
  });

  fastify.get<{
    Params: { runId: string; resultId: string; file: string };
  }>("/runs/:runId/evidence/:resultId/:file", async (request, reply) => {
    const params = evidenceParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid run evidence path" });
    }
    const result = await pool.query(
      "SELECT 1 FROM test_results WHERE id = $1 AND run_id = $2",
      [params.data.resultId, params.data.runId],
    );
    if (result.rowCount === 0) return reply.code(404).send({ error: "Run evidence not found" });

    const evidencePath = path.resolve(
      __dirname,
      "../../artifacts/runs",
      params.data.runId,
      params.data.resultId,
      params.data.file,
    );
    const contentType = params.data.file === "screenshot.png"
      ? "image/png"
      : params.data.file === "trace.zip"
        ? "application/zip"
        : "application/json; charset=utf-8";
    return sendFile(evidencePath, contentType, reply);
  });
};

export default runEvidenceRoutes;
