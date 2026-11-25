import { GeminiProvider } from "./geminiProvider";
import { OpenAIProvider } from "./openaiProvider";
import { OllamaProvider } from "./ollamaProvider";
import { GroqProvider } from "./groqProvider";
import { getDecryptedProjectAiConfig, getDefaultModelForProvider } from "./projectAiConfigService";
import {
  type AIProvider,
  type AIProviderType,
  type AIProviderConfig,
  AIProviderError,
} from "./types";

export type AIProviderConstructor = new (config?: AIProviderConfig, client?: any) => AIProvider;

const providerRegistry = new Map<AIProviderType, AIProviderConstructor>();
providerRegistry.set("gemini", GeminiProvider);
providerRegistry.set("openai", OpenAIProvider);
providerRegistry.set("ollama", OllamaProvider);
providerRegistry.set("groq", GroqProvider);

/**
 * Registers an AI provider implementation in the factory.
 */
export function registerAIProvider(type: AIProviderType, ctor: AIProviderConstructor): void {
  providerRegistry.set(type, ctor);
}

/**
 * Instantiates an AIProvider of the requested type with optional configuration.
 */
export function getAIProvider(
  type: AIProviderType = "gemini",
  config: AIProviderConfig = {},
  client?: any,
): AIProvider {
  const ProviderClass = providerRegistry.get(type);
  if (!ProviderClass) {
    throw new AIProviderError({
      message: `Unsupported AI provider type: ${type}`,
      code: "CONFIGURATION_ERROR",
      provider: type,
    });
  }
  return new ProviderClass(config, client);
}

/**
 * Resolves the configured AI provider for a specific project.
 * Queries `project_ai_configurations` for custom provider, model, API key, and baseUrl.
 * Defaults to Gemini if no project-specific provider is configured.
 */
export async function getAIProviderForProject(
  projectId?: string,
  config?: AIProviderConfig,
  client?: any,
): Promise<AIProvider> {
  if (projectId) {
    try {
      const saved = await getDecryptedProjectAiConfig(projectId);
      if (saved) {
        const resolvedModel =
          config?.model?.trim() || saved.model?.trim() || getDefaultModelForProvider(saved.provider);
        const mergedConfig: AIProviderConfig = {
          ...config,
          model: resolvedModel,
          apiKey: config?.apiKey || saved.apiKey,
          baseUrl: config?.baseUrl || saved.baseUrl,
        };
        return getAIProvider(saved.provider, mergedConfig, client);
      }
    } catch {
      // In case of error (e.g. DB unavailable or table missing), fall back to Gemini
    }
  }

  const defaultProvider = "gemini";
  const defaultModel = config?.model?.trim() || getDefaultModelForProvider(defaultProvider);
  return getAIProvider(defaultProvider, { ...config, model: defaultModel }, client);
}

/**
 * Helper to determine if an error returned by any AI provider is retryable.
 */
export function isRetryableAIError(error: unknown): boolean {
  if (error instanceof AIProviderError) {
    return error.retryable;
  }
  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    return (
      lower.includes("429") ||
      lower.includes("503") ||
      lower.includes("resource_exhausted") ||
      lower.includes("resource exhausted") ||
      lower.includes("rate limit") ||
      lower.includes("service unavailable") ||
      lower.includes("overloaded") ||
      lower.includes("timeout")
    );
  }
  return false;
}
