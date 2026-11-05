import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { assertProjectAccess } from "../services/authService";
import { logAuditEvent } from "../services/auditLogger";
import { computeNextRunDate, executeScheduledSuite, type TestSchedule } from "../services/scheduler";

const projectParams = z.object({ projectId: z.string().uuid() });
const idParams = z.object({ id: z.string().uuid() });

const createScheduleSchema = z.object({
  name: z.string().min(1).max(255),
  suite_id: z.string().uuid(),
  schedule_type: z.enum(["hourly", "daily", "weekly", "custom_cron"]),
  cron_expression: z.string().nullable().optional(),
  concurrency: z.number().int().min(1).max(10).default(2),
  retries: z.number().int().min(0).max(5).default(1),
  is_active: z.boolean().default(true),
});

const updateScheduleSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  suite_id: z.string().uuid().optional(),
  schedule_type: z.enum(["hourly", "daily", "weekly", "custom_cron"]).optional(),
  cron_expression: z.string().nullable().optional(),
  concurrency: z.number().int().min(1).max(10).optional(),
  retries: z.number().int().min(0).max(5).optional(),
  is_active: z.boolean().optional(),
});

export const scheduleRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /projects/:projectId/schedules - Create test schedule
  fastify.post<{ Params: { projectId: string } }>(
    "/projects/:projectId/schedules",
    async (request, reply) => {
      const params = projectParams.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }
      const body = createScheduleSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "Validation error", details: body.error.flatten() });
      }

      if (request.user) {
        await assertProjectAccess(request.user, params.data.projectId, "qa_engineer");
      }

      // Verify suite exists and belongs to project
      const suiteCheck = await pool.query(
        `SELECT id FROM suites WHERE id = $1 AND project_id = $2`,
        [body.data.suite_id, params.data.projectId],
      );
      if (suiteCheck.rowCount === 0) {
        return reply.code(404).send({ error: "Suite not found or does not belong to this project" });
      }

      const nextRunAt = computeNextRunDate(body.data.schedule_type, body.data.cron_expression);

      const res = await pool.query<TestSchedule>(
        `INSERT INTO test_schedules
           (project_id, suite_id, name, schedule_type, cron_expression, concurrency, retries, is_active, next_run_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          params.data.projectId,
          body.data.suite_id,
          body.data.name,
          body.data.schedule_type,
          body.data.schedule_type === "custom_cron" ? body.data.cron_expression ?? null : null,
          body.data.concurrency,
          body.data.retries,
          body.data.is_active,
          nextRunAt,
          request.user?.id ?? null,
        ],
      );

      const schedule = res.rows[0];

      await logAuditEvent({
        actorId: request.user?.id ?? null,
        projectId: params.data.projectId,
        action: "schedule_created",
        details: { scheduleId: schedule.id, name: schedule.name, scheduleType: schedule.schedule_type },
        ipAddress: request.ip,
      });

      return reply.code(201).send(schedule);
    },
  );

  // GET /projects/:projectId/schedules - List test schedules for project
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/schedules",
    async (request, reply) => {
      const params = projectParams.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (request.user) {
        await assertProjectAccess(request.user, params.data.projectId, "viewer");
      }

      const res = await pool.query(
        `SELECT s.*, su.name AS suite_name
         FROM test_schedules s
         LEFT JOIN suites su ON su.id = s.suite_id
         WHERE s.project_id = $1
         ORDER BY s.created_at DESC`,
        [params.data.projectId],
      );

      return reply.send(res.rows);
    },
  );

  // GET /schedules/:id - Get schedule details
  fastify.get<{ Params: { id: string } }>("/schedules/:id", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid schedule id" });
    }

    const res = await pool.query(
      `SELECT s.*, su.name AS suite_name
       FROM test_schedules s
       LEFT JOIN suites su ON su.id = s.suite_id
       WHERE s.id = $1`,
      [params.data.id],
    );

    const schedule = res.rows[0];
    if (!schedule) {
      return reply.code(404).send({ error: "Schedule not found" });
    }

    if (request.user) {
      await assertProjectAccess(request.user, schedule.project_id, "viewer");
    }

    return reply.send(schedule);
  });

  // PATCH /schedules/:id - Edit / pause / resume schedule
  fastify.patch<{ Params: { id: string } }>("/schedules/:id", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid schedule id" });
    }
    const body = updateScheduleSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Validation error", details: body.error.flatten() });
    }

    const existingRes = await pool.query<TestSchedule>(
      `SELECT * FROM test_schedules WHERE id = $1`,
      [params.data.id],
    );
    const existing = existingRes.rows[0];
    if (!existing) {
      return reply.code(404).send({ error: "Schedule not found" });
    }

    if (request.user) {
      await assertProjectAccess(request.user, existing.project_id, "qa_engineer");
    }

    const newType = body.data.schedule_type ?? existing.schedule_type;
    const newCron = body.data.cron_expression !== undefined
      ? body.data.cron_expression
      : body.data.schedule_type !== undefined && body.data.schedule_type !== "custom_cron"
        ? null
        : existing.cron_expression;
    let nextRunAt = existing.next_run_at;

    if (body.data.schedule_type !== undefined || body.data.cron_expression !== undefined) {
      nextRunAt = computeNextRunDate(newType, newCron);
    }

    const res = await pool.query<TestSchedule>(
      `UPDATE test_schedules
       SET name = COALESCE($1, name),
           suite_id = COALESCE($2, suite_id),
           schedule_type = COALESCE($3, schedule_type),
           cron_expression = $4,
           concurrency = COALESCE($5, concurrency),
           retries = COALESCE($6, retries),
           is_active = COALESCE($7, is_active),
           next_run_at = $8,
           updated_at = now()
       WHERE id = $9
       RETURNING *`,
      [
        body.data.name ?? null,
        body.data.suite_id ?? null,
        body.data.schedule_type ?? null,
        newCron,
        body.data.concurrency ?? null,
        body.data.retries ?? null,
        body.data.is_active !== undefined ? body.data.is_active : null,
        nextRunAt,
        params.data.id,
      ],
    );

    const updated = res.rows[0];

    await logAuditEvent({
      actorId: request.user?.id ?? null,
      projectId: existing.project_id,
      action: "schedule_updated",
      details: { scheduleId: updated.id, changes: body.data },
      ipAddress: request.ip,
    });

    return reply.send(updated);
  });

  // DELETE /schedules/:id - Delete schedule
  fastify.delete<{ Params: { id: string } }>("/schedules/:id", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid schedule id" });
    }

    const existingRes = await pool.query<TestSchedule>(
      `SELECT * FROM test_schedules WHERE id = $1`,
      [params.data.id],
    );
    const existing = existingRes.rows[0];
    if (!existing) {
      return reply.code(404).send({ error: "Schedule not found" });
    }

    if (request.user) {
      await assertProjectAccess(request.user, existing.project_id, "qa_engineer");
    }

    await pool.query(`DELETE FROM test_schedules WHERE id = $1`, [params.data.id]);

    await logAuditEvent({
      actorId: request.user?.id ?? null,
      projectId: existing.project_id,
      action: "schedule_deleted",
      details: { scheduleId: existing.id, name: existing.name },
      ipAddress: request.ip,
    });

    return reply.send({ message: "Schedule deleted successfully" });
  });

  // POST /schedules/:id/run-now - Trigger immediate run
  fastify.post<{ Params: { id: string } }>("/schedules/:id/run-now", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid schedule id" });
    }

    const existingRes = await pool.query<TestSchedule>(
      `SELECT * FROM test_schedules WHERE id = $1`,
      [params.data.id],
    );
    const existing = existingRes.rows[0];
    if (!existing) {
      return reply.code(404).send({ error: "Schedule not found" });
    }

    if (request.user) {
      await assertProjectAccess(request.user, existing.project_id, "qa_engineer");
    }

    const runId = await executeScheduledSuite(existing.id);

    await logAuditEvent({
      actorId: request.user?.id ?? null,
      projectId: existing.project_id,
      action: "schedule_run_triggered",
      details: { scheduleId: existing.id, runId },
      ipAddress: request.ip,
    });

    return reply.send({ message: "Scheduled test execution triggered", runId });
  });

  // GET /schedules/:id/runs - View schedule execution history
  fastify.get<{ Params: { id: string } }>("/schedules/:id/runs", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid schedule id" });
    }

    const existingRes = await pool.query<TestSchedule>(
      `SELECT * FROM test_schedules WHERE id = $1`,
      [params.data.id],
    );
    const existing = existingRes.rows[0];
    if (!existing) {
      return reply.code(404).send({ error: "Schedule not found" });
    }

    if (request.user) {
      await assertProjectAccess(request.user, existing.project_id, "viewer");
    }

    const runsRes = await pool.query(
      `SELECT sr.*, tr.status AS run_status, tr.started_at AS run_started_at, tr.finished_at AS run_finished_at
       FROM test_schedule_runs sr
       LEFT JOIN test_runs tr ON tr.id = sr.run_id
       WHERE sr.schedule_id = $1
       ORDER BY sr.started_at DESC
       LIMIT 50`,
      [params.data.id],
    );

    return reply.send(runsRes.rows);
  });
};

export default scheduleRoutes;
