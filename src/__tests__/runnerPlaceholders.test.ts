import { beforeEach, describe, expect, it, vi } from "vitest";

describe("StockFlow placeholder handling", () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.AI_MODEL = "test-model";
    process.env.DATABASE_URL = "postgresql://localhost/test";
    process.env.PLATFORM_API_KEY = "test-platform-api-key-12345";
    process.env.STOCKFLOW_TEST_EMAIL = "pilot@example.invalid";
    process.env.STOCKFLOW_TEST_PASSWORD = "fixture-password";
    vi.resetModules();
  });

  it("resolves env credentials at run time without changing the saved step", async () => {
    const { resolveStepPlaceholders } = await import("../services/runner");
    const savedStep = "fill #email | {{STOCKFLOW_TEST_EMAIL}}";
    expect(
      resolveStepPlaceholders(savedStep),
    ).toBe("fill #email | pilot@example.invalid");
    expect(savedStep).toBe("fill #email | {{STOCKFLOW_TEST_EMAIL}}");
  });

  it("redacts resolved credential values from errors", async () => {
    const { redactSecrets } = await import("../services/runner");
    expect(
      redactSecrets("Fill failed for pilot@example.invalid with fixture-password"),
    ).toBe("Fill failed for [hidden] with [hidden]");
  });

  it("fails clearly when a referenced credential is missing", async () => {
    const { resolveStepPlaceholders } = await import("../services/runner");
    expect(() => resolveStepPlaceholders("fill #email | {{STOCKFLOW_TEST_EMAIL}}", {}))
      .toThrow("Missing STOCKFLOW_TEST_EMAIL or STOCKFLOW_TEST_PASSWORD in .env");
  });
});
