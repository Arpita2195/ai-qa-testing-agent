import crypto from "node:crypto";
import { pool } from "../../config/db";
import { env } from "../../config/env";
import { logger } from "../observability/logger";
import { inMemoryMetrics } from "../observability/metricsService";
import type { AIProviderType } from "./types";

export interface CacheKeyParams {
  projectId: string;
  provider: AIProviderType | string;
  model: string;
  feature: string;
  prompt: string;
  systemInstruction?: string;
  responseFormat?: "json" | "text" | string;
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  contextVersion?: string | number;
  options?: Record<string, unknown>;
}

export interface CachedAiResponse {
  id: string;
  projectId: string;
  cacheKey: string;
  provider: AIProviderType;
  model: string;
  feature: string;
  text: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  hitCount: number;
  createdAt: Date;
  expiresAt: Date;
}

export interface SaveAiCacheParams {
  projectId: string;
  cacheKey: string;
  provider: AIProviderType;
  model: string;
  feature: string;
  prompt: string;
  responseText: string;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  ttlSeconds?: number;
}

export interface AiCacheStats {
  totalCachedEntries: number;
  totalHits: number;
  savedTokens: number;
  savedCostUsd: number;
}

/**
 * Checks whether text contains detected secret values, credentials, or session tokens.
 * Requests containing secrets are strictly excluded from caching.
 */
function containsSensitiveData(text: string): boolean {
  if (!text) return false;
  const secretsToCheck = [
    process.env.GEMINI_API_KEY,
    process.env.OPENAI_API_KEY,
    process.env.GROQ_API_KEY,
    process.env.ENCRYPTION_KEY,
    env.PLATFORM_API_KEY,
    env.STOCKFLOW_TEST_PASSWORD,
  ];

  for (const s of secretsToCheck) {
    if (s && s.length >= 8 && text.includes(s)) {
      return true;
    }
  }

  // Common pattern checks for Bearer tokens or raw API keys
  if (/(?:bearer\s+[a-zA-Z0-9_\-\.]{25,}|sk-[a-zA-Z0-9_\-]{20,}|gsk_[a-zA-Z0-9_\-]{20,})/i.test(text)) {
    return true;
  }

  return false;
}

/**
 * Recursively sorts object keys for deterministic canonical hashing.
 */
function canonicalizeObject(val: unknown): unknown {
  if (val === null || val === undefined) return null;
  if (Array.isArray(val)) return val.map(canonicalizeObject);
  if (typeof val === "object") {
    const sortedKeys = Object.keys(val as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalizeObject((val as Record<string, unknown>)[key]);
    }
    return result;
  }
  return val;
}

/**
 * Generates a deterministic SHA-256 cache key including all request dimensions.
 * Project ID is strictly partitioned into the key to enforce multi-tenant isolation.
 * Incorporates model, provider, feature, prompt, system instruction, format, temperature,
 * maxOutputTokens, topP, contextVersion, and extra generation options.
 */
