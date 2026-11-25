import { randomUUID } from "node:crypto";
import { pool } from "../../config/db";
import { logger } from "../observability/logger";
import { logAuditEvent } from "../auditLogger";
import { recordAiUsage } from "../observability/metricsService";
import { AIProviderError } from "./types";

export interface ProjectBudgetStatus {
  allowed: boolean;
  isWarning: boolean;
  period: "monthly" | "daily";
  currentTokens: number;
  currentCostUsd: number;
  committedTokens?: number;
  committedCostUsd?: number;
  activeReservationsTokens?: number;
  activeReservationsCostUsd?: number;
  maxCostLimitUsd: number | null;
  maxTokenLimit: number | null;
  costPercentUsed: number;
  tokenPercentUsed: number;
  warningThresholdPercent: number;
  periodStart: Date;
  resetsAt: Date;
}

export interface AiBudgetReservation {
  id: string;
  projectId: string;
  reservedTokens: number;
  reservedCostUsd: number;
  status: "active" | "reconciled" | "released" | "expired" | "uncertain";
  ownerToken?: string;
  uncertaintyReason?: string;
}

export interface BudgetReservationOptions {
  estimatedTokens?: number;
  estimatedCostUsd?: number;
  feature?: string;
  actorId?: string;
}

/**
 * Calculates start and reset dates for the current usage period.
 */
function getPeriodBoundaries(period: "monthly" | "daily"): { start: Date; reset: Date } {
  const now = new Date();
  if (period === "daily") {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
    const reset = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return { start, reset };
  } else {
    // Monthly
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
    const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
    return { start, reset };
  }
}

/**
 * Retrieves the current project AI budget limits, committed usage, and active reservations.
 */
