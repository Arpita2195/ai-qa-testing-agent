import Groq from "groq-sdk";
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

export class GroqProvider implements AIProvider {
  public readonly providerType: AIProviderType = "groq";
  public readonly defaultModel: string;
  private readonly client: Groq;
  private readonly timeoutMs: number;
  private readonly apiKey: string;

  constructor(config: AIProviderConfig = {}, client?: Groq) {
    const apiKey =
      config.apiKey !== undefined
        ? config.apiKey
        : process.env.GROQ_API_KEY || env.GROQ_API_KEY || "";

    if (!client && !apiKey) {
      throw new AIProviderError({
        message: "Groq API key is not configured",
        code: "CONFIGURATION_ERROR",
        provider: "groq",
      });
    }

    this.apiKey = apiKey;
    this.defaultModel =
      config.model || process.env.GROQ_MODEL || "openai/gpt-oss-120b";
    this.timeoutMs = config.timeoutMs || 60000;
    this.client =
      client ??
      new Groq({
        apiKey: apiKey || "dummy-key",
        timeout: this.timeoutMs,
      });
  }

  async generateText(options: AIGenerateOptions): Promise<AIGenerateResult> {
    const model = options.model || this.defaultModel;
    const maxOutputTokens = options.maxOutputTokens ?? 4096;
    const temperature = options.temperature ?? 0.2;
    const t0 = Date.now();

    try {
      const messages: Groq.Chat.ChatCompletionMessageParam[] = [];

      let promptText = options.prompt;
      let systemInstruction = options.systemInstruction;

      // Groq requires the word 'json' in messages when response_format is json_object
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

      const requestPayload: Parameters<Groq["chat"]["completions"]["create"]>[0] = {
        model,
        messages,
        temperature,
        max_tokens: maxOutputTokens,
      };

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
                message: `Groq request timed out after ${options.timeoutMs || this.timeoutMs}ms`,
                code: "TIMEOUT",
                provider: "groq",
                retryable: true,
              }),
            ),
          options.timeoutMs || this.timeoutMs,
        );
      });

      const responsePromise = this.client.chat.completions.create(requestPayload);

      let response: Groq.Chat.ChatCompletion;
      try {
        response = (await Promise.race([responsePromise, timeoutPromise])) as Groq.Chat.ChatCompletion;
      } finally {
        if (timer) clearTimeout(timer);
      }

      const durationMs = Date.now() - t0;
      const choice = response.choices?.[0];
      const rawText = choice?.message?.content;

      if (!rawText || typeof rawText !== "string" || !rawText.trim()) {
        throw new AIProviderError({
          message: "Groq returned an empty response",
          code: "INVALID_RESPONSE",
          provider: "groq",
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

      // Extract token usage
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
      const estimatedCostUsd = calculateEstimatedCostUsd(model, promptTokens, completionTokens, "groq");

      return {
        text,
        promptTokens,
        completionTokens,
        totalTokens,
        estimatedCostUsd,
        model,
        provider: "groq",
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
        max_tokens: 250,
        temperature: 0,
      });

      const latencyMs = Date.now() - t0;
      const text = res.choices?.[0]?.message?.content;
      if (text && text.trim()) {
        return {
          success: true,
          provider: "groq",
          model: this.defaultModel,
          latencyMs,
        };
      }
      return {
        success: false,
        provider: "groq",
        model: this.defaultModel,
        latencyMs,
        error: "Empty test response from Groq",
      };
    } catch (err) {
      const latencyMs = Date.now() - t0;
      const normalized = this.normalizeError(err, this.defaultModel);
      return {
        success: false,
        provider: "groq",
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
      process.env.GROQ_API_KEY,
      env.GROQ_API_KEY,
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
      lower.includes("invalid api key") ||
      lower.includes("unauthorized") ||
      lower.includes("401")
    ) {
      return new AIProviderError({
        message: "Groq authentication failed: invalid or unauthorized API key",
        code: "INVALID_CREDENTIALS",
        provider: "groq",
        statusCode: 401,
        retryable: false,
        originalError: sanitizedOriginal,
      });
    }

    // Rate limits / quota
    if (
      lower.includes("429") ||
      lower.includes("rate_limit_exceeded") ||
      lower.includes("rate limit") ||
      lower.includes("quota exceeded")
    ) {
      return new AIProviderError({
        message: "Groq rate limit exceeded or quota exhausted",
        code: "RATE_LIMIT_EXCEEDED",
        provider: "groq",
        statusCode: 429,
        retryable: true,
        originalError: sanitizedOriginal,
      });
    }

    // Model unavailable
    if (
      lower.includes("model_not_found") ||
      lower.includes("does not exist") ||
      lower.includes("not found") ||
      lower.includes("404")
    ) {
      return new AIProviderError({
        message: `Groq model ${model} is unavailable or does not exist`,
        code: "MODEL_UNAVAILABLE",
        provider: "groq",
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
        message: "Groq service is temporarily unavailable",
        code: "PROVIDER_UNAVAILABLE",
        provider: "groq",
        statusCode: 503,
        retryable: true,
        originalError: sanitizedOriginal,
      });
    }

    // Timeout
    if (lower.includes("timeout") || lower.includes("etimedout")) {
      return new AIProviderError({
        message: "Groq request timed out",
        code: "TIMEOUT",
        provider: "groq",
        statusCode: 408,
        retryable: true,
        originalError: sanitizedOriginal,
      });
    }

    return new AIProviderError({
      message: `Groq error: ${rawMessage}`,
      code: "UNKNOWN_ERROR",
      provider: "groq",
      retryable: false,
      originalError: sanitizedOriginal,
    });
  }
}