export function generateAiCacheKey(params: CacheKeyParams): string {
  const normalizedPrompt = params.prompt.trim().replace(/\s+/g, " ");
  const normalizedSystem = (params.systemInstruction || "").trim().replace(/\s+/g, " ");

  const payload = {
    projectId: params.projectId,
    provider: (params.provider || "gemini").toLowerCase(),
    model: (params.model || "").toLowerCase(),
    feature: (params.feature || "default").toLowerCase(),
    prompt: normalizedPrompt,
    system: normalizedSystem,
    format: params.responseFormat || "json",
    temperature: params.temperature !== undefined && params.temperature !== null ? Number(params.temperature) : null,
    maxTokens: params.maxOutputTokens !== undefined && params.maxOutputTokens !== null ? Number(params.maxOutputTokens) : null,
    topP: params.topP !== undefined && params.topP !== null ? Number(params.topP) : null,
    contextVersion: params.contextVersion !== undefined && params.contextVersion !== null ? String(params.contextVersion) : null,
    options: params.options ? canonicalizeObject(params.options) : null,
  };

  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * Retrieves a cached AI response for an identical prior request within the same project.
 * Enforces TTL expiration and project-level boundary isolation.
 */
export async function getAiResponseCache(
  projectId: string,
  cacheKey: string,
): Promise<CachedAiResponse | null> {
  if (!projectId || !cacheKey) return null;

  try {
    const res = await pool.query<{
      id: string;
      project_id: string;
      cache_key: string;
      provider: string;
      model: string;
      feature: string;
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      estimated_cost_usd: string;
      response_text: string;
      hit_count: number;
      created_at: Date;
      expires_at: Date;
    }>(
      `SELECT id, project_id, cache_key, provider, model, feature,
              prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd,
              response_text, hit_count, created_at, expires_at
       FROM ai_response_cache
       WHERE project_id = $1 AND cache_key = $2 AND expires_at > NOW()`,
      [projectId, cacheKey],
    );

    if (!res || !res.rows || res.rows.length === 0 || !res.rows[0]) {
      inMemoryMetrics.trackAiCacheMiss(projectId);
      return null;
    }

    const row = res.rows[0];
    const savedTokens = row.total_tokens || (row.prompt_tokens + row.completion_tokens);
    const savedCostUsd = parseFloat(row.estimated_cost_usd || "0");

    // Atomically increment hit count and update last_hit_at
    await pool.query(
      `UPDATE ai_response_cache
       SET hit_count = hit_count + 1, last_hit_at = NOW()
       WHERE id = $1`,
      [row.id],
    );

    // Record telemetry in savings log
    await pool.query(
      `INSERT INTO ai_cache_savings_logs
         (project_id, cache_id, feature, provider, model, saved_tokens, saved_cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [projectId, row.id, row.feature, row.provider, row.model, savedTokens, savedCostUsd],
    );

    inMemoryMetrics.trackAiCacheHit(projectId, savedTokens, savedCostUsd);

    logger.debug("AI Response Cache Hit - Saved provider call", {
      projectId,
      feature: row.feature,
      provider: row.provider,
      savedTokens,
      savedCostUsd,
    });

    return {
      id: row.id,
      projectId: row.project_id,
      cacheKey: row.cache_key,
      provider: row.provider as AIProviderType,
      model: row.model,
      feature: row.feature,
      text: row.response_text,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      totalTokens: row.total_tokens,
      estimatedCostUsd: savedCostUsd,
      hitCount: row.hit_count + 1,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  } catch (err) {
    logger.warn("Failed to check AI response cache", { error: err, projectId });
    return null;
  }
}

/**
 * Stores a successful AI response in the cache.
 * Excludes responses containing detected secrets, empty outputs, or error payloads.
 * Supports both object params and (projectId, cacheKey, options) positional signatures.
 */
export async function setAiResponseCache(
  paramsOrProjectId: SaveAiCacheParams | string,
  cacheKeyArg?: string,
  extraArg?: {
    text?: string;
    responseText?: string;
    provider?: AIProviderType;
    model?: string;
    feature?: string;
    prompt?: string;
    promptTokens?: number;
    completionTokens?: number;
    estimatedCostUsd?: number;
    ttlSeconds?: number;
  },
): Promise<boolean> {
  let params: SaveAiCacheParams;
  if (typeof paramsOrProjectId === "string") {
    params = {
      projectId: paramsOrProjectId,
      cacheKey: cacheKeyArg || "",
      provider: (extraArg?.provider as AIProviderType) || "gemini",
      model: extraArg?.model || "gemini-2.5-flash",
      feature: extraArg?.feature || "test_generation",
      prompt: extraArg?.prompt || "",
      responseText: extraArg?.responseText || extraArg?.text || "",
      promptTokens: extraArg?.promptTokens ?? 0,
      completionTokens: extraArg?.completionTokens ?? 0,
      estimatedCostUsd: extraArg?.estimatedCostUsd ?? 0,
      ttlSeconds: extraArg?.ttlSeconds ?? 86400,
    };
  } else {
    params = paramsOrProjectId;
  }

  const {
    projectId,
    cacheKey,
    provider,
    model,
    feature,
    prompt,
    responseText,
    promptTokens = 0,
    completionTokens = 0,
    estimatedCostUsd = 0,
    ttlSeconds = 86400, // 24-hour default
  } = params;

  if (!projectId || !cacheKey || !responseText || !responseText.trim()) {
    return false;
  }

  // Safety check: Never cache credentials, passwords, or API keys
  if (containsSensitiveData(prompt) || containsSensitiveData(responseText)) {
    logger.debug("Excluded AI request/response from cache: sensitive pattern detected", {
      projectId,
      feature,
    });
    return false;
  }

  const safePromptTokens = Number.isFinite(promptTokens) ? promptTokens : 0;
  const safeCompletionTokens = Number.isFinite(completionTokens) ? completionTokens : 0;
  const safeEstimatedCostUsd = Number.isFinite(estimatedCostUsd) ? estimatedCostUsd : 0;
  const totalTokens = safePromptTokens + safeCompletionTokens;

  try {
    await pool.query(
      `INSERT INTO ai_response_cache
         (project_id, cache_key, provider, model, feature, prompt_tokens,
          completion_tokens, total_tokens, estimated_cost_usd, response_text,
          expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW() + ($11 || ' seconds')::interval, NOW())
       ON CONFLICT (project_id, cache_key)
       DO UPDATE SET
         response_text = EXCLUDED.response_text,
         prompt_tokens = EXCLUDED.prompt_tokens,
         completion_tokens = EXCLUDED.completion_tokens,
         total_tokens = EXCLUDED.total_tokens,
         estimated_cost_usd = EXCLUDED.estimated_cost_usd,
         expires_at = EXCLUDED.expires_at`,
      [
        projectId,
        cacheKey,
        provider,
        model,
        feature,
        safePromptTokens,
        safeCompletionTokens,
        totalTokens,
        safeEstimatedCostUsd,
        responseText,
        ttlSeconds,
      ],
    );

    return true;
  } catch (err) {
    logger.warn("Failed to write to AI response cache", { error: err, projectId });
    return false;
  }
}

/**
 * Deletes all cached responses for a project (e.g. on configuration changes or manual flush).
 */
export async function invalidateProjectAiCache(projectId: string): Promise<number> {
  if (!projectId) return 0;
  try {
    const res = await pool.query(
      "DELETE FROM ai_response_cache WHERE project_id = $1",
      [projectId],
    );
    logger.info("Invalidated AI response cache for project", {
      projectId,
      deletedEntries: res.rowCount,
    });
    return res.rowCount ?? 0;
  } catch (err) {
    logger.warn("Failed to invalidate project AI response cache", { error: err, projectId });
    return 0;
  }
}

/**
 * Retrieves aggregate AI cache performance statistics for a project.
 */
export async function getProjectAiCacheStats(projectId: string): Promise<AiCacheStats> {
  if (!projectId) {
    return { totalCachedEntries: 0, totalHits: 0, savedTokens: 0, savedCostUsd: 0 };
  }

  try {
    const entriesRes = await pool.query<{ count: string; hits: string }>(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(hit_count), 0)::int AS hits
       FROM ai_response_cache
       WHERE project_id = $1`,
      [projectId],
    );

    const savingsRes = await pool.query<{ tokens: string; cost: string }>(
      `SELECT COALESCE(SUM(saved_tokens), 0)::bigint AS tokens,
              COALESCE(SUM(saved_cost_usd), 0)::numeric AS cost
       FROM ai_cache_savings_logs
       WHERE project_id = $1`,
      [projectId],
    );

    return {
      totalCachedEntries: parseInt(entriesRes.rows[0]?.count || "0", 10),
      totalHits: parseInt(entriesRes.rows[0]?.hits || "0", 10),
      savedTokens: parseInt(savingsRes.rows[0]?.tokens || "0", 10),
      savedCostUsd: parseFloat(savingsRes.rows[0]?.cost || "0"),
    };
  } catch (err) {
    logger.warn("Failed to query project AI cache statistics", { error: err, projectId });
    return { totalCachedEntries: 0, totalHits: 0, savedTokens: 0, savedCostUsd: 0 };
  }
}
