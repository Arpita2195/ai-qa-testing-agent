import { pool } from "../../config/db";
import { env } from "../../config/env";
import { encryptSecret, decryptSecret } from "../secretStore";
import { validateOllamaBaseUrl } from "./ollamaProvider";
import { isAllowPrivateTargets } from "../urlGuard";
import { getAIProvider } from "./providerFactory";
import {
  type AIProviderType,
  type AIProviderConfig,
  type AIConnectionTestResult,
  AIProviderError,
} from "./types";

export interface SafeProjectAiConfig {
  projectId: string;
  provider: AIProviderType;
  model?: string;
  hasApiKey: boolean;
  hasPrimaryApiKey: boolean;
  hasReviewerApiKey: boolean;
  twoStageReviewEnabled: boolean;
  reviewModel: string;
  baseUrl?: string;
  isDefault: boolean;
  updatedAt?: Date;
  updatedBy?: string;
}

export interface DecryptedProjectAiConfig {
  projectId: string;
  provider: AIProviderType;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  twoStageReviewEnabled: boolean;
  reviewModel: string;
  reviewerApiKey?: string;
}

export interface SaveProjectAiConfigInput {
  provider: AIProviderType;
  model?: string | null;
  apiKey?: string | null;
  clearApiKey?: boolean;
  baseUrl?: string | null;
  twoStageReviewEnabled?: boolean;
  reviewModel?: string | null;
  reviewerApiKey?: string | null;
  clearReviewerApiKey?: boolean;
}

export interface TestProjectAiConfigInput {
  provider?: AIProviderType;
  model?: string | null;
  apiKey?: string | null;
  baseUrl?: string | null;
  testReviewer?: boolean;
  reviewModel?: string | null;
  reviewerApiKey?: string | null;
}

/**
 * Resolves the default model for a given provider honoring source-of-truth precedence:
 * 1. Configured environment model for that provider.
 * 2. Documented, supported application default.
 */
export function getDefaultModelForProvider(provider: AIProviderType): string {
  switch (provider) {
    case "gemini":
      return (process.env.AI_MODEL?.trim() || env.AI_MODEL?.trim() || "gemini-3.1-flash-lite");
    case "openai":
      return (process.env.OPENAI_MODEL?.trim() || env.OPENAI_MODEL?.trim() || "gpt-4o-mini");
    case "ollama":
      return (process.env.OLLAMA_MODEL?.trim() || env.OLLAMA_MODEL?.trim() || "llama3.2");
    case "groq":
      return (process.env.GROQ_MODEL?.trim() || env.GROQ_MODEL?.trim() || "openai/gpt-oss-120b");
  }
}

export const DEFAULT_MODELS: Record<AIProviderType, string> = {
  get gemini() {
    return getDefaultModelForProvider("gemini");
  },
  get openai() {
    return getDefaultModelForProvider("openai");
  },
  get ollama() {
    return getDefaultModelForProvider("ollama");
  },
  get groq() {
    return getDefaultModelForProvider("groq");
  },
};

/**
 * Redacts any detected API keys or passwords from error strings.
 */
function sanitizeErrorMessage(message: string): string {
  if (!message) return "";
  let sanitized = message;
  for (const secret of [
    process.env.GEMINI_API_KEY,
    process.env.OPENAI_API_KEY,
    process.env.GROQ_API_KEY,
    process.env.ENCRYPTION_KEY,
    env.PLATFORM_API_KEY,
    env.STOCKFLOW_TEST_PASSWORD,
  ]) {
    if (secret) {
      sanitized = sanitized.split(secret).join("[hidden]");
    }
  }
  return sanitized;
}

/**
 * Retrieves the public/safe AI provider configuration metadata for a project.
 * Never returns plaintext or encrypted API keys.
 */
