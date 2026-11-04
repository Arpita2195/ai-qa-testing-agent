import { randomUUID } from "node:crypto";
import { pool } from "../../config/db";
import { env } from "../../config/env";
import { logger } from "../observability/logger";
import { inMemoryMetrics } from "../observability/metricsService";
import type { JobHandler, JobRecord, JobStatus, JobType } from "./types";

const handlers = new Map<JobType, JobHandler>();
let workerTimer: NodeJS.Timeout | null = null;
let isProcessing = false;
let redisQueueInitialized = false;

// BullMQ lazy references
let bullQueues: Map<string, any> = new Map();
let bullWorkers: Map<string, any> = new Map();

/**
 * Registers an execution handler for a specific job type.
 */
export function registerJobHandler(jobType: JobType, handler: JobHandler): void {
  handlers.set(jobType, handler);
}

/**
 * Maps database row to JobRecord interface.
 */
function mapRowToJob(row: any): JobRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    queueName: row.queue_name,
    jobType: row.job_type,
    status: row.status,
    payload: row.payload,
    result: row.result,
    errorMessage: row.error_message,
    retries: row.retries ?? 0,
    maxRetries: row.max_retries ?? 3,
    concurrencyKey: row.concurrency_key,
    deduplicationId: row.deduplication_id,
    enqueuedAt: new Date(row.enqueued_at),
    startedAt: row.started_at ? new Date(row.started_at) : null,
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    queueDelayMs: row.queue_delay_ms,
    durationMs: row.duration_ms,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * Enqueues a new background job into PostgreSQL (and BullMQ if Redis is configured).
 * Prevents duplicate jobs if a matching deduplicationId is already active or pending.
 */
export async function enqueueJob(params: {
  projectId: string;
  queueName: string;
  jobType: JobType;
  payload: any;
  maxRetries?: number;
  deduplicationId?: string;
  concurrencyKey?: string;
  createdBy?: string;
}): Promise<JobRecord> {
  const maxRetries = Math.min(Math.max(params.maxRetries ?? 3, 0), 5);

  // 1. Deduplication check
  if (params.deduplicationId) {
    const existing = await pool.query(
      `SELECT * FROM background_jobs
       WHERE deduplication_id = $1 AND status IN ('pending', 'active', 'retrying')
       LIMIT 1`,
      [params.deduplicationId],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      return mapRowToJob(existing.rows[0]);
    }
  }

  // 2. Insert into PostgreSQL (Permanent Source of Truth)
  const insertRes = await pool.query(
    `INSERT INTO background_jobs
       (id, project_id, queue_name, job_type, status, payload, max_retries, deduplication_id, concurrency_key, created_by, enqueued_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'pending', $4, $5, $6, $7, $8, NOW())
     RETURNING *`,
    [
      params.projectId,
      params.queueName,
      params.jobType,
      JSON.stringify(params.payload || {}),
      maxRetries,
      params.deduplicationId || null,
      params.concurrencyKey || null,
      params.createdBy || null,
    ],
  );

  const job = mapRowToJob(insertRes.rows[0]);

  // 3. Dispatch to BullMQ if enabled
  if (isRedisQueueEnabled()) {
    try {
      await dispatchToBullMQ(job);
    } catch (err) {
      console.warn(`[JobQueue] Failed to dispatch job ${job.id} to BullMQ; will be processed by PostgreSQL worker loop:`, err);
    }
  }

  return job;
}

/**
 * Retrieves a single job by ID.
 */
export async function getJob(jobId: string): Promise<JobRecord | null> {
  const res = await pool.query("SELECT * FROM background_jobs WHERE id = $1", [jobId]);
  if (!res.rowCount || res.rowCount === 0) return null;
  return mapRowToJob(res.rows[0]);
}

/**
 * Lists background jobs with pagination and optional filtering.
 */
