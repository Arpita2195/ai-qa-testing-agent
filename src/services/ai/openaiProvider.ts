import OpenAI from "openai";
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

export class OpenAIProvider implements AIProvider {
  public readonly providerType: AIProviderType = "openai";
  public readonly defaultModel: string;
  private readonly client: OpenAI;
  private readonly timeoutMs: number;
  private readonly apiKey: string;

  constructor(config: AIProviderConfig = {}, client?: OpenAI) {
    const apiKey =
      config.apiKey !== undefined
        ? config.apiKey
        : process.env.OPENAI_API_KEY || env.OPENAI_API_KEY || "";
    if (!client && !apiKey) {
      throw new AIProviderError({
        message: "OpenAI API key is not configured",
        code: "CONFIGURATION_ERROR",
        provider: "openai",
      });
    }

    this.apiKey = apiKey;
    this.defaultModel = config.model || process.env.OPENAI_MODEL || "gpt-4o-mini";
    this.timeoutMs = config.timeoutMs || 60000;
    this.client =
      client ??
      new OpenAI({
        apiKey: apiKey || "dummy-key",
        baseURL: config.baseUrl,
        timeout: this.timeoutMs,
      });
  }

  async generateText(options: AIGenerateOptions): Promise<AIGenerateResult> {
    const model = options.model || this.defaultModel;
    const maxOutputTokens = options.maxOutputTokens ?? 4096;
    const temperature = options.temperature ?? 0.2;
    const t0 = Date.now();

    try {
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
      const isReasoningModel = model.startsWith("o1") || model.startsWith("o3");

      let promptText = options.prompt;
      let systemInstruction = options.systemInstruction;

      // OpenAI JSON mode requires the word 'json' in messages to prevent 400 Bad Request
      if (options.responseFormat === "json") {
        const fullContent = `${systemInstruction || ""} ${promptText}`.toLowerCase();
        if (!fullContent.includes("json")) {
          promptText = `${promptText}\n\nNote: Return response in valid JSON format.`;
        }
      }

      if (systemInstruction) {
        messages.push({
          role: "system",
          content: systemInstruction,
        });
      }

      messages.push({
        role: "user",
        content: promptText,
      });

      const requestPayload: any = {
        model,
        messages,
      };

      if (isReasoningModel) {
        requestPayload.max_completion_tokens = maxOutputTokens;
        // Reasoning models do not support custom temperature
      } else {
        requestPayload.max_tokens = maxOutputTokens;
        requestPayload.temperature = temperature;
      }

      if (options.responseFormat === "json") {
        requestPayload.response_format = { type: "json_object" };
      }

      if (options.stopSequences && options.stopSequences.length > 0) {
        requestPayload.stop = options.stopSequences.slice(0, 4);
      }

      // Execute with timeout race and cleanup
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AIProviderError({
                message: `OpenAI request timed out after ${options.timeoutMs || this.timeoutMs}ms`,
                code: "TIMEOUT",
                provider: "openai",
                retryable: true,
              }),
            ),
          options.timeoutMs || this.timeoutMs,
        );
      });

      const responsePromise = this.client.chat.completions.create(requestPayload);

      let response: OpenAI.Chat.ChatCompletion;
      try {
        response = await Promise.race([responsePromise, timeoutPromise]);
      } finally {
        if (timer) clearTimeout(timer);
      }

      const durationMs = Date.now() - t0;
      const choice = response.choices?.[0];
      const rawText = choice?.message?.content;

      if (!rawText || typeof rawText !== "string" || !rawText.trim()) {
        throw new AIProviderError({
          message: "OpenAI returned an empty response",
          code: "INVALID_RESPONSE",
          provider: "openai",
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

      // Extract usage metadata if available
      let promptTokens: number;
      let completionTokens: number;
      let isUsageEstimated = false;

      if (response.usage && typeof response.usage.prompt_tokens === "number") {
        promptTokens = response.usage.prompt_tokens;
        completionTokens = response.usage.completion_tokens ?? Math.ceil(text.length / 4);
      } else {
        promptTokens = Math.ceil((options.prompt.length + (options.systemInstruction?.length || 0)) / 4);
        completionTokens = Math.ceil(text.length / 4);
        isUsageEstimated = true;
      }

      const totalTokens = promptTokens + completionTokens;
      const estimatedCostUsd = calculateEstimatedCostUsd(model, promptTokens, completionTokens, "openai");

      return {
        text,
        promptTokens,
        completionTokens,
        totalTokens,
        estimatedCostUsd,
        model,
        provider: "openai",
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
      const res = await this.client.chat.completions.create({
        model: this.defaultModel,
        messages: [{ role: "user", content: "Respond with: OK" }],
        max_tokens: 10,
        temperature: 0,
      });

      const latencyMs = Date.now() - t0;
      const text = res.choices?.[0]?.message?.content;
      if (text && text.trim()) {
        return {
          success: true,
          provider: "openai",
          model: this.defaultModel,
          latencyMs,
        };
      }
      return {
        success: false,
        provider: "openai",
        model: this.defaultModel,
        latencyMs,
        error: "Empty test response from OpenAI",
      };
    } catch (err) {
      const latencyMs = Date.now() - t0;
      const normalized = this.normalizeError(err, this.defaultModel);
      return {
        success: false,
        provider: "openai",
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
      process.env.OPENAI_API_KEY,
      env.OPENAI_API_KEY,
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

    // Authentication / Invalid API key
    if (
      lower.includes("invalid_api_key") ||
      lower.includes("incorrect api key") ||
      lower.includes("invalid api key") ||
      lower.includes("unauthorized") ||
      lower.includes("401")
    ) {
      return new AIProviderError({
        message: "OpenAI authentication failed: invalid or unauthorized API key",
        code: "INVALID_CREDENTIALS",
        provider: "openai",
        statusCode: 401,
        retryable: false,
        originalError: sanitizedOriginal,
      });
    }

    // Rate limits / quota / billing
    if (
      lower.includes("429") ||
      lower.includes("rate_limit_exceeded") ||
      lower.includes("rate limit") ||
      lower.includes("insufficient_quota") ||
      lower.includes("quota exceeded") ||
      lower.includes("billing")
    ) {
      return new AIProviderError({
        message: "OpenAI rate limit exceeded or quota exhausted",
        code: "RATE_LIMIT_EXCEEDED",
        provider: "openai",
        statusCode: 429,
        retryable: true,
        originalError: sanitizedOriginal,
      });
    }

    // Model unavailable / not found
    if (
      lower.includes("model_not_found") ||
      lower.includes("does not exist") ||
      lower.includes("not found") ||
      lower.includes("404")
    ) {
      return new AIProviderError({
        message: `OpenAI model ${model} is unavailable or does not exist`,
        code: "MODEL_UNAVAILABLE",
        provider: "openai",
        statusCode: 404,
        retryable: false,
        originalError: sanitizedOriginal,
      });
    }

    // Service unavailable / 500 / 503
    if (
      lower.includes("500") ||
      lower.includes("503") ||
      lower.includes("service unavailable") ||
      lower.includes("server error") ||
      lower.includes("overloaded")
    ) {
      return new AIProviderError({
        message: "OpenAI service is temporarily unavailable",
        code: "PROVIDER_UNAVAILABLE",
        provider: "openai",
        statusCode: 503,
        retryable: true,
        originalError: sanitizedOriginal,
      });
    }

    // Timeout
    if (lower.includes("timeout") || lower.includes("etimedout")) {
      return new AIProviderError({
        message: "OpenAI request timed out",
        code: "TIMEOUT",
        provider: "openai",
        statusCode: 408,
        retryable: true,
        originalError: sanitizedOriginal,
      });
    }

    return new AIProviderError({
      message: `OpenAI error: ${rawMessage}`,
      code: "UNKNOWN_ERROR",
      provider: "openai",
      retryable: false,
      originalError: sanitizedOriginal,
    });
  }
}