export async function getProjectAiBudgetStatus(projectId: string): Promise<ProjectBudgetStatus> {
  const defaultStatus: ProjectBudgetStatus = {
    allowed: true,
    isWarning: false,
    period: "monthly",
    currentTokens: 0,
    currentCostUsd: 0,
    committedTokens: 0,
    committedCostUsd: 0,
    activeReservationsTokens: 0,
    activeReservationsCostUsd: 0,
    maxCostLimitUsd: null,
    maxTokenLimit: null,
    costPercentUsed: 0,
    tokenPercentUsed: 0,
    warningThresholdPercent: 80,
    periodStart: new Date(),
    resetsAt: new Date(),
  };

  if (!projectId) return defaultStatus;

  try {
    // 1. Fetch configured limits from project_ai_configurations
    const configRes = await pool.query<{
      usage_limit_period: string | null;
      max_cost_limit_usd: string | null;
      max_token_limit: string | null;
      warning_threshold_percent: number | null;
    }>(
      `SELECT usage_limit_period, max_cost_limit_usd, max_token_limit, warning_threshold_percent
       FROM project_ai_configurations
       WHERE project_id = $1`,
      [projectId],
    );

    const config = configRes.rows[0];
    const period = (config?.usage_limit_period === "daily" ? "daily" : "monthly") as "monthly" | "daily";
    const maxCostLimitUsd = config?.max_cost_limit_usd ? parseFloat(config.max_cost_limit_usd) : null;
    const maxTokenLimit = config?.max_token_limit ? parseInt(config.max_token_limit, 10) : null;
    const warningThresholdPercent = config?.warning_threshold_percent ?? 80;

    const { start: periodStart, reset: resetsAt } = getPeriodBoundaries(period);

    // 2. Aggregate actual consumed tokens and cost from ai_usage_logs for this period
    const usageRes = await pool.query<{
      total_tokens: string | null;
      total_cost: string | null;
    }>(
      `SELECT COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
              COALESCE(SUM(estimated_cost_usd), 0)::numeric AS total_cost
       FROM ai_usage_logs
       WHERE project_id = $1 AND created_at >= $2`,
      [projectId, periodStart],
    );

    // 3. Include active in-flight and uncertain reservations
    const reservationsRes = await pool.query<{
      reserved_tokens: string | null;
      reserved_cost: string | null;
    }>(
      `SELECT COALESCE(SUM(reserved_tokens), 0)::bigint AS reserved_tokens,
              COALESCE(SUM(reserved_cost_usd), 0)::numeric AS reserved_cost
       FROM ai_budget_reservations
       WHERE project_id = $1 AND status IN ('active', 'uncertain') AND expires_at > NOW()`,
      [projectId],
    );

    const committedTokens = parseInt(usageRes.rows[0]?.total_tokens || "0", 10);
    const committedCostUsd = parseFloat(usageRes.rows[0]?.total_cost || "0");
    const activeReservedTokens = parseInt(reservationsRes.rows[0]?.reserved_tokens || "0", 10);
    const activeReservedCost = parseFloat(reservationsRes.rows[0]?.reserved_cost || "0");

    const currentTokens = committedTokens + activeReservedTokens;
    const currentCostUsd = committedCostUsd + activeReservedCost;

    let costPercentUsed = 0;
    let costExceeded = false;
    let costWarning = false;

    if (maxCostLimitUsd !== null && maxCostLimitUsd > 0) {
      costPercentUsed = Number(((currentCostUsd / maxCostLimitUsd) * 100).toFixed(1));
      costExceeded = currentCostUsd >= maxCostLimitUsd;
      costWarning = costPercentUsed >= warningThresholdPercent;
    }

    let tokenPercentUsed = 0;
    let tokenExceeded = false;
    let tokenWarning = false;

    if (maxTokenLimit !== null && maxTokenLimit > 0) {
      tokenPercentUsed = Number(((currentTokens / maxTokenLimit) * 100).toFixed(1));
      tokenExceeded = currentTokens >= maxTokenLimit;
      tokenWarning = tokenPercentUsed >= warningThresholdPercent;
    }

    const allowed = !costExceeded && !tokenExceeded;
    const isWarning = allowed && (costWarning || tokenWarning);

    return {
      allowed,
      isWarning,
      period,
      currentTokens,
      currentCostUsd: Number(currentCostUsd.toFixed(4)),
      committedTokens,
      committedCostUsd: Number(committedCostUsd.toFixed(4)),
      activeReservationsTokens: activeReservedTokens,
      activeReservationsCostUsd: Number(activeReservedCost.toFixed(4)),
      maxCostLimitUsd,
      maxTokenLimit,
      costPercentUsed,
      tokenPercentUsed,
      warningThresholdPercent,
      periodStart,
      resetsAt,
    };
  } catch (err) {
    logger.warn("Failed to check project AI budget status", { error: err, projectId });
    return defaultStatus;
  }
}

/**
 * Atomically reserves AI budget tokens and estimated cost for a project before provider dispatch.
 * Uses transaction-level advisory locks to serialize concurrent reservation requests for the project,
 * preventing concurrent requests from breaching configured hard limits.
 */
