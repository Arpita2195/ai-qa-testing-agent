import { describe, it, expect, vi, beforeEach } from "vitest";
import { GeminiProvider } from "../services/ai/geminiProvider";
import {
  getAIProvider,
  getAIProviderForProject,
  isRetryableAIError,
  registerAIProvider,
} from "../services/ai/providerFactory";
import { AIProviderError } from "../services/ai/types";
import { callGemini, isRetryableGeminiError } from "../services/generator";

// Hoist mock state for @google/genai
const mockedGenAI = vi.hoisted(() => ({
  lastPrompt: "",
  lastConfig: null as any,
  responsePayload: {
    text: '{"result": "success"}',
    usageMetadata: {
      promptTokenCount: 42,
      candidatesTokenCount: 18,
    },
  } as any,
  errorToThrow: null as Error | null,
  delayMs: 0,
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async ({ contents, config }: { contents: string; config: any }) => {
        mockedGenAI.lastPrompt = contents;
        mockedGenAI.lastConfig = config;

        if (mockedGenAI.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, mockedGenAI.delayMs));
        }

        if (mockedGenAI.errorToThrow) {
          throw mockedGenAI.errorToThrow;
        }

        return mockedGenAI.responsePayload;
      },
    };
    constructor(_options: { apiKey: string }) {}
  },
}));

