import { describe, it, expect, vi, beforeEach } from "vitest";
import OpenAI from "openai";
import { OpenAIProvider } from "../services/ai/openaiProvider";
import { getAIProvider } from "../services/ai/providerFactory";
import { AIProviderError } from "../services/ai/types";

// Mock state for OpenAI SDK
const mockOpenAI = vi.hoisted(() => ({
  createCall: null as any,
  responsePayload: {
    id: "chatcmpl-test-123",
    object: "chat.completion",
    created: 123456789,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: '{"result": "openai_success"}',
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 35,
      completion_tokens: 15,
      total_tokens: 50,
    },
  } as any,
  errorToThrow: null as Error | null,
  delayMs: 0,
}));

vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: async (params: any) => {
            mockOpenAI.createCall = params;
            if (mockOpenAI.delayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, mockOpenAI.delayMs));
            }
            if (mockOpenAI.errorToThrow) {
              throw mockOpenAI.errorToThrow;
            }
            return mockOpenAI.responsePayload;
          },
        },
      };
      constructor(_options: any) {}
    },
  };
});

describe("Stage 3B: OpenAIProvider", () => {
  beforeEach(() => {
    mockOpenAI.createCall = null;
    mockOpenAI.errorToThrow = null;
    mockOpenAI.delayMs = 0;
    mockOpenAI.responsePayload = {
      id: "chatcmpl-test-123",
      object: "chat.completion",
      created: 123456789,
      model: "gpt-4o-mini",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: '{"result": "openai_success"}',
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 35,
        completion_tokens: 15,
        total_tokens: 50,
      },
    };
  });

  describe("Initialization & Factory Registration", () => {
    it("instantiates successfully with configured API key", () => {
      const provider = new OpenAIProvider({ apiKey: "sk-proj-testkey123" });
      expect(provider.providerType).toBe("openai");
      expect(provider.defaultModel).toBe("gpt-4o-mini");
    });

    it("throws CONFIGURATION_ERROR if no API key is provided and client is missing", () => {
      const originalEnv = process.env.OPENAI_API_KEY;
      try {
        delete process.env.OPENAI_API_KEY;
        expect(() => new OpenAIProvider({ apiKey: "" })).toThrowError(AIProviderError);
        expect(() => new OpenAIProvider({ apiKey: "" })).toThrow(/API key is not configured/);
      } finally {
        process.env.OPENAI_API_KEY = originalEnv;
      }
    });

    it("resolves via getAIProvider factory", () => {
      const provider = getAIProvider("openai", { apiKey: "sk-test" });
      expect(provider).toBeInstanceOf(OpenAIProvider);
      expect(provider.providerType).toBe("openai");
    });
  });

  describe("Text Generation & Token Tracking", () => {
    it("generates text with system instructions, temperature, and JSON format", async () => {
      const provider = new OpenAIProvider({ apiKey: "sk-test", model: "gpt-4o" });
      const result = await provider.generateText({
        prompt: "Generate 2 positive test cases",
        systemInstruction: "You are a QA automation specialist",
        temperature: 0.1,
        maxOutputTokens: 1024,
        responseFormat: "json",
      });

      expect(mockOpenAI.createCall).toMatchObject({
        model: "gpt-4o",
        temperature: 0.1,
        max_tokens: 1024,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You are a QA automation specialist" },
          { role: "user", content: expect.stringContaining("Generate 2 positive test cases") },
        ],
      });

      expect(result.text).toBe('{"result": "openai_success"}');
      expect(result.promptTokens).toBe(35);
      expect(result.completionTokens).toBe(15);
      expect(result.totalTokens).toBe(50);
      expect(result.isUsageEstimated).toBe(false);
      expect(result.provider).toBe("openai");
      expect(result.model).toBe("gpt-4o");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.estimatedCostUsd).toBeGreaterThanOrEqual(0);
    });

    it("adapts parameters for OpenAI reasoning models (o1/o3)", async () => {
      const provider = new OpenAIProvider({ apiKey: "sk-test", model: "o1-mini" });
      await provider.generateText({
        prompt: "Analyze test requirements in json format",
        maxOutputTokens: 2048,
        temperature: 0.5,
      });

      expect(mockOpenAI.createCall.max_completion_tokens).toBe(2048);
      expect(mockOpenAI.createCall.max_tokens).toBeUndefined();
      expect(mockOpenAI.createCall.temperature).toBeUndefined(); // Omitted for reasoning models
    });

    it("ensures word 'json' is present when json responseFormat is requested", async () => {
      const provider = new OpenAIProvider({ apiKey: "sk-test" });
      await provider.generateText({
        prompt: "Produce test results without mentioning the format",
        responseFormat: "json",
      });

      const userMsg = mockOpenAI.createCall.messages.find((m: any) => m.role === "user");
      expect(userMsg.content.toLowerCase()).toContain("json");
    });

    it("truncates stop sequences to at most 4 items for OpenAI compatibility", async () => {
      const provider = new OpenAIProvider({ apiKey: "sk-test" });
      await provider.generateText({
        prompt: "Test stop sequences",
        stopSequences: ["STOP1", "STOP2", "STOP3", "STOP4", "STOP5", "STOP6"],
      });

      expect(mockOpenAI.createCall.stop).toEqual(["STOP1", "STOP2", "STOP3", "STOP4"]);
    });

    it("falls back to token estimation when usage metadata is missing", async () => {
      mockOpenAI.responsePayload = {
        choices: [
          {
            message: {
              content: '{"cases": ["login check", "cart check"]}',
            },
          },
        ],
      };

      const provider = new OpenAIProvider({ apiKey: "sk-test" });
      const prompt = "Short QA prompt";
      const result = await provider.generateText({ prompt });

      expect(result.isUsageEstimated).toBe(true);
      expect(result.promptTokens).toBe(Math.ceil(prompt.length / 4));
      expect(result.completionTokens).toBe(Math.ceil('{"cases": ["login check", "cart check"]}'.length / 4));
      expect(result.totalTokens).toBe(result.promptTokens + result.completionTokens);
    });

    it("strips markdown code fences when responseFormat is json", async () => {
      mockOpenAI.responsePayload = {
        choices: [
          {
            message: {
              content: '```json\n{"status": "valid"}\n```',
            },
          },
        ],
      };

      const provider = new OpenAIProvider({ apiKey: "sk-test" });
      const result = await provider.generateText({
        prompt: "JSON test",
        responseFormat: "json",
      });

      expect(result.text).toBe('{"status": "valid"}');
    });

    it("throws INVALID_RESPONSE when response choices or text is empty", async () => {
      mockOpenAI.responsePayload = {
        choices: [{ message: { content: "   " } }],
      };

      const provider = new OpenAIProvider({ apiKey: "sk-test" });
      await expect(provider.generateText({ prompt: "empty" })).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
        retryable: true,
      });
    });
  });

  describe("Timeout Handling", () => {
    it("aborts and throws TIMEOUT error when request exceeds timeoutMs", async () => {
      mockOpenAI.delayMs = 150;

      const provider = new OpenAIProvider({ apiKey: "sk-test", timeoutMs: 50 });
      const errPromise = provider.generateText({ prompt: "Slow request", timeoutMs: 50 });

      await expect(errPromise).rejects.toMatchObject({
        code: "TIMEOUT",
        retryable: true,
        provider: "openai",
      });
    });
  });

  describe("Error Normalization & Redaction", () => {
    it("normalizes invalid API key errors to INVALID_CREDENTIALS and redacts the secret", async () => {
      const secret = "sk-proj-secret-12345678";
      mockOpenAI.errorToThrow = new Error(`Incorrect API key provided: ${secret}. You can find your API key at https://platform.openai.com/account/api-keys.`);

      const provider = new OpenAIProvider({ apiKey: secret });
      let caughtError: any;
      try {
        await provider.generateText({ prompt: "test" });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(AIProviderError);
      expect(caughtError.code).toBe("INVALID_CREDENTIALS");
      expect(caughtError.retryable).toBe(false);
      expect(caughtError.statusCode).toBe(401);
      expect(caughtError.message).not.toContain(secret);
      expect(caughtError.message).toContain("OpenAI authentication failed");
    });

    it("normalizes 429 rate limit and insufficient quota to RATE_LIMIT_EXCEEDED (retryable)", async () => {
      mockOpenAI.errorToThrow = new Error("429 Rate limit reached for requests. insufficient_quota");

      const provider = new OpenAIProvider({ apiKey: "sk-test" });
      await expect(provider.generateText({ prompt: "test" })).rejects.toMatchObject({
        code: "RATE_LIMIT_EXCEEDED",
        retryable: true,
        statusCode: 429,
      });
    });

    it("normalizes model not found to MODEL_UNAVAILABLE (non-retryable)", async () => {
      mockOpenAI.errorToThrow = new Error("The model 'gpt-unknown' does not exist or you do not have access to it.");

      const provider = new OpenAIProvider({ apiKey: "sk-test" });
      await expect(provider.generateText({ prompt: "test", model: "gpt-unknown" })).rejects.toMatchObject({
        code: "MODEL_UNAVAILABLE",
        retryable: false,
        statusCode: 404,
      });
    });

    it("normalizes 503 / 500 service errors to PROVIDER_UNAVAILABLE (retryable)", async () => {
      mockOpenAI.errorToThrow = new Error("503 Service Unavailable: server is overloaded");

      const provider = new OpenAIProvider({ apiKey: "sk-test" });
      await expect(provider.generateText({ prompt: "test" })).rejects.toMatchObject({
        code: "PROVIDER_UNAVAILABLE",
        retryable: true,
        statusCode: 503,
      });
    });
  });

  describe("Connection Testing (testConnection)", () => {
    it("returns success: true when test completion succeeds", async () => {
      mockOpenAI.responsePayload = {
        choices: [{ message: { content: "OK" } }],
      };

      const provider = new OpenAIProvider({ apiKey: "sk-test" });
      const testRes = await provider.testConnection();

      expect(testRes.success).toBe(true);
      expect(testRes.provider).toBe("openai");
      expect(testRes.latencyMs).toBeGreaterThanOrEqual(0);
      expect(testRes.error).toBeUndefined();
    });

    it("returns success: false with normalized error when test completion fails", async () => {
      mockOpenAI.errorToThrow = new Error("401 invalid_api_key");

      const provider = new OpenAIProvider({ apiKey: "sk-test" });
      const testRes = await provider.testConnection();

      expect(testRes.success).toBe(false);
      expect(testRes.provider).toBe("openai");
      expect(testRes.error).toContain("OpenAI authentication failed");
    });
  });
});