export async function reserveAiBudget(
  projectId: string,
  options: BudgetReservationOptions = {},
): Promise<AiBudgetReservation> {
  const {
    estimatedTokens = 6000,
    estimatedCostUsd = 0.0006,
    feature = "general",
    actorId,
  } = options;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Serialize concurrent reservations for this project with a transaction-scoped advisory lock
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ai_budget_' || $1))", [projectId]);

    // 1. Fetch configured limits
    const configRes = await client.query<{
      usage_limit_period: string | null;
      max_cost_limit_usd: string | null;
      max_token_limit: string | null;
      warning_threshold_percent: number | null;
    }>(
      `SELECT usage_limit_period, max_cost_limit_usd, max_token_limit, warning_threshold_percent
       FROM project_ai_configurations
       WHERE project_id = $1`,
      [projectId],
    );

    const config = configRes.rows[0];
    const period = (config?.usage_limit_period === "daily" ? "daily" : "monthly") as "monthly" | "daily";
    const maxCostLimitUsd = config?.max_cost_limit_usd ? parseFloat(config.max_cost_limit_usd) : null;
    const maxTokenLimit = config?.max_token_limit ? parseInt(config.max_token_limit, 10) : null;
    const warningThresholdPercent = config?.warning_threshold_percent ?? 80;

    const { start: periodStart, reset: resetsAt } = getPeriodBoundaries(period);

    // 2. Fetch committed usage from ai_usage_logs
    const usageRes = await client.query<{
      total_tokens: string | null;
      total_cost: string | null;
    }>(
      `SELECT COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
              COALESCE(SUM(estimated_cost_usd), 0)::numeric AS total_cost
       FROM ai_usage_logs
       WHERE project_id = $1 AND created_at >= $2`,
      [projectId, periodStart],
    );

    const committedTokens = parseInt(usageRes.rows[0]?.total_tokens || "0", 10);
    const committedCostUsd = parseFloat(usageRes.rows[0]?.total_cost || "0");

    // 3. Fetch active unexpired and uncertain reservations from ai_budget_reservations
    const resRes = await client.query<{
      reserved_tokens: string | null;
      reserved_cost: string | null;
    }>(
      `SELECT COALESCE(SUM(reserved_tokens), 0)::bigint AS reserved_tokens,
              COALESCE(SUM(reserved_cost_usd), 0)::numeric AS reserved_cost
       FROM ai_budget_reservations
       WHERE project_id = $1 AND status IN ('active', 'uncertain') AND expires_at > NOW()`,
      [projectId],
    );

    const activeReservedTokens = parseInt(resRes.rows[0]?.reserved_tokens || "0", 10);
    const activeReservedCost = parseFloat(resRes.rows[0]?.reserved_cost || "0");

    const totalProjectedCost = committedCostUsd + activeReservedCost + estimatedCostUsd;
    const totalProjectedTokens = committedTokens + activeReservedTokens + estimatedTokens;

    let costExceeded = false;
    if (maxCostLimitUsd !== null && maxCostLimitUsd > 0) {
      costExceeded = totalProjectedCost > maxCostLimitUsd;
    }

    let tokenExceeded = false;
    if (maxTokenLimit !== null && maxTokenLimit > 0) {
      tokenExceeded = totalProjectedTokens > maxTokenLimit;
    }

    if (costExceeded || tokenExceeded) {
      await client.query("ROLLBACK");

      const limitDesc = maxCostLimitUsd !== null
        ? `$${(committedCostUsd + activeReservedCost).toFixed(4)} consumed/reserved of $${maxCostLimitUsd.toFixed(2)} ${period} cap`
        : `${(committedTokens + activeReservedTokens).toLocaleString()} tokens consumed/reserved of ${maxTokenLimit?.toLocaleString()} ${period} cap`;

      const resetDateStr = resetsAt.toISOString().split("T")[0];
      const message = `Project AI budget limit exceeded: ${limitDesc}. Limit resets on ${resetDateStr}. Please contact your administrator or QA manager to adjust project limits.`;

      await logAuditEvent({
        actorId,
        action: "PROJECT_AI_BUDGET_EXCEEDED",
        projectId,
        outcome: "denied",
        details: {
          committedCostUsd,
          activeReservedCost,
          maxCostLimitUsd,
          committedTokens,
          activeReservedTokens,
          maxTokenLimit,
          period,
          resetsAt,
        },
      });

      logger.warn("AI generation request blocked by project budget reservation limit", {
        projectId,
        committedCostUsd,
        activeReservedCost,
        maxCostLimitUsd,
        period,
      });

      throw new AIProviderError({
        message,
        code: "BUDGET_EXCEEDED",
        provider: "gemini",
        statusCode: 429,
        retryable: false,
      });
    }

    if (
      maxCostLimitUsd !== null &&
      (totalProjectedCost / maxCostLimitUsd) * 100 >= warningThresholdPercent
    ) {
      logger.info("Project AI usage approaching budget warning threshold", {
        projectId,
        projectedCost: totalProjectedCost,
        maxCostLimitUsd,
        warningThreshold: warningThresholdPercent,
      });
    }

    const safeUserId = actorId && actorId !== "00000000-0000-0000-0000-000000000001" ? actorId : null;
    const ownerToken = randomUUID();
    const insRes = await client.query<{
      id: string;
      project_id: string;
      reserved_tokens: number;
      reserved_cost_usd: string;
      status: string;
      owner_token?: string;
    }>(
      `INSERT INTO ai_budget_reservations
         (project_id, reserved_tokens, reserved_cost_usd, status, expires_at, feature, user_id, owner_token)
       VALUES ($1, $2, $3, 'active', NOW() + INTERVAL '5 minutes', $4, $5, $6)
       RETURNING id, project_id, reserved_tokens, reserved_cost_usd, status, owner_token`,
      [projectId, estimatedTokens, estimatedCostUsd, feature, safeUserId, ownerToken],
    );

    await client.query("COMMIT");

    const row = insRes?.rows?.[0] || {
      id: randomUUID(),
      project_id: projectId,
      reserved_tokens: estimatedTokens,
      reserved_cost_usd: String(estimatedCostUsd),
      status: "active",
      owner_token: ownerToken,
    };
    return {
      id: row.id,
      projectId: row.project_id,
      reservedTokens: row.reserved_tokens,
      reservedCostUsd: parseFloat(row.reserved_cost_usd),
      status: row.status as any,
      ownerToken: row.owner_token || ownerToken,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Renews an active AI budget reservation, pushing its expiration forward.
 * Only the reservation owner possessing ownerToken may renew.
 */
export async function renewAiBudgetReservation(
  reservationId: string,
  ownerToken: string,
  extendSeconds: number = 300,
): Promise<boolean> {
  if (!reservationId || !ownerToken) return false;
  try {
    const res = await pool.query(
      `UPDATE ai_budget_reservations
       SET expires_at = NOW() + ($3 || ' seconds')::interval
       WHERE id = $1 AND owner_token = $2 AND status = 'active'`,
      [reservationId, ownerToken, extendSeconds],
    );
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    logger.warn("Failed to renew AI budget reservation", { error: err, reservationId });
    return false;
  }
}

/**
 * Starts a periodic background heartbeat to keep an AI budget reservation alive
 * while a long-running provider request (> 5 minutes) is in progress.
 */
export function startReservationHeartbeat(
  reservationId: string,
  ownerToken?: string,
  intervalMs: number = 60000,
  extendSeconds: number = 300,
): { stop: () => void } {
  if (!reservationId || !ownerToken) {
    return { stop: () => {} };
  }

  const timer = setInterval(async () => {
    try {
      await renewAiBudgetReservation(reservationId, ownerToken, extendSeconds);
    } catch (err) {
      logger.warn("AI reservation heartbeat tick failed", { error: err, reservationId });
    }
  }, intervalMs);

  if (timer.unref) {
    timer.unref();
  }

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}

/**
 * Reconciles an active AI budget reservation against actual provider-reported token usage and cost.
 * Atomically transitions status to 'reconciled' and logs actual usage in ai_usage_logs.
 * Prevents double billing.
 */
export async function reconcileAiBudgetReservation(
  reservationId: string,
  actual: {
    promptTokens: number;
    completionTokens: number;
    estimatedCostUsd: number;
    model: string;
    provider: string;
    feature: string;
    durationMs: number;
    createdBy?: string;
  },
  ownerToken?: string,
): Promise<boolean> {
  if (!reservationId) return false;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const res = await client.query<{ project_id: string }>(
      `UPDATE ai_budget_reservations
       SET status = 'reconciled', reconciled_at = NOW()
       WHERE id = $1
         AND ($2::varchar IS NULL OR owner_token IS NULL OR owner_token = $2)
         AND status IN ('active', 'uncertain')
       RETURNING project_id`,
      [reservationId, ownerToken || null],
    );

    if (!res || (res.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return false; // Already reconciled, released, or ownership mismatch
    }

    const projectId = res.rows?.[0]?.project_id;
    if (!projectId) {
      await client.query("ROLLBACK");
      return false;
    }

    await recordAiUsage({
      projectId,
      feature: actual.feature,
      model: actual.model,
      provider: actual.provider as any,
      promptTokens: actual.promptTokens,
      completionTokens: actual.completionTokens,
      durationMs: actual.durationMs,
      createdBy: actual.createdBy,
    });

    await client.query("COMMIT");
    return true;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    logger.warn("Failed to reconcile AI budget reservation", { error: err, reservationId });
    return false;
  } finally {
    client.release();
  }
}

/**
 * Marks an active AI budget reservation as 'uncertain' (e.g. after a network timeout or connection reset).
 * Retains the reserved amount against the project's budget cap so timed-out provider calls
 * that may have incurred provider billing cannot be exploited to bypass budget limits.
 * Only the reservation owner may transition the status.
 */
export async function markReservationUncertain(
  reservationId: string,
  reason: string,
  ownerToken?: string,
): Promise<boolean> {
  if (!reservationId) return false;
  try {
    const res = await pool.query(
      `UPDATE ai_budget_reservations
       SET status = 'uncertain',
           uncertainty_reason = $2,
           reconciled_at = NOW()
       WHERE id = $1
         AND ($3::varchar IS NULL OR owner_token IS NULL OR owner_token = $3)
         AND status = 'active'`,
      [reservationId, reason.slice(0, 500), ownerToken || null],
    );
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    logger.warn("Failed to mark AI budget reservation as uncertain", { error: err, reservationId });
    return false;
  }
}

/**
 * Atomically releases an unused or failed AI budget reservation so reserved quota is restored immediately.
 */
export async function releaseAiBudgetReservation(
  reservationId: string,
  ownerToken?: string,
): Promise<boolean> {
  if (!reservationId) return false;
  try {
    const res = await pool.query(
      `UPDATE ai_budget_reservations
       SET status = 'released', reconciled_at = NOW()
       WHERE id = $1
         AND ($2::varchar IS NULL OR owner_token IS NULL OR owner_token = $2)
         AND status IN ('active', 'uncertain')`,
      [reservationId, ownerToken || null],
    );
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    logger.warn("Failed to release AI budget reservation", { error: err, reservationId });
    return false;
  }
}

/**
 * Determines whether an AI provider failure is a confirmed non-billing failure
 * (e.g. invalid credentials, missing model, rate limit rejected pre-execution, client-side network block)
 * vs an ambiguous outcome (e.g. TIMEOUT, mid-stream socket reset) where the provider may have processed and billed.
 */
export function isConfirmedProviderFailure(error: unknown): boolean {
  if (!error) return false;

  if (error instanceof AIProviderError) {
    if (
      error.code === "INVALID_CREDENTIALS" ||
      error.code === "MODEL_UNAVAILABLE" ||
      error.code === "BUDGET_EXCEEDED" ||
      error.code === "CONFIGURATION_ERROR"
    ) {
      return true;
    }
    if (error.statusCode === 400 || error.statusCode === 401 || error.statusCode === 403 || error.statusCode === 404) {
      return true;
    }
    if (error.code === "RATE_LIMIT_EXCEEDED" && error.statusCode === 429) {
      return true;
    }
    if (error.code === "TIMEOUT") {
      return false;
    }
  }

  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  // Local network / pre-flight blocks where request never reached provider
  if (
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("url rejected by security guard") ||
    msg.includes("dns resolution") ||
    msg.includes("prohibited address") ||
    msg.includes("private ip access is disabled")
  ) {
    return true;
  }

  // Ambiguous network drops
  if (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("socket hang up") ||
    msg.includes("gateway")
  ) {
    return false;
  }

  return false;
}

/**
 * Cleans up expired / abandoned reservations (e.g. from crashed workers older than 5 minutes).
 */
export async function cleanupExpiredReservations(): Promise<number> {
  try {
    const res = await pool.query(
      `UPDATE ai_budget_reservations
       SET status = 'expired', reconciled_at = NOW()
       WHERE status = 'active' AND expires_at <= NOW()`,
    );
    return res.rowCount ?? 0;
  } catch (err) {
    logger.warn("Failed to clean up expired AI reservations", { error: err });
    return 0;
  }
}

/**
 * Asserts that the project has remaining AI budget.
 * Blocks execution with AIProviderError (BUDGET_EXCEEDED, 429) if hard limits are exceeded.
 */
export async function assertProjectAiBudgetAvailable(
  projectId: string,
  actorId?: string,
): Promise<ProjectBudgetStatus> {
  const status = await getProjectAiBudgetStatus(projectId);

  if (!status.allowed) {
    const limitDesc = status.maxCostLimitUsd !== null
      ? `$${status.currentCostUsd.toFixed(2)} used of $${status.maxCostLimitUsd.toFixed(2)} ${status.period} cost budget`
      : `${status.currentTokens.toLocaleString()} used of ${status.maxTokenLimit?.toLocaleString()} ${status.period} token budget`;

    const resetDateStr = status.resetsAt.toISOString().split("T")[0];
    const message = `Project AI budget limit exceeded: ${limitDesc}. Limit resets on ${resetDateStr}. Please contact your administrator or QA manager to adjust project limits.`;

    await logAuditEvent({
      actorId,
      action: "PROJECT_AI_BUDGET_EXCEEDED",
      projectId,
      outcome: "denied",
      details: {
        currentCostUsd: status.currentCostUsd,
        maxCostLimitUsd: status.maxCostLimitUsd,
        currentTokens: status.currentTokens,
        maxTokenLimit: status.maxTokenLimit,
        period: status.period,
        resetsAt: status.resetsAt,
      },
    });

    logger.warn("AI generation request blocked by project budget limit", {
      projectId,
      currentCostUsd: status.currentCostUsd,
      maxCostLimitUsd: status.maxCostLimitUsd,
      period: status.period,
    });

    throw new AIProviderError({
      message,
      code: "BUDGET_EXCEEDED",
      provider: "gemini",
      statusCode: 429,
      retryable: false,
    });
  }

  if (status.isWarning) {
    logger.info("Project AI usage approaching budget warning threshold", {
      projectId,
      costPercent: status.costPercentUsed,
      tokenPercent: status.tokenPercentUsed,
      warningThreshold: status.warningThresholdPercent,
    });
  }

  return status;
}

/**
 * Updates AI budget and usage limits for a project.
 */
export async function updateProjectAiBudgetLimits(
  projectId: string,
  params: {
    usageLimitPeriod?: "monthly" | "daily";
    maxCostLimitUsd?: number | null;
    maxTokenLimit?: number | null;
    warningThresholdPercent?: number;
    cacheEnabled?: boolean;
    cacheTtlSeconds?: number;
  },
  userId?: string,
): Promise<ProjectBudgetStatus> {
  const {
    usageLimitPeriod = "monthly",
    maxCostLimitUsd = null,
    maxTokenLimit = null,
    warningThresholdPercent = 80,
    cacheEnabled = true,
    cacheTtlSeconds = 86400,
  } = params;

  const safeUserId = userId && userId !== "00000000-0000-0000-0000-000000000001" ? userId : null;

  await pool.query(
    `INSERT INTO project_ai_configurations
       (project_id, usage_limit_period, max_cost_limit_usd, max_token_limit,
        warning_threshold_percent, cache_enabled, cache_ttl_seconds, updated_by, created_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, NOW())
     ON CONFLICT (project_id)
     DO UPDATE SET
       usage_limit_period = EXCLUDED.usage_limit_period,
       max_cost_limit_usd = EXCLUDED.max_cost_limit_usd,
       max_token_limit = EXCLUDED.max_token_limit,
       warning_threshold_percent = EXCLUDED.warning_threshold_percent,
       cache_enabled = EXCLUDED.cache_enabled,
       cache_ttl_seconds = EXCLUDED.cache_ttl_seconds,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [
      projectId,
      usageLimitPeriod,
      maxCostLimitUsd,
      maxTokenLimit,
      warningThresholdPercent,
      cacheEnabled,
      cacheTtlSeconds,
      safeUserId,
    ],
  );

  return getProjectAiBudgetStatus(projectId);
}