describe("Stage 3A: GeminiProvider & AI Provider Architecture", () => {
  beforeEach(() => {
    mockedGenAI.lastPrompt = "";
    mockedGenAI.lastConfig = null;
    mockedGenAI.errorToThrow = null;
    mockedGenAI.delayMs = 0;
    mockedGenAI.responsePayload = {
      text: '{"result": "success"}',
      usageMetadata: {
        promptTokenCount: 42,
        candidatesTokenCount: 18,
      },
    };
  });

  describe("GeminiProvider Initialization & Factory", () => {
    it("instantiates successfully with configured API key or env key", () => {
      const provider = new GeminiProvider({ apiKey: "test-gemini-key" });
      expect(provider.providerType).toBe("gemini");
      expect(provider.defaultModel).toBeDefined();
    });

    it("throws CONFIGURATION_ERROR if no API key is provided and client is missing", () => {
      const originalEnv = process.env.GEMINI_API_KEY;
      try {
        delete process.env.GEMINI_API_KEY;
        expect(() => new GeminiProvider({ apiKey: "" })).toThrowError(AIProviderError);
        expect(() => new GeminiProvider({ apiKey: "" })).toThrow(/API key is not configured/);
      } finally {
        process.env.GEMINI_API_KEY = originalEnv;
      }
    });

    it("resolves via getAIProvider factory", () => {
      const provider = getAIProvider("gemini", { apiKey: "test-key" });
      expect(provider).toBeInstanceOf(GeminiProvider);
      expect(provider.providerType).toBe("gemini");
    });

    it("throws CONFIGURATION_ERROR when requesting unsupported provider in factory", () => {
      expect(() => getAIProvider("unknown" as any)).toThrowError(AIProviderError);
      expect(() => getAIProvider("unknown" as any)).toThrow(/Unsupported AI provider type/);
    });

    it("resolves Gemini as default provider for projects in Stage 3A", async () => {
      const provider = await getAIProviderForProject("proj-123", { apiKey: "test-key" });
      expect(provider).toBeInstanceOf(GeminiProvider);
      expect(provider.providerType).toBe("gemini");
    });
  });

  describe("Text Generation & Token Tracking", () => {
    it("generates text with correct parameters and usage metadata", async () => {
      const provider = new GeminiProvider({ apiKey: "test-key", model: "gemini-2.5-flash" });
      const result = await provider.generateText({
        prompt: "Generate a test case",
        systemInstruction: "You are an expert QA tester",
        temperature: 0.1,
        maxOutputTokens: 2048,
        responseFormat: "json",
      });

      expect(mockedGenAI.lastPrompt).toBe("Generate a test case");
      expect(mockedGenAI.lastConfig).toMatchObject({
        maxOutputTokens: 2048,
        temperature: 0.1,
        responseMimeType: "application/json",
        systemInstruction: "You are an expert QA tester",
      });

      expect(result.text).toBe('{"result": "success"}');
      expect(result.promptTokens).toBe(42);
      expect(result.completionTokens).toBe(18);
      expect(result.totalTokens).toBe(60);
      expect(result.isUsageEstimated).toBe(false);
      expect(result.provider).toBe("gemini");
      expect(result.model).toBe("gemini-2.5-flash");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.estimatedCostUsd).toBeGreaterThanOrEqual(0);
    });

    it("falls back to token estimation when usageMetadata is missing", async () => {
      mockedGenAI.responsePayload = {
        text: '{"cases": ["test 1", "test 2"]}',
      };

      const provider = new GeminiProvider({ apiKey: "test-key" });
      const prompt = "Short prompt";
      const result = await provider.generateText({ prompt });

      expect(result.isUsageEstimated).toBe(true);
      expect(result.promptTokens).toBe(Math.ceil(prompt.length / 4));
      expect(result.completionTokens).toBe(Math.ceil('{"cases": ["test 1", "test 2"]}'.length / 4));
      expect(result.totalTokens).toBe(result.promptTokens + result.completionTokens);
    });

    it("strips markdown code fences when responseFormat is json", async () => {
      mockedGenAI.responsePayload = {
        text: '```json\n{"status": "ok"}\n```',
      };

      const provider = new GeminiProvider({ apiKey: "test-key" });
      const result = await provider.generateText({
        prompt: "Return json",
        responseFormat: "json",
      });

      expect(result.text).toBe('{"status": "ok"}');
    });

    it("handles response.text as a function (SDK variations)", async () => {
      mockedGenAI.responsePayload = {
        text: () => '{"invoked": true}',
      };

      const provider = new GeminiProvider({ apiKey: "test-key" });
      const result = await provider.generateText({ prompt: "Test function text" });

      expect(result.text).toBe('{"invoked": true}');
    });

    it("throws INVALID_RESPONSE when response text is empty or whitespace", async () => {
      mockedGenAI.responsePayload = { text: "   " };

      const provider = new GeminiProvider({ apiKey: "test-key" });
      await expect(provider.generateText({ prompt: "empty prompt" })).rejects.toThrow(
        /Gemini returned an empty response/,
      );
    });
  });

  describe("Timeout Handling", () => {
    it("aborts and throws TIMEOUT error when execution exceeds timeoutMs", async () => {
      mockedGenAI.delayMs = 150;

      const provider = new GeminiProvider({ apiKey: "test-key", timeoutMs: 50 });
      const errPromise = provider.generateText({ prompt: "Slow request", timeoutMs: 50 });

      await expect(errPromise).rejects.toThrow(AIProviderError);
      await expect(errPromise).rejects.toMatchObject({
        code: "TIMEOUT",
        retryable: true,
        provider: "gemini",
      });
    });
  });

  describe("Error Normalization & Retries", () => {
    it("normalizes invalid API key errors to INVALID_CREDENTIALS (non-retryable)", async () => {
      mockedGenAI.errorToThrow = new Error("API_KEY_INVALID: The provided API key is expired or invalid.");

      const provider = new GeminiProvider({ apiKey: "test-key" });
      await expect(provider.generateText({ prompt: "test" })).rejects.toMatchObject({
        code: "INVALID_CREDENTIALS",
        retryable: false,
        statusCode: 401,
      });
    });

    it("normalizes 429 quota exhaustion to RATE_LIMIT_EXCEEDED (retryable)", async () => {
      mockedGenAI.errorToThrow = new Error("RESOURCE_EXHAUSTED: Rate limit exceeded (429).");

      const provider = new GeminiProvider({ apiKey: "test-key" });
      await expect(provider.generateText({ prompt: "test" })).rejects.toMatchObject({
        code: "RATE_LIMIT_EXCEEDED",
        retryable: true,
        statusCode: 429,
      });
    });

    it("normalizes model not found errors to MODEL_UNAVAILABLE (non-retryable)", async () => {
      mockedGenAI.errorToThrow = new Error("Model not found: gemini-unknown");

      const provider = new GeminiProvider({ apiKey: "test-key" });
      await expect(provider.generateText({ prompt: "test" })).rejects.toMatchObject({
        code: "MODEL_UNAVAILABLE",
        retryable: false,
        statusCode: 404,
      });
    });

    it("normalizes 503 service unavailable to PROVIDER_UNAVAILABLE (retryable)", async () => {
      mockedGenAI.errorToThrow = new Error("503 Service Unavailable: server is temporarily overloaded.");

      const provider = new GeminiProvider({ apiKey: "test-key" });
      await expect(provider.generateText({ prompt: "test" })).rejects.toMatchObject({
        code: "PROVIDER_UNAVAILABLE",
        retryable: true,
        statusCode: 503,
      });
    });

    it("evaluates retryable status accurately with isRetryableAIError", () => {
      const retryableAiError = new AIProviderError({
        message: "rate limit",
        code: "RATE_LIMIT_EXCEEDED",
        provider: "gemini",
        retryable: true,
      });
      const nonRetryableAiError = new AIProviderError({
        message: "bad key",
        code: "INVALID_CREDENTIALS",
        provider: "gemini",
        retryable: false,
      });
      const generic503 = new Error("503 Service Unavailable");
      const generic401 = new Error("401 Unauthorized");

      expect(isRetryableAIError(retryableAiError)).toBe(true);
      expect(isRetryableAIError(nonRetryableAiError)).toBe(false);
      expect(isRetryableAIError(generic503)).toBe(true);
      expect(isRetryableAIError(generic401)).toBe(false);
    });
  });

  describe("Health Check / Connection Testing (testConnection)", () => {
    it("returns success: true when test prompt succeeds", async () => {
      mockedGenAI.responsePayload = { text: "OK" };

      const provider = new GeminiProvider({ apiKey: "test-key" });
      const testRes = await provider.testConnection();

      expect(testRes.success).toBe(true);
      expect(testRes.provider).toBe("gemini");
      expect(testRes.latencyMs).toBeGreaterThanOrEqual(0);
      expect(testRes.error).toBeUndefined();
    });

    it("returns success: false with normalized error when test prompt fails", async () => {
      mockedGenAI.errorToThrow = new Error("API_KEY_INVALID: key has been revoked");

      const provider = new GeminiProvider({ apiKey: "test-key" });
      const testRes = await provider.testConnection();

      expect(testRes.success).toBe(false);
      expect(testRes.provider).toBe("gemini");
      expect(testRes.error).toContain("Gemini authentication failed");
    });
  });

  describe("Backward Compatibility (callGemini & isRetryableGeminiError)", () => {
    it("callGemini delegates to GeminiProvider and returns JSON text", async () => {
      mockedGenAI.responsePayload = {
        text: '{"hello": "world"}',
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      };

      const result = await callGemini("Say hello");
      expect(result).toBe('{"hello": "world"}');
    });

    it("isRetryableGeminiError delegates to isRetryableAIError", () => {
      expect(isRetryableGeminiError(new Error("Resource_exhausted"))).toBe(true);
      expect(isRetryableGeminiError(new Error("429 Too Many Requests"))).toBe(true);
      expect(isRetryableGeminiError(new Error("Invalid API key"))).toBe(false);
    });
  });
});

