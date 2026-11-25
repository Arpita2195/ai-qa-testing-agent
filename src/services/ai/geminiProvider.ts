import { GoogleGenAI } from "@google/genai";
import { env } from "../../config/env";
import { calculateEstimatedCostUsd } from "./pricing";
import {
  type AIProvider,
  type AIProviderType,
  type AIGenerateOptions,
  type AIGenerateResult,
  type AIConnectionTestResult,
  type AIProviderConfig,
  AIProviderError,
} from "./types";

export class GeminiProvider implements AIProvider {
  public readonly providerType: AIProviderType = "gemini";
  public readonly defaultModel: string;
  private readonly client: GoogleGenAI;
  private readonly timeoutMs: number;
  private readonly apiKey: string;

  constructor(config: AIProviderConfig = {}, client?: GoogleGenAI) {
    const apiKey = config.apiKey !== undefined ? config.apiKey : env.GEMINI_API_KEY;
    if (!client && !apiKey) {
      throw new AIProviderError({
        message: "Gemini API key is not configured",
        code: "CONFIGURATION_ERROR",
        provider: "gemini",
      });
    }

    this.apiKey = apiKey || "";
    this.defaultModel =
      config.model?.trim() || process.env.AI_MODEL?.trim() || env.AI_MODEL?.trim() || "gemini-3.1-flash-lite";
    this.timeoutMs = config.timeoutMs || 60000;
    this.client = client ?? new GoogleGenAI({ apiKey: apiKey! });
  }

