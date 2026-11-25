import { randomUUID } from "node:crypto";
import { pool } from "../../config/db";
import { logger } from "../observability/logger";

/**
 * In-memory map of in-flight AI generation promises indexed by fingerprint.
 * Ensures identical concurrent requests within the same process reuse the exact
 * same execution promise, preventing duplicate API requests and wasted tokens.
 */
const inFlightRequests = new Map<string, Promise<any>>();

export interface SingleFlightResult<T> {
  result: T;
  wasDeduplicated: boolean;
  wasShared: boolean;
}

export interface SingleFlightOptions<T> {
  projectId?: string;
  maxWaitMs?: number;
  pollIntervalMs?: number;
  onCacheCheck?: () => Promise<T | null | undefined>;
}

/**
 * Renews an active distributed single-flight lock, extending its expiration.
 * Only the current lock owner (matched by locked_by) can extend the lock.
 */
export async function renewDistributedLock(
  fingerprint: string,
  lockedBy: string,
  extendSeconds: number = 60,
): Promise<boolean> {
  if (!fingerprint || !lockedBy) return false;
  try {
    const res = await pool.query(
      `UPDATE ai_in_flight_locks
       SET expires_at = NOW() + ($3 || ' seconds')::interval
       WHERE fingerprint = $1 AND locked_by = $2`,
      [fingerprint, lockedBy, extendSeconds],
    );
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    logger.warn("Failed to renew distributed single-flight lock", { error: err, fingerprint, lockedBy });
    return false;
  }
}

/**
 * Executes an operation with single-flight deduplication across threads and distributed workers.
 * If an identical operation is already running in this process or on another worker,
 * joins that execution or awaits the result, preventing redundant provider calls.
 */
export async function executeSingleFlight<T>(
  fingerprint: string,
  fn: () => Promise<T>,
  options?: SingleFlightOptions<T>,
): Promise<SingleFlightResult<T>> {
  if (!fingerprint) {
    const result = await fn();
    return { result, wasDeduplicated: false, wasShared: false };
  }

  // 1. In-process single-flight deduplication
  const existingPromise = inFlightRequests.get(fingerprint);
  if (existingPromise) {
    logger.debug("Joined existing in-memory in-flight AI request", { fingerprint });
    const result = await existingPromise;
    return { result, wasDeduplicated: true, wasShared: true };
  }

  // Synchronously claim the in-process execution slot for this fingerprint before awaiting DB
  let resolveShared!: (val: T) => void;
  let rejectShared!: (err: any) => void;
  const sharedPromise = new Promise<T>((resolve, reject) => {
    resolveShared = resolve;
    rejectShared = reject;
  });
  sharedPromise.catch(() => {});
  inFlightRequests.set(fingerprint, sharedPromise);

  // 2. Distributed coordination across worker processes using ai_in_flight_locks
  const workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  let isDistributedLeader = false;

  try {
    const lockRes = await pool.query<{ fingerprint: string }>(
      `INSERT INTO ai_in_flight_locks (fingerprint, project_id, locked_by, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '60 seconds')
       ON CONFLICT (fingerprint) DO UPDATE
       SET locked_by = EXCLUDED.locked_by,
           created_at = NOW(),
           expires_at = EXCLUDED.expires_at
       WHERE ai_in_flight_locks.expires_at < NOW()
       RETURNING fingerprint`,
      [fingerprint, options?.projectId || null, workerId],
    );

    isDistributedLeader = (lockRes.rowCount ?? 0) > 0;
  } catch (err) {
    // If DB check fails, degrade gracefully to in-memory single-flight
    logger.warn("Failed to check distributed single-flight lock, falling back to local memory", {
      error: err,
      fingerprint,
    });
    isDistributedLeader = true;
  }

  // Leader execution path
  if (isDistributedLeader) {
    // Periodic lock heartbeat ensures long-running AI requests (> 60s) maintain lock ownership
    let heartbeatTimer: NodeJS.Timeout | undefined;
    heartbeatTimer = setInterval(async () => {
      try {
        await renewDistributedLock(fingerprint, workerId, 60);
      } catch (err) {
        logger.warn("Distributed lock heartbeat tick failed", { error: err, fingerprint });
      }
    }, 15000);
    if (heartbeatTimer.unref) {
      heartbeatTimer.unref();
    }

    try {
      const result = await fn();
      resolveShared(result);
      return { result, wasDeduplicated: false, wasShared: false };
    } catch (err) {
      rejectShared(err);
      throw err;
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      inFlightRequests.delete(fingerprint);
      try {
        await pool.query(
          "DELETE FROM ai_in_flight_locks WHERE fingerprint = $1 AND locked_by = $2",
          [fingerprint, workerId],
        );
      } catch (e) {
        logger.warn("Failed to clean up distributed single-flight lock", { error: e, fingerprint });
      }
    }
  }

  // Follower path (another worker is currently executing this fingerprint)
  logger.info("Follower joined in-flight distributed AI operation", { fingerprint });
  const maxWaitMs = options?.maxWaitMs ?? 60000;
  const pollIntervalMs = options?.pollIntervalMs ?? 100;
  const startTime = Date.now();

  try {
    while (Date.now() - startTime < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

      // Check if leader finished and stored result in cache
      if (options?.onCacheCheck) {
        try {
          const cached = await options.onCacheCheck();
          if (cached !== null && cached !== undefined) {
            logger.info("Distributed follower resolved output from cache", { fingerprint });
            resolveShared(cached);
            return { result: cached, wasDeduplicated: true, wasShared: true };
          }
        } catch {}
      }

      // Check if distributed lock was released or expired
      try {
        const lockStatus = await pool.query<{ expires_at: Date }>(
          "SELECT expires_at FROM ai_in_flight_locks WHERE fingerprint = $1",
          [fingerprint],
        );

        if (
          lockStatus.rowCount === 0 ||
          (lockStatus.rows[0]?.expires_at &&
            new Date(lockStatus.rows[0].expires_at).getTime() <= Date.now())
        ) {
          // Leader finished: poll cache with a few rapid retries
          if (options?.onCacheCheck) {
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const cached = await options.onCacheCheck();
                if (cached !== null && cached !== undefined) {
                  resolveShared(cached);
                  return { result: cached, wasDeduplicated: true, wasShared: true };
                }
              } catch {}
              await new Promise((r) => setTimeout(r, 30));
            }
          }
          break;
        }
      } catch {
        break;
      }
    }

    // Fallback: If not resolved via cache, execute directly
    const fallbackResult = await fn();
    resolveShared(fallbackResult);
    return { result: fallbackResult, wasDeduplicated: false, wasShared: false };
  } catch (err) {
    rejectShared(err);
    throw err;
  } finally {
    inFlightRequests.delete(fingerprint);
  }
}

/**
 * Returns the count of currently in-flight deduplicated requests in this process.
 */
export function getInFlightRequestCount(): number {
  return inFlightRequests.size;
}

/**
 * Clears in-flight requests (primarily used in testing).
 */
export async function clearInFlightRequests(): Promise<void> {
  inFlightRequests.clear();
  try {
    await pool.query("DELETE FROM ai_in_flight_locks");
  } catch {}
}