export async function getProjectAiConfig(projectId: string): Promise<SafeProjectAiConfig> {
  const result = await pool.query<{
    provider: string;
    model: string | null;
    api_key_enc: string | null;
    base_url: string | null;
    two_stage_review_enabled: boolean | null;
    review_model: string | null;
    updated_at: Date;
    updated_by: string | null;
  }>(
    `SELECT provider, model, api_key_enc, base_url, two_stage_review_enabled, review_model, updated_at, updated_by
     FROM project_ai_configurations
     WHERE project_id = $1`,
    [projectId],
  );

  const credsResult = await pool.query<{
    provider: string;
    api_key_enc: string | null;
  }>(
    `SELECT provider, api_key_enc
     FROM project_ai_provider_credentials
     WHERE project_id = $1`,
    [projectId],
  );

  const credsMap = new Map<string, boolean>();
  for (const row of credsResult?.rows || []) {
    credsMap.set(row.provider, Boolean(row.api_key_enc));
  }

  if (!result?.rows || result.rows.length === 0) {
    const hasReviewerKey = credsMap.get("groq") || Boolean(process.env.GROQ_API_KEY);
    return {
      projectId,
      provider: "gemini",
      model: DEFAULT_MODELS.gemini,
      hasApiKey: false,
      hasPrimaryApiKey: false,
      hasReviewerApiKey: Boolean(hasReviewerKey),
      twoStageReviewEnabled: false,
      reviewModel: "openai/gpt-oss-120b",
      isDefault: true,
    };
  }

  const row = result.rows[0];
  const provider = (row.provider as AIProviderType) || "gemini";
  const hasPrimaryApiKey = Boolean(credsMap.get(provider) || row.api_key_enc);
  const hasReviewerApiKey = Boolean(credsMap.get("groq") || process.env.GROQ_API_KEY);

  return {
    projectId,
    provider,
    model: row.model || DEFAULT_MODELS[provider] || undefined,
    hasApiKey: hasPrimaryApiKey,
    hasPrimaryApiKey,
    hasReviewerApiKey,
    twoStageReviewEnabled: Boolean(row.two_stage_review_enabled),
    reviewModel: row.review_model || "openai/gpt-oss-120b",
    baseUrl: row.base_url || undefined,
    isDefault: false,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by || undefined,
  };
}

/**
 * Internal helper to retrieve decrypted project AI configuration.
 * Accessible only by backend services; never exposed in HTTP API responses.
 */
export async function getDecryptedProjectAiConfig(
  projectId: string,
): Promise<DecryptedProjectAiConfig | null> {
  const result = await pool.query<{
    provider: string;
    model: string | null;
    api_key_enc: string | null;
    base_url: string | null;
    two_stage_review_enabled: boolean | null;
    review_model: string | null;
  }>(
    `SELECT provider, model, api_key_enc, base_url, two_stage_review_enabled, review_model
     FROM project_ai_configurations
     WHERE project_id = $1`,
    [projectId],
  );

  const credsResult = await pool.query<{
    provider: string;
    api_key_enc: string | null;
  }>(
    `SELECT provider, api_key_enc
     FROM project_ai_provider_credentials
     WHERE project_id = $1`,
    [projectId],
  );

  const credsMap = new Map<string, string>();
  for (const row of credsResult?.rows || []) {
    if (row.api_key_enc) {
      try {
        const decrypted = decryptSecret(row.api_key_enc);
        credsMap.set(row.provider, decrypted);
      } catch {
        // ignore decryption failure
      }
    }
  }

  if (!result?.rows || result.rows.length === 0) {
    const reviewerKey = credsMap.get("groq") || process.env.GROQ_API_KEY || env.GROQ_API_KEY;
    return {
      projectId,
      provider: "gemini",
      model: DEFAULT_MODELS.gemini,
      apiKey: credsMap.get("gemini") || process.env.GEMINI_API_KEY,
      twoStageReviewEnabled: false,
      reviewModel: "openai/gpt-oss-120b",
      reviewerApiKey: reviewerKey,
    };
  }

  const row = result.rows[0];
  const provider = (row.provider as AIProviderType) || "gemini";

  let primaryApiKey = credsMap.get(provider);
  if (!primaryApiKey && row.api_key_enc) {
    try {
      primaryApiKey = decryptSecret(row.api_key_enc);
    } catch {
      primaryApiKey = undefined;
    }
  }

  const reviewerApiKey = credsMap.get("groq") || process.env.GROQ_API_KEY || env.GROQ_API_KEY;

  return {
    projectId,
    provider,
    model: row.model?.trim() || getDefaultModelForProvider(provider),
    apiKey: primaryApiKey,
    baseUrl: row.base_url || undefined,
    twoStageReviewEnabled: Boolean(row.two_stage_review_enabled),
    reviewModel: row.review_model || "openai/gpt-oss-120b",
    reviewerApiKey,
  };
}