  async generateText(options: AIGenerateOptions): Promise<AIGenerateResult> {
    const model = options.model || this.defaultModel;
    const maxOutputTokens = options.maxOutputTokens ?? 8192;
    const temperature = options.temperature ?? 0.2;
    const t0 = Date.now();

    try {
      const generateConfig: Record<string, unknown> = {
        maxOutputTokens,
        temperature,
      };

      if (options.responseFormat === "json") {
        generateConfig.responseMimeType = "application/json";
      }

      if (options.systemInstruction) {
        generateConfig.systemInstruction = options.systemInstruction;
      }

      if (options.stopSequences && options.stopSequences.length > 0) {
        generateConfig.stopSequences = options.stopSequences;
      }

      // Execute with timeout race and cleanup
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AIProviderError({
                message: `Gemini request timed out after ${options.timeoutMs || this.timeoutMs}ms`,
                code: "TIMEOUT",
                provider: "gemini",
                retryable: true,
              }),
            ),
          options.timeoutMs || this.timeoutMs,
        );
      });

      const responsePromise = this.client.models.generateContent({
        model,
        contents: options.prompt,
        config: generateConfig as any,
      });

      let response: any;
      try {
        response = await Promise.race([responsePromise, timeoutPromise]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      const durationMs = Date.now() - t0;

      const rawText = typeof response?.text === "function" ? response.text() : response?.text;

      if (!rawText || typeof rawText !== "string" || !rawText.trim()) {
        throw new AIProviderError({
          message: "Gemini returned an empty response",
          code: "INVALID_RESPONSE",
          provider: "gemini",
          retryable: true,
        });
      }

      let text = rawText.trim();
      if (options.responseFormat === "json") {
        if (text.startsWith("```json")) {
          text = text.slice(7);
        } else if (text.startsWith("```")) {
          text = text.slice(3);
        }
        if (text.endsWith("```")) {
          text = text.slice(0, -3);
        }
        text = text.trim();
      }

      // Extract usage tokens if available from response metadata, else fallback to estimation
      let promptTokens: number;
      let completionTokens: number;
      let isUsageEstimated = false;

      const usage = (response as any).usageMetadata;
      if (usage && typeof usage.promptTokenCount === "number") {
        promptTokens = usage.promptTokenCount;
        completionTokens = usage.candidatesTokenCount ?? Math.ceil(text.length / 4);
      } else {
        promptTokens = Math.ceil((options.prompt.length + (options.systemInstruction?.length || 0)) / 4);
        completionTokens = Math.ceil(text.length / 4);
        isUsageEstimated = true;
      }

      const totalTokens = promptTokens + completionTokens;
      const estimatedCostUsd = calculateEstimatedCostUsd(model, promptTokens, completionTokens);

      return {
        text,
        promptTokens,
        completionTokens,
        totalTokens,
        estimatedCostUsd,
        model,
        provider: "gemini",
        durationMs,
        isUsageEstimated,
      };
    } catch (error) {
      if (error instanceof AIProviderError) {
        throw error;
      }
      throw this.normalizeError(error, model);
    }
  }

  async testConnection(): Promise<AIConnectionTestResult> {
    const t0 = Date.now();
    try {
      const res = await this.client.models.generateContent({
        model: this.defaultModel,
        contents: "Respond with: OK",
        config: {
          maxOutputTokens: 10,
          temperature: 0,
        },
      });

      const latencyMs = Date.now() - t0;
      const responseText = typeof (res as any)?.text === "function" ? (res as any).text() : (res as any)?.text;
      if (responseText && typeof responseText === "string" && responseText.trim()) {
        return {
          success: true,
          provider: "gemini",
          model: this.defaultModel,
          latencyMs,
        };
      }
      return {
        success: false,
        provider: "gemini",
        model: this.defaultModel,
        latencyMs,
        error: "Empty test response from Gemini",
      };
    } catch (err) {
      const latencyMs = Date.now() - t0;
      const normalized = this.normalizeError(err, this.defaultModel);
      return {
        success: false,
        provider: "gemini",
        model: this.defaultModel,
        latencyMs,
        error: normalized.message,
      };
    }
  }

  private redactSecrets(text: string): string {
    if (!text) return "";
    let sanitized = text;
    if (this.apiKey) {
      sanitized = sanitized.split(this.apiKey).join("[hidden]");
    }
    for (const secret of [
      process.env.GEMINI_API_KEY,
      env.GEMINI_API_KEY,
      env.PLATFORM_API_KEY,
      env.STOCKFLOW_TEST_PASSWORD,
    ]) {
      if (secret) {
        sanitized = sanitized.split(secret).join("[hidden]");
      }
    }
    return sanitized;
  }

  private normalizeError(error: unknown, model: string): AIProviderError {
    const rawMessage = this.redactSecrets(error instanceof Error ? error.message : String(error));
    const sanitizedOriginal =
      error instanceof Error
        ? { name: error.name, message: this.redactSecrets(error.message) }
        : { message: this.redactSecrets(String(error)) };
    const lower = rawMessage.toLowerCase();

    // Invalid credentials / auth errors
    if (
      lower.includes("api_key_invalid") ||
      lower.includes("api key not valid") ||
      lower.includes("unauthenticated") ||
      lower.includes("permission_denied") ||
      lower.includes("permissiondenied") ||
      lower.includes("401") ||
      lower.includes("403")
    ) {
      return new AIProviderError({
        message: "Gemini authentication failed: invalid or unauthorized API key",
        code: "INVALID_CREDENTIALS",
        provider: "gemini",
        statusCode: 401,
        retryable: false,
        originalError: sanitizedOriginal,
      });
    }

    // Rate limits
    if (
      lower.includes("429") ||
      lower.includes("resource_exhausted") ||
      lower.includes("resource exhausted") ||
      lower.includes("rate limit") ||
      lower.includes("quota exceeded")
    ) {
      return new AIProviderError({
        message: "Gemini rate limit exceeded or quota exhausted",
        code: "RATE_LIMIT_EXCEEDED",
        provider: "gemini",
        statusCode: 429,
        retryable: true,
        originalError: sanitizedOriginal,
      });
    }

    // Model unavailable
    if (lower.includes("not found") || lower.includes("model not supported") || lower.includes("unrecognized model")) {
      return new AIProviderError({
        message: `Gemini model ${model} is unavailable or not found`,
        code: "MODEL_UNAVAILABLE",
        provider: "gemini",
        statusCode: 404,
        retryable: false,
        originalError: sanitizedOriginal,
      });
    }

    // Service unavailable / 503 / 500
    if (lower.includes("503") || lower.includes("500") || lower.includes("service unavailable") || lower.includes("overloaded")) {
      return new AIProviderError({
        message: "Gemini service is temporarily unavailable",
        code: "PROVIDER_UNAVAILABLE",
        provider: "gemini",
        statusCode: 503,
        retryable: true,
        originalError: sanitizedOriginal,
      });
    }

    return new AIProviderError({
      message: `Gemini error: ${rawMessage}`,
      code: "UNKNOWN_ERROR",
      provider: "gemini",
      retryable: false,
      originalError: sanitizedOriginal,
    });
  }
}
