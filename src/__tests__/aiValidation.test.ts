import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ responseText: "" }));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async () => ({ text: mocked.responseText }),
    };
    constructor(_options: { apiKey: string }) {}
  },
}));

process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.AI_MODEL = "test-model";
process.env.DATABASE_URL = "postgresql://test:test@localhost/test";
process.env.PLATFORM_API_KEY = "test-platform-api-key-12345";

const pageData = {
  title: "Example",
  url: "https://example.test/",
  text: "Example body",
  elements: [],
};

describe("AI JSON output validation", () => {
  beforeEach(() => {
    vi.resetModules();
    mocked.responseText = "not json";
  });

  it("throws a clear error for invalid generator JSON", async () => {
    const { generateTestCases } = await import("../services/generator");
    await expect(generateTestCases(pageData)).rejects.toThrow(
      "Gemini returned invalid JSON for generated test cases",
    );
  });

  it("throws a clear error for generator output that fails the zod schema", async () => {
    mocked.responseText = JSON.stringify([{ title: "Incomplete" }]);
    const { generateTestCases } = await import("../services/generator");
    await expect(generateTestCases(pageData)).rejects.toThrow(
      "Gemini returned invalid test cases",
    );
  });

  it("throws a clear error for invalid failure analyzer JSON", async () => {
    const { analyzeFailure } = await import("../services/failureAnalyzer");
    await expect(
      analyzeFailure({
        title: "Failure",
        steps: ["goto /"],
        expected_result: "visible",
        errorMessage: "not found",
        pageUrl: "https://example.test/",
      }),
    ).rejects.toThrow("Gemini returned invalid JSON for failure analysis");
  });

  it("throws a clear error for failure analysis that fails the zod schema", async () => {
    mocked.responseText = JSON.stringify({
      title: "Failure",
      description: "A test failed",
      severity: "urgent",
      classification: "unknown",
      probable_cause: "Unclear",
      reproduction_steps: [],
    });
    const { analyzeFailure } = await import("../services/failureAnalyzer");
    await expect(
      analyzeFailure({
        title: "Failure",
        steps: ["goto /"],
        expected_result: "visible",
        errorMessage: "not found",
        pageUrl: "https://example.test/",
      }),
    ).rejects.toThrow("Gemini returned an invalid failure analysis");
  });
});