export async function listJobs(options: {
  projectId?: string;
  status?: JobStatus;
  queueName?: string;
  limit?: number;
  offset?: number;
}): Promise<{ jobs: JobRecord[]; total: number }> {
  const conditions: string[] = [];
  const values: any[] = [];

  if (options.projectId) {
    values.push(options.projectId);
    conditions.push(`project_id = $${values.length}`);
  }
  if (options.status) {
    values.push(options.status);
    conditions.push(`status = $${values.length}`);
  }
  if (options.queueName) {
    values.push(options.queueName);
    conditions.push(`queue_name = $${values.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const countRes = await pool.query(`SELECT COUNT(*) FROM background_jobs ${whereClause}`, values);
  const total = parseInt(countRes.rows[0]?.count || "0", 10);

  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);

  values.push(limit);
  const limitIndex = values.length;
  values.push(offset);
  const offsetIndex = values.length;

  const dataRes = await pool.query(
    `SELECT * FROM background_jobs
     ${whereClause}
     ORDER BY enqueued_at DESC
     LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    values,
  );

  return {
    jobs: dataRes.rows.map(mapRowToJob),
    total,
  };
}

/**
 * Cancels a pending or active job.
 */
export async function cancelJob(jobId: string): Promise<boolean> {
  const res = await pool.query(
    `UPDATE background_jobs
     SET status = 'cancelled', completed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status IN ('pending', 'retrying')
     RETURNING id`,
    [jobId],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Executes a single job, records execution delay, duration, results, and retries.
 */
export async function processJob(jobId: string): Promise<boolean> {
  const client = await pool.connect();
  let jobRow: any = null;

  try {
    await client.query("BEGIN");

    // Acquire lock on job using FOR UPDATE SKIP LOCKED
    const claimRes = await client.query(
      `SELECT * FROM background_jobs
       WHERE id = $1 AND status IN ('pending', 'retrying')
       FOR UPDATE SKIP LOCKED`,
      [jobId],
    );

    if (claimRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return false; // Already claimed or no longer pending
    }

    jobRow = claimRes.rows[0];
    const startedAt = new Date();
    const enqueuedAt = new Date(jobRow.enqueued_at);
    const queueDelayMs = Math.max(0, startedAt.getTime() - enqueuedAt.getTime());

    inMemoryMetrics.trackQueueDelay(queueDelayMs);
    logger.info(`Claimed background job ${jobId} (${jobRow.job_type})`, {
      jobId,
      jobType: jobRow.job_type,
      queueDelayMs,
    });

    await client.query(
      `UPDATE background_jobs
       SET status = 'active', started_at = $1, queue_delay_ms = $2, updated_at = NOW()
       WHERE id = $3`,
      [startedAt, queueDelayMs, jobId],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    return false;
  } finally {
    if (!jobRow) {
      client.release();
      return false;
    }
  }

  const job = mapRowToJob(jobRow);
  const handler = handlers.get(job.jobType);

  if (!handler) {
    const errorMsg = `No worker registered for jobType "${job.jobType}"`;
    inMemoryMetrics.trackWorkerFailure();
    logger.error(errorMsg, undefined, { jobId, jobType: job.jobType });
    await pool.query(
      `UPDATE background_jobs
       SET status = 'failed', completed_at = NOW(), error_message = $1, updated_at = NOW()
       WHERE id = $2`,
      [errorMsg, jobId],
    );
    client.release();
    return false;
  }

  const t0 = Date.now();
  try {
    const result = await handler(job.payload, job);
    const durationMs = Date.now() - t0;

    logger.info(`Background job ${jobId} (${job.jobType}) completed successfully`, {
      jobId,
      jobType: job.jobType,
      durationMs,
    });

    await pool.query(
      `UPDATE background_jobs
       SET status = 'completed', completed_at = NOW(), duration_ms = $1, result = $2, error_message = NULL, updated_at = NOW()
       WHERE id = $3`,
      [durationMs, JSON.stringify(result || {}), jobId],
    );
    client.release();
    return true;
  } catch (err: any) {
    const durationMs = Date.now() - t0;
    const errorMsg = err instanceof Error ? err.message : String(err);
    const nextRetries = job.retries + 1;

    if (nextRetries < job.maxRetries) {
      inMemoryMetrics.trackWorkerRetry();
      logger.warn(`Background job ${jobId} failed; scheduling retry ${nextRetries}/${job.maxRetries}`, {
        jobId,
        jobType: job.jobType,
        attempt: nextRetries,
        error: errorMsg,
      });

      // Exponential backoff
      await pool.query(
        `UPDATE background_jobs
         SET status = 'retrying', retries = $1, error_message = $2, duration_ms = $3, updated_at = NOW()
         WHERE id = $4`,
        [nextRetries, errorMsg, durationMs, jobId],
      );
    } else {
      inMemoryMetrics.trackWorkerFailure();
      logger.error(`Background job ${jobId} failed permanently after ${nextRetries} attempts`, err, {
        jobId,
        jobType: job.jobType,
        durationMs,
      });

      await pool.query(
        `UPDATE background_jobs
         SET status = 'failed', retries = $1, completed_at = NOW(), duration_ms = $2, error_message = $3, updated_at = NOW()
         WHERE id = $4`,
        [nextRetries, durationMs, errorMsg, jobId],
      );
    }

    client.release();
    return false;
  }
}

/**
 * Worker polling tick for PostgreSQL-backed queue.
 */
export async function tickJobWorker(concurrencyLimit: number = 2): Promise<number> {
  if (isProcessing) return 0;
  isProcessing = true;

  try {
    const pendingJobs = await pool.query<{ id: string }>(
      `SELECT id FROM background_jobs
       WHERE status IN ('pending', 'retrying')
       ORDER BY enqueued_at ASC
       LIMIT $1`,
      [concurrencyLimit],
    );

    if (pendingJobs.rowCount === 0) return 0;

    const promises = pendingJobs.rows.map((r) => processJob(r.id));
    const results = await Promise.allSettled(promises);
    return results.filter((r) => r.status === "fulfilled" && r.value).length;
  } catch (err) {
    return 0;
  } finally {
    isProcessing = false;
  }
}

/**
 * Starts periodic job polling loop.
 */
export function startJobWorkerLoop(pollIntervalMs: number = 2000, concurrency: number = 2): void {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    tickJobWorker(concurrency).catch(() => {});
  }, pollIntervalMs);
  if (typeof workerTimer.unref === "function") {
    workerTimer.unref();
  }
}

/**
 * Stops worker loop.
 */
export function stopJobWorkerLoop(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}

// -----------------------------------------------------------------------------
// Optional BullMQ + Redis Queue Integration
// -----------------------------------------------------------------------------

export function isRedisQueueEnabled(): boolean {
  return env.USE_REDIS_QUEUE === "true" || Boolean(env.REDIS_URL);
}

async function dispatchToBullMQ(job: JobRecord): Promise<void> {
  const { Queue } = await import("bullmq");
  const Redis = (await import("ioredis")).default;

  const redisConfig: any = env.REDIS_URL
    ? env.REDIS_URL
    : {
        host: env.REDIS_HOST || "localhost",
        port: env.REDIS_PORT || 6379,
        maxRetriesPerRequest: null,
      };

  let queue = bullQueues.get(job.queueName);
  if (!queue) {
    const connection = typeof redisConfig === "string" ? new Redis(redisConfig, { maxRetriesPerRequest: null }) : new Redis(redisConfig);
    queue = new Queue(job.queueName, { connection });
    bullQueues.set(job.queueName, queue);
  }

  await queue.add(job.jobType, { jobId: job.id, payload: job.payload }, {
    jobId: job.id,
    attempts: job.maxRetries,
    backoff: { type: "exponential", delay: 1000 },
  });
}

/**
 * Closes all BullMQ queues and workers cleanly.
 */
export async function closeBullQueues(): Promise<void> {
  for (const queue of bullQueues.values()) {
    await queue.close().catch(() => {});
  }
  for (const worker of bullWorkers.values()) {
    await worker.close().catch(() => {});
  }
  bullQueues.clear();
  bullWorkers.clear();
}
