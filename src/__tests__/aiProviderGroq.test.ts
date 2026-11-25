import { describe, it, expect, vi, beforeEach } from "vitest";
import Groq from "groq-sdk";
import { GroqProvider } from "../services/ai/groqProvider";
import { getAIProvider } from "../services/ai/providerFactory";
import { AIProviderError } from "../services/ai/types";

// Mock state for Groq SDK
const mockGroq = vi.hoisted(() => ({
  createCall: null as any,
  responsePayload: {
    id: "chatcmpl-groq-123",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: '{"result": "groq_success"}',
        },
      },
    ],
    usage: {
      prompt_tokens: 45,
      completion_tokens: 18,
      total_tokens: 63,
    },
  } as any,
  errorToThrow: null as Error | null,
  delayMs: 0,
}));

vi.mock("groq-sdk", () => {
  return {
    default: class MockGroq {
      chat = {
        completions: {
          create: async (params: any) => {
            mockGroq.createCall = params;
            if (mockGroq.delayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, mockGroq.delayMs));
            }
            if (mockGroq.errorToThrow) {
              throw mockGroq.errorToThrow;
            }
            return mockGroq.responsePayload;
          },
        },
      };
      constructor(_options: any) {}
    },
  };
});

describe("Stage 3B: GroqProvider", () => {
  beforeEach(() => {
    mockGroq.createCall = null;
    mockGroq.errorToThrow = null;
    mockGroq.delayMs = 0;
    mockGroq.responsePayload = {
      id: "chatcmpl-groq-123",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: '{"result": "groq_success"}',
          },
        },
      ],
      usage: {
        prompt_tokens: 45,
        completion_tokens: 18,
        total_tokens: 63,
      },
    };
  });

  describe("Initialization & Factory Registration", () => {
    it("instantiates successfully with configured API key", () => {
      const provider = new GroqProvider({ apiKey: "gsk_test123456789" });
      expect(provider.providerType).toBe("groq");
      expect(provider.defaultModel).toBe("openai/gpt-oss-120b");
    });

    it("throws CONFIGURATION_ERROR if no API key is provided and client is missing", () => {
      const originalEnv = process.env.GROQ_API_KEY;
      try {
        delete process.env.GROQ_API_KEY;
        expect(() => new GroqProvider({ apiKey: "" })).toThrowError(AIProviderError);
        expect(() => new GroqProvider({ apiKey: "" })).toThrow(/API key is not configured/);
      } finally {
        process.env.GROQ_API_KEY = originalEnv;
      }
    });

    it("resolves via getAIProvider factory", () => {
      const provider = getAIProvider("groq", { apiKey: "gsk_test" });
      expect(provider).toBeInstanceOf(GroqProvider);
      expect(provider.providerType).toBe("groq");
    });
  });

  describe("Text Generation & Token Tracking", () => {
    it("generates text with system instructions, temperature, and JSON format", async () => {
      const provider = new GroqProvider({
        apiKey: "gsk_test",
        model: "llama-3.3-70b-versatile",
      });

      const result = await provider.generateText({
        prompt: "Generate test scenarios",
        systemInstruction: "You are an automated testing bot",
        temperature: 0.15,
        maxOutputTokens: 2048,
        responseFormat: "json",
      });

      expect(mockGroq.createCall).toMatchObject({
        model: "llama-3.3-70b-versatile",
        temperature: 0.15,
        max_tokens: 2048,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You are an automated testing bot" },
          { role: "user", content: expect.stringContaining("Generate test scenarios") },
        ],
      });

      expect(result.text).toBe('{"result": "groq_success"}');
      expect(result.promptTokens).toBe(45);
      expect(result.completionTokens).toBe(18);
      expect(result.totalTokens).toBe(63);
      expect(result.isUsageEstimated).toBe(false);
      expect(result.provider).toBe("groq");
      expect(result.model).toBe("llama-3.3-70b-versatile");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.estimatedCostUsd).toBeGreaterThanOrEqual(0);
    });

    it("ensures word 'json' is present when json responseFormat is requested", async () => {
      const provider = new GroqProvider({ apiKey: "gsk_test" });
      await provider.generateText({
        prompt: "Generate cases with no explicit format word",
        responseFormat: "json",
      });

      const userMsg = mockGroq.createCall.messages.find((m: any) => m.role === "user");
      expect(userMsg.content.toLowerCase()).toContain("json");
    });

    it("truncates stop sequences to at most 4 items for Groq compatibility", async () => {
      const provider = new GroqProvider({ apiKey: "gsk_test" });
      await provider.generateText({
        prompt: "Stop sequence test",
        stopSequences: ["S1", "S2", "S3", "S4", "S5", "S6"],
      });

      expect(mockGroq.createCall.stop).toEqual(["S1", "S2", "S3", "S4"]);
    });

    it("falls back to token estimation when usage metadata is missing", async () => {
      mockGroq.responsePayload = {
        choices: [
          {
            message: {
              content: '{"cases": ["Groq case 1"]}',
            },
          },
        ],
      };

      const provider = new GroqProvider({ apiKey: "gsk_test" });
      const prompt = "Short Groq prompt";
      const result = await provider.generateText({ prompt });

      expect(result.isUsageEstimated).toBe(true);
      expect(result.promptTokens).toBe(Math.ceil(prompt.length / 4));
      expect(result.completionTokens).toBe(Math.ceil('{"cases": ["Groq case 1"]}'.length / 4));
      expect(result.totalTokens).toBe(result.promptTokens + result.completionTokens);
    });

    it("strips markdown code fences when responseFormat is json", async () => {
      mockGroq.responsePayload = {
        choices: [
          {
            message: {
              content: '```json\n{"status": "passed"}\n```',
            },
          },
        ],
      };

      const provider = new GroqProvider({ apiKey: "gsk_test" });
      const result = await provider.generateText({
        prompt: "JSON test",
        responseFormat: "json",
      });

      expect(result.text).toBe('{"status": "passed"}');
    });

    it("throws INVALID_RESPONSE when response choices or text is empty", async () => {
      mockGroq.responsePayload = {
        choices: [{ message: { content: "   " } }],
      };

      const provider = new GroqProvider({ apiKey: "gsk_test" });
      await expect(provider.generateText({ prompt: "empty" })).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
        retryable: true,
      });
    });
  });

  describe("Timeout Handling", () => {
    it("aborts and throws TIMEOUT error when request exceeds timeoutMs", async () => {
      mockGroq.delayMs = 150;

      const provider = new GroqProvider({ apiKey: "gsk_test", timeoutMs: 50 });
      const errPromise = provider.generateText({ prompt: "Slow request", timeoutMs: 50 });

      await expect(errPromise).rejects.toMatchObject({
        code: "TIMEOUT",
        retryable: true,
        provider: "groq",
      });
    });
  });

  describe("Error Normalization & Redaction", () => {
    it("normalizes invalid API key errors to INVALID_CREDENTIALS and redacts the secret", async () => {
      const secret = "gsk_super_secret_groq_key_999";
      mockGroq.errorToThrow = new Error(`Invalid API Key provided: ${secret}`);

      const provider = new GroqProvider({ apiKey: secret });
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
      expect(caughtError.message).toContain("Groq authentication failed");
    });

    it("normalizes 429 rate limit errors to RATE_LIMIT_EXCEEDED (retryable)", async () => {
      mockGroq.errorToThrow = new Error("429 Rate limit reached for model llama-3.3-70b-versatile. rate_limit_exceeded");

      const provider = new GroqProvider({ apiKey: "gsk_test" });
      await expect(provider.generateText({ prompt: "test" })).rejects.toMatchObject({
        code: "RATE_LIMIT_EXCEEDED",
        retryable: true,
        statusCode: 429,
      });
    });

    it("normalizes model not found (404) to MODEL_UNAVAILABLE (non-retryable)", async () => {
      mockGroq.errorToThrow = new Error("The model 'groq-unknown' does not exist or you do not have access to it.");

      const provider = new GroqProvider({ apiKey: "gsk_test" });
      await expect(provider.generateText({ prompt: "test", model: "groq-unknown" })).rejects.toMatchObject({
        code: "MODEL_UNAVAILABLE",
        retryable: false,
        statusCode: 404,
      });
    });

    it("normalizes 503 / 500 service errors to PROVIDER_UNAVAILABLE (retryable)", async () => {
      mockGroq.errorToThrow = new Error("503 Service Unavailable: Groq inference engine overloaded");

      const provider = new GroqProvider({ apiKey: "gsk_test" });
      await expect(provider.generateText({ prompt: "test" })).rejects.toMatchObject({
        code: "PROVIDER_UNAVAILABLE",
        retryable: true,
        statusCode: 503,
      });
    });
  });

  describe("Connection Testing (testConnection)", () => {
    it("returns success: true when test completion succeeds", async () => {
      mockGroq.responsePayload = {
        choices: [{ message: { content: "OK" } }],
      };

      const provider = new GroqProvider({ apiKey: "gsk_test" });
      const testRes = await provider.testConnection();

      expect(testRes.success).toBe(true);
      expect(testRes.provider).toBe("groq");
      expect(testRes.latencyMs).toBeGreaterThanOrEqual(0);
      expect(testRes.error).toBeUndefined();
    });

    it("returns success: false with normalized error when test completion fails", async () => {
      mockGroq.errorToThrow = new Error("401 invalid_api_key");

      const provider = new GroqProvider({ apiKey: "gsk_test" });
      const testRes = await provider.testConnection();

      expect(testRes.success).toBe(false);
      expect(testRes.provider).toBe("groq");
      expect(testRes.error).toContain("Groq authentication failed");
    });
  });
});
