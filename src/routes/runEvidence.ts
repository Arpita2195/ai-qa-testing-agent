import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { pool } from "../config/db";
import { assertProjectAccess } from "../services/authService";
import { storageService } from "../services/storage/storageService";

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
  storageKey?: string,
): Promise<unknown> {
  if (storageKey) {
    try {
      const artifact = await storageService.download(storageKey);
      return reply.type(contentType).send(artifact.buffer);
    } catch {
      // Fallback to local disk path
    }
  }

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
    const run = await pool.query<{ project_id: string }>("SELECT project_id FROM test_runs WHERE id = $1", [params.data.id]);
    if (run.rowCount === 0) return reply.code(404).send({ error: "Test run not found" });
    if (request.user) {
      await assertProjectAccess(request.user, run.rows[0].project_id, "viewer");
    }
    const reportPath = path.resolve(__dirname, "../../artifacts/runs", params.data.id, "report.html");
    const storageKey = `runs/${params.data.id}/report.html`;
    return sendFile(reportPath, "text/html; charset=utf-8", reply, storageKey);
  });

  fastify.get<{ Params: { id: string } }>("/runs/:id/report.json", async (request, reply) => {
    const params = runParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid run id: expected a UUID" });
    const run = await pool.query<{ project_id: string }>("SELECT project_id FROM test_runs WHERE id = $1", [params.data.id]);
    if (run.rowCount === 0) return reply.code(404).send({ error: "Test run not found" });
    if (request.user) {
      await assertProjectAccess(request.user, run.rows[0].project_id, "viewer");
    }
    const reportPath = path.resolve(__dirname, "../../artifacts/runs", params.data.id, "report.json");
    const storageKey = `runs/${params.data.id}/report.json`;
    return sendFile(reportPath, "application/json; charset=utf-8", reply, storageKey);
  });

  fastify.get<{
    Params: { runId: string; resultId: string; file: string };
  }>("/runs/:runId/evidence/:resultId/:file", async (request, reply) => {
    const params = evidenceParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid run evidence path" });
    }
    const run = await pool.query<{ project_id: string }>("SELECT project_id FROM test_runs WHERE id = $1", [params.data.runId]);
    if (run.rowCount === 0) return reply.code(404).send({ error: "Test run not found" });
    if (request.user) {
      await assertProjectAccess(request.user, run.rows[0].project_id, "viewer");
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
    const storageKey = `runs/${params.data.runId}/${params.data.resultId}/${params.data.file}`;
    return sendFile(evidencePath, contentType, reply, storageKey);
  });

  fastify.get<{
    Params: { id: string };
    Querystring: { format?: string };
  }>("/runs/:id/export", async (request, reply) => {
    const params = runParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid run id: expected a UUID" });

    const format = (request.query.format || "json").toLowerCase();

    const runRes = await pool.query<{
      id: string;
      project_id: string;
      suite_id: string | null;
      run_type: string;
      status: string;
      started_at: Date;
      finished_at: Date | null;
      concurrency: number;
      retries: number;
      flaky_count: number;
      inconclusive_count: number;
      skipped_count: number;
      total_count: number;
      project_name: string;
      base_url: string;
    }>(
      `SELECT tr.*, p.name AS project_name, p.base_url
       FROM test_runs tr
       JOIN projects p ON p.id = tr.project_id
       WHERE tr.id = $1`,
      [params.data.id],
    );

    if (runRes.rowCount === 0) return reply.code(404).send({ error: "Test run not found" });
    const run = runRes.rows[0];

    if (request.user) {
      await assertProjectAccess(request.user, run.project_id, "viewer");
    }

    const webRes = await pool.query<{
      id: string;
      test_case_id: string | null;
      title: string | null;
      status: string;
      error_message: string | null;
      duration_ms: number;
      retry_count: number;
      flaky: boolean;
      attempts: any;
      screenshot_path: string | null;
    }>(
      `SELECT r.id, r.test_case_id, tc.title, r.status, r.error_message, r.duration_ms,
              COALESCE(r.retry_count, 0) AS retry_count, COALESCE(r.flaky, false) AS flaky,
              r.attempts, r.screenshot_path
       FROM test_results r
       LEFT JOIN test_cases tc ON tc.id = r.test_case_id
       WHERE r.run_id = $1
       ORDER BY r.created_at`,
      [params.data.id],
    );

    const apiRes = await pool.query<{
      id: string;
      endpoint_id: string | null;
      endpoint_name: string | null;
      method: string | null;
      path: string | null;
      status: string;
      actual_status: number | null;
      response_ms: number;
      error_message: string | null;
      retry_count: number;
      flaky: boolean;
      attempts: any;
      step_results: any;
    }>(
      `SELECT ar.id, ar.endpoint_id, ae.name AS endpoint_name, ae.method, ae.path,
              ar.status, ar.actual_status, ar.response_ms, ar.error_message,
              COALESCE(ar.retry_count, 0) AS retry_count, COALESCE(ar.flaky, false) AS flaky,
              ar.attempts, ar.step_results
       FROM api_test_results ar
       LEFT JOIN api_endpoints ae ON ae.id = ar.endpoint_id
       WHERE ar.run_id = $1
       ORDER BY ar.created_at`,
      [params.data.id],
    );

    if (format === "csv") {
      function escapeCsv(val: any): string {
        if (val === null || val === undefined) return '""';
        const str = String(val).replace(/"/g, '""');
        return `"${str}"`;
      }

      const rows: string[] = [];
      rows.push(["Test Type", "ID", "Name/Title", "Method/Path", "Status", "Flaky", "Retries", "Duration (ms)", "Error"].join(","));

      for (const w of webRes.rows) {
        rows.push([
          escapeCsv("Web UI"),
          escapeCsv(w.id),
          escapeCsv(w.title || "Web test"),
          escapeCsv(""),
          escapeCsv(w.status),
          escapeCsv(w.flaky ? "YES" : "NO"),
          escapeCsv(w.retry_count),
          escapeCsv(w.duration_ms),
          escapeCsv(w.error_message || ""),
        ].join(","));
      }

      for (const a of apiRes.rows) {
        rows.push([
          escapeCsv("REST API"),
          escapeCsv(a.id),
          escapeCsv(a.endpoint_name || "API Endpoint"),
          escapeCsv(`${a.method || ""} ${a.path || ""}`.trim()),
          escapeCsv(a.status),
          escapeCsv(a.flaky ? "YES" : "NO"),
          escapeCsv(a.retry_count),
          escapeCsv(a.response_ms),
          escapeCsv(a.error_message || ""),
        ].join(","));
      }

      const csvContent = rows.join("\r\n");
      reply.header("Content-Disposition", `attachment; filename="execution-report-${run.id}.csv"`);
      return reply.type("text/csv; charset=utf-8").send(csvContent);
    }

    const report = {
      run: {
        id: run.id,
        projectId: run.project_id,
        projectName: run.project_name,
        baseUrl: run.base_url,
        suiteId: run.suite_id,
        runType: run.run_type,
        status: run.status,
        concurrency: run.concurrency,
        retries: run.retries,
        flakyCount: run.flaky_count,
        inconclusiveCount: run.inconclusive_count,
        skippedCount: run.skipped_count,
        totalCount: run.total_count,
        startedAt: run.started_at,
        finishedAt: run.finished_at,
      },
      webTests: webRes.rows,
      apiTests: apiRes.rows,
    };

    reply.header("Content-Disposition", `attachment; filename="execution-report-${run.id}.json"`);
    return reply.type("application/json; charset=utf-8").send(report);
  });
};

export default runEvidenceRoutes;
