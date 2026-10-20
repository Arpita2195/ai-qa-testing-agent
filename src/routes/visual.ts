import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { runVisualCheck, type VisualBaseline, type VisualCheck } from "../services/visualRunner";

const projectParams = z.object({ projectId: z.string().uuid() });
const idParams = z.object({ id: z.string().uuid() });
const checkBody = z.object({
  name: z.string().min(1),
  path: z.string().startsWith("/").refine((value) => !value.startsWith("//")),
  viewport_width: z.number().int().positive().max(4096).default(1280),
  viewport_height: z.number().int().positive().max(4096).default(720),
  threshold: z.number().min(0).max(1).default(0.01),
});
const resultDecisionBody = z.object({ decision: z.enum(["accept_change", "confirm_bug"]) });
const baselineReviewBody = z.object({ review_status: z.enum(["approved", "rejected"]) });

interface ProjectRow {
  id: string;
  base_url: string;
}

interface VisualCheckRow extends VisualCheck {
  project_id: string;
  name: string;
  created_at: Date;
}

interface VisualRunRow {
  id: string;
  project_id: string;
  status: string;
  run_type: string;
  started_at: Date;
  finished_at: Date | null;
  created_at: Date;
}

const visualRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { projectId: string } }>(
    "/projects/:projectId/visual-checks",
    async (request, reply) => {
      const params = projectParams.safeParse(request.params);
      const body = checkBody.safeParse(request.body);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }
      if (!body.success) {
        return reply.code(400).send({
          error: `Invalid visual check: ${body.error.issues.map((issue) => issue.message).join(", ")}`,
        });
      }
      const project = await pool.query("SELECT 1 FROM projects WHERE id = $1", [
        params.data.projectId,
      ]);
      if (project.rowCount === 0) {
        return reply.code(404).send({ error: "Project not found" });
      }
      const result = await pool.query(
        `INSERT INTO visual_checks
           (project_id, name, path, viewport_width, viewport_height, threshold)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [
          params.data.projectId,
          body.data.name,
          body.data.path,
          body.data.viewport_width,
          body.data.viewport_height,
          body.data.threshold,
        ],
      );
      return reply.code(201).send(result.rows[0]);
    },
  );

  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/visual-checks",
    async (request, reply) => {
      const params = projectParams.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }
      const project = await pool.query("SELECT 1 FROM projects WHERE id = $1", [
        params.data.projectId,
      ]);
      if (project.rowCount === 0) {
        return reply.code(404).send({ error: "Project not found" });
      }
      const result = await pool.query(
        `SELECT vc.*,
                COALESCE(jsonb_agg(jsonb_build_object(
                  'id', vb.id, 'image_path', vb.image_path, 'status', vb.status
                ) ORDER BY vb.created_at DESC) FILTER (WHERE vb.id IS NOT NULL), '[]'::jsonb) AS baselines
         FROM visual_checks vc
         LEFT JOIN visual_baselines vb ON vb.check_id = vc.id
         WHERE vc.project_id = $1
         GROUP BY vc.id
         ORDER BY vc.created_at DESC`,
        [params.data.projectId],
      );
      return result.rows;
    },
  );

  fastify.post<{ Params: { projectId: string } }>(
    "/projects/:projectId/visual-runs",
    async (request, reply) => {
      const params = projectParams.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }
      const projectResult = await pool.query<ProjectRow>(
        "SELECT id, base_url FROM projects WHERE id = $1",
        [params.data.projectId],
      );
      const project = projectResult.rows[0];
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }
      const runResult = await pool.query<VisualRunRow>(
        `INSERT INTO test_runs (id, project_id, status, started_at, run_type)
         VALUES (gen_random_uuid(), $1, 'running', now(), 'visual') RETURNING *`,
        [project.id],
      );
      const run = runResult.rows[0];
      if (!run) throw new Error("Failed to create visual run");

      const checks = await pool.query<VisualCheckRow>(
        "SELECT * FROM visual_checks WHERE project_id = $1 ORDER BY created_at ASC",
        [project.id],
      );
      const results: Array<Record<string, unknown>> = [];
      for (const check of checks.rows) {
        const baselineResult = await pool.query<VisualBaseline>(
          `SELECT id, image_path FROM visual_baselines
           WHERE check_id = $1 AND status = 'approved'
           ORDER BY created_at DESC LIMIT 1`,
          [check.id],
        );
        const baseline = baselineResult.rows[0] ?? null;
        const execution = await runVisualCheck(project.base_url, check, baseline);
        let baselineId: string | null = baseline?.id ?? null;

        if (execution.status === "baseline_created" && execution.baselinePath) {
          const insertedBaseline = await pool.query<{ id: string }>(
            `INSERT INTO visual_baselines (check_id, image_path, status)
             VALUES ($1, $2, 'pending') RETURNING id`,
            [check.id, execution.baselinePath],
          );
          baselineId = insertedBaseline.rows[0]?.id ?? null;
        }

        const reviewStatus = execution.status === "failed" ? "pending" : "none";
        const inserted = await pool.query(
          `INSERT INTO visual_results
             (run_id, check_id, baseline_id, status, diff_ratio, screenshot_path,
              diff_path, review_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [
            run.id,
            check.id,
            baselineId,
            execution.status,
            execution.diffRatio,
            execution.screenshotPath,
            execution.diffPath,
            reviewStatus,
          ],
        );
        results.push({ ...inserted.rows[0], check_name: check.name, error_message: execution.errorMessage });
      }

      const status = results.every((result) => result.status !== "failed") ? "passed" : "failed";
      const updated = await pool.query<VisualRunRow>(
        "UPDATE test_runs SET status = $1, finished_at = now() WHERE id = $2 RETURNING *",
        [status, run.id],
      );
      return reply.code(201).send({ ...updated.rows[0], results });
    },
  );

  fastify.get<{ Params: { id: string } }>("/visual-runs/:id", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid visual run id: expected a UUID" });
    }
    const runResult = await pool.query<VisualRunRow>(
      "SELECT * FROM test_runs WHERE id = $1 AND run_type = 'visual'",
      [params.data.id],
    );
    const run = runResult.rows[0];
    if (!run) return reply.code(404).send({ error: "Visual run not found" });
    const results = await pool.query(
      `SELECT vr.*, vc.name AS check_name
       FROM visual_results vr JOIN visual_checks vc ON vc.id = vr.check_id
       WHERE vr.run_id = $1 ORDER BY vr.created_at ASC`,
      [run.id],
    );
    return { ...run, results: results.rows };
  });

  fastify.patch<{ Params: { id: string } }>(
    "/visual-results/:id/review",
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      const body = resultDecisionBody.safeParse(request.body);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid visual result id: expected a UUID" });
      }
      if (!body.success) {
        return reply.code(400).send({ error: "decision must be accept_change or confirm_bug" });
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query<{
          id: string;
          check_id: string;
          screenshot_path: string;
          status: string;
        }>("SELECT * FROM visual_results WHERE id = $1 FOR UPDATE", [params.data.id]);
        const visualResult = result.rows[0];
        if (!visualResult) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "Visual result not found" });
        }
        let baselineId: string | null = null;
        if (body.data.decision === "accept_change") {
          if (!visualResult.screenshot_path) {
            await client.query("ROLLBACK");
            return reply.code(400).send({ error: "Visual result has no screenshot to accept" });
          }
          await client.query(
            "UPDATE visual_baselines SET status = 'rejected' WHERE check_id = $1 AND status = 'approved'",
            [visualResult.check_id],
          );
          const baseline = await client.query<{ id: string }>(
            `INSERT INTO visual_baselines (check_id, image_path, status)
             VALUES ($1, $2, 'approved') RETURNING id`,
            [visualResult.check_id, visualResult.screenshot_path],
          );
          baselineId = baseline.rows[0]?.id ?? null;
        }
        const reviewStatus =
          body.data.decision === "accept_change" ? "accepted_change" : "confirmed_bug";
        const updated = await client.query(
          "UPDATE visual_results SET review_status = $1, baseline_id = COALESCE($2, baseline_id) WHERE id = $3 RETURNING *",
          [reviewStatus, baselineId, visualResult.id],
        );
        await client.query("COMMIT");
        return updated.rows[0];
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  fastify.patch<{ Params: { id: string } }>(
    "/visual-baselines/:id/review",
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      const body = baselineReviewBody.safeParse(request.body);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid baseline id: expected a UUID" });
      }
      if (!body.success) {
        return reply.code(400).send({ error: "review_status must be approved or rejected" });
      }
      const result = await pool.query<{ id: string; check_id: string }>(
        "SELECT id, check_id FROM visual_baselines WHERE id = $1",
        [params.data.id],
      );
      const baseline = result.rows[0];
      if (!baseline) return reply.code(404).send({ error: "Visual baseline not found" });
      if (body.data.review_status === "approved") {
        await pool.query(
          "UPDATE visual_baselines SET status = 'rejected' WHERE check_id = $1 AND status = 'approved'",
          [baseline.check_id],
        );
      }
      const updated = await pool.query(
        "UPDATE visual_baselines SET status = $1 WHERE id = $2 RETURNING *",
        [body.data.review_status, baseline.id],
      );
      return updated.rows[0];
    },
  );
};

export default visualRoutes;