/**
 * Saves (upserts) the AI provider configuration for a project.
 * Encrypts API keys using AES-256-GCM before saving to database.
 */
export async function saveProjectAiConfig(
  projectId: string,
  input: SaveProjectAiConfigInput,
  userId?: string,
): Promise<SafeProjectAiConfig> {
  const provider = input.provider;
  if (!["gemini", "openai", "ollama", "groq"].includes(provider)) {
    throw new AIProviderError({
      message: `Invalid AI provider '${provider}'. Must be one of: gemini, openai, ollama, groq`,
      code: "CONFIGURATION_ERROR",
      provider: "gemini",
    });
  }

  const model = input.model?.trim() || null;
  const reviewModel = input.reviewModel?.trim() || "openai/gpt-oss-120b";
  const twoStageReviewEnabled = input.twoStageReviewEnabled ?? false;

  // Validate Ollama base URL if provider is Ollama
  let baseUrl: string | null = null;
  if (provider === "ollama") {
    const rawUrl = input.baseUrl?.trim() || "http://127.0.0.1:11434";
    baseUrl = validateOllamaBaseUrl(rawUrl, {
      allowLocalhost: true,
      allowPrivateNetworks: isAllowPrivateTargets(),
    });
  }

  // Handle primary API key encryption or clearing
  let apiKeyEnc: string | null | undefined = undefined;

  if (input.clearApiKey) {
    apiKeyEnc = null;
    await pool.query(
      `DELETE FROM project_ai_provider_credentials WHERE project_id = $1 AND provider = $2`,
      [projectId, provider],
    );
  } else if (input.apiKey && input.apiKey.trim()) {
    apiKeyEnc = encryptSecret(input.apiKey.trim());
    await pool.query(
      `INSERT INTO project_ai_provider_credentials (project_id, provider, api_key_enc, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (project_id, provider)
       DO UPDATE SET api_key_enc = EXCLUDED.api_key_enc, updated_at = NOW()`,
      [projectId, provider, apiKeyEnc],
    );
  }

  // Handle reviewer API key encryption or clearing
  if (input.clearReviewerApiKey) {
    await pool.query(
      `DELETE FROM project_ai_provider_credentials WHERE project_id = $1 AND provider = 'groq'`,
      [projectId],
    );
  } else if (input.reviewerApiKey && input.reviewerApiKey.trim()) {
    const reviewerKeyEnc = encryptSecret(input.reviewerApiKey.trim());
    await pool.query(
      `INSERT INTO project_ai_provider_credentials (project_id, provider, api_key_enc, updated_at)
       VALUES ($1, 'groq', $2, NOW())
       ON CONFLICT (project_id, provider)
       DO UPDATE SET api_key_enc = EXCLUDED.api_key_enc, updated_at = NOW()`,
      [projectId, reviewerKeyEnc],
    );
  }

  const safeUserId =
    userId && userId !== "00000000-0000-0000-0000-000000000001" ? userId : null;

  if (apiKeyEnc !== undefined) {
    // Explicit API key update or clear
    await pool.query(
      `INSERT INTO project_ai_configurations
         (project_id, provider, model, api_key_enc, base_url, two_stage_review_enabled, review_model, updated_by, created_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, NOW())
       ON CONFLICT (project_id)
       DO UPDATE SET
         provider = EXCLUDED.provider,
         model = EXCLUDED.model,
         api_key_enc = EXCLUDED.api_key_enc,
         base_url = EXCLUDED.base_url,
         two_stage_review_enabled = EXCLUDED.two_stage_review_enabled,
         review_model = EXCLUDED.review_model,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()`,
      [projectId, provider, model, apiKeyEnc, baseUrl, twoStageReviewEnabled, reviewModel, safeUserId],
    );
  } else {
    // Retain existing API key if present
    await pool.query(
      `INSERT INTO project_ai_configurations
         (project_id, provider, model, api_key_enc, base_url, two_stage_review_enabled, review_model, updated_by, created_by, updated_at)
       VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $7, NOW())
       ON CONFLICT (project_id)
       DO UPDATE SET
         provider = EXCLUDED.provider,
         model = EXCLUDED.model,
         base_url = EXCLUDED.base_url,
         two_stage_review_enabled = EXCLUDED.two_stage_review_enabled,
         review_model = EXCLUDED.review_model,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()`,
      [projectId, provider, model, baseUrl, twoStageReviewEnabled, reviewModel, safeUserId],
    );
  }

  return getProjectAiConfig(projectId);
}

/**
 * Resets a project's AI provider configuration to the default (Gemini).
 */
export async function deleteProjectAiConfig(projectId: string): Promise<boolean> {
  await pool.query(
    `DELETE FROM project_ai_provider_credentials WHERE project_id = $1`,
    [projectId],
  );
  const result = await pool.query(
    `DELETE FROM project_ai_configurations WHERE project_id = $1`,
    [projectId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Tests connection to the selected or candidate AI provider.
 * Supports testing primary generator or Groq independent reviewer.
 */
export async function testProjectAiConfig(
  projectId: string,
  input: TestProjectAiConfigInput = {},
): Promise<AIConnectionTestResult> {
  const existing = await getDecryptedProjectAiConfig(projectId);

  if (input.testReviewer) {
    const model = input.reviewModel?.trim() || existing?.reviewModel || "openai/gpt-oss-120b";
    const apiKey = input.reviewerApiKey?.trim() || existing?.reviewerApiKey;

    try {
      const config: AIProviderConfig = {
        model,
        apiKey,
      };
      const provider = getAIProvider("groq", config);
      const result = await provider.testConnection();
      if (!result.success && result.error) {
        return {
          ...result,
          error: sanitizeErrorMessage(result.error),
        };
      }
      return result;
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        provider: "groq",
        model,
        latencyMs: 0,
        error: sanitizeErrorMessage(rawMessage),
      };
    }
  }

  const providerType: AIProviderType = input.provider || existing?.provider || "gemini";
  const model = input.model?.trim() || existing?.model || DEFAULT_MODELS[providerType];

  let apiKey: string | undefined;
  if (input.apiKey && input.apiKey.trim()) {
    apiKey = input.apiKey.trim();
  } else if (existing?.apiKey) {
    apiKey = existing.apiKey;
  }

  try {
    let baseUrl: string | undefined;
    if (providerType === "ollama") {
      const rawUrl = input.baseUrl?.trim() || existing?.baseUrl || "http://127.0.0.1:11434";
      baseUrl = validateOllamaBaseUrl(rawUrl, {
        allowLocalhost: true,
        allowPrivateNetworks: isAllowPrivateTargets(),
      });
    }

    const config: AIProviderConfig = {
      model,
      apiKey,
      baseUrl,
    };

    const provider = getAIProvider(providerType, config);
    const result = await provider.testConnection();

    if (!result.success && result.error) {
      return {
        ...result,
        error: sanitizeErrorMessage(result.error),
      };
    }

    return result;
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      provider: providerType,
      model,
      latencyMs: 0,
      error: sanitizeErrorMessage(rawMessage),
    };
  }
}
