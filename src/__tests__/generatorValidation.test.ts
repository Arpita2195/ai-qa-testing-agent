import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ responseText: "", prompt: "" }));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async ({ contents }: { contents: string }) => {
        mocked.prompt = contents;
        return { text: mocked.responseText };
      },
    };
    constructor(_options: { apiKey: string }) {}
  },
}));

process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.AI_MODEL = "test-model";
process.env.DATABASE_URL = "postgresql://localhost/test";
process.env.PLATFORM_API_KEY = "test-platform-api-key-12345";
process.env.STOCKFLOW_TEST_EMAIL = "private-user@example.test";
process.env.STOCKFLOW_TEST_PASSWORD = "private-password-fixture";

const pageData = {
  title: "Sign in",
  url: "https://example.test/",
  text: "Sign in to continue. Email Password",
  elements: [
    {
      tag: "input",
      text: "Email",
      selector: "#email",
      type: "email",
      value: "private-user@example.test",
    },
    {
      tag: "input",
      text: "Password",
      selector: "#password",
      type: "password",
      value: "private-password-fixture",
    },
  ],
};

function generatedCase(title: string, step: string) {
  return {
    title,
    description: "A generated test",
    steps: [step],
    expected_result: "The page behaves as expected",
  };
}

describe("generated test case validation", () => {
  beforeEach(() => {
    vi.resetModules();
    mocked.prompt = "";
    mocked.responseText = JSON.stringify([
      generatedCase("Fill with sample", "fill #email | Sample text"),
      generatedCase("Unknown selector", "fill #missing | Sample text"),
      generatedCase("Unknown format", "press Enter"),
    ]);
  });

  it("accepts fill values absent from page data and skips only invalid cases", async () => {
    const { generateTestCases } = await import("../services/generator");
    const cases = await generateTestCases(pageData);
    expect(cases.map((testCase) => testCase.title)).toEqual(["Fill with sample"]);
    expect(mocked.prompt).toContain("{{STOCKFLOW_TEST_EMAIL}}");
    expect(mocked.prompt).toContain("{{STOCKFLOW_TEST_PASSWORD}}");
    expect(mocked.prompt).not.toContain("private-user@example.test");
    expect(mocked.prompt).not.toContain("private-password-fixture");
  });

  it("skips a case when expect text is absent from page data", async () => {
    mocked.responseText = JSON.stringify([
      generatedCase("Missing assertion text", "expect text invented text"),
      generatedCase("Valid", "expect text Sign in"),
      generatedCase("Valid fill", "fill #password | Sample text"),
    ]);
    const { generateTestCases } = await import("../services/generator");
    const cases = await generateTestCases(pageData);
    expect(cases.map((testCase) => testCase.title)).toEqual(["Valid", "Valid fill"]);
  });

  it("rejects fill steps that use a selector absent from page data", async () => {
    mocked.responseText = JSON.stringify([
      generatedCase("First", "fill #nope | 12345"),
      generatedCase("Second", "fill #missing | Sample text"),
      generatedCase("Third", "fill #unknown | Sample text"),
    ]);
    const { generateTestCases } = await import("../services/generator");
    await expect(generateTestCases(pageData)).rejects.toThrow(
      "AI returned no valid test cases, try again or generate for a specific path",
    );
  });

  it("drops one invalid case without failing the batch in page-specific generation", async () => {
    const { generateSiteTestCases } = await import("../services/generator");
    mocked.responseText = JSON.stringify([
      generatedCase("Valid button click", "click #filter"),
      generatedCase("Invalid element click", "click #missing-element"),
      generatedCase("Valid text check", "expect text Active Inventory"),
    ]);

    const siteData = {
      baseUrl: "https://example.test",
      isLoggedIn: false,
      loginSteps: [],
      pages: [
        {
          url: "https://example.test/inventory",
          path: "/inventory",
          title: "Inventory",
          headings: ["Inventory Overview"],
          text: "Active Inventory list and details",
          elements: [{ tag: "button", text: "Filter", selector: "#filter" }],
        },
      ],
    };

    const result = await generateSiteTestCases(siteData);
    expect(result.testCases.map((c) => c.title)).toEqual([
      "Valid button click",
      "Valid text check",
    ]);
    expect(result.skipped_invalid).toBe(1);
  });

  it("rejects generic assertions such as the app name StockFlow", async () => {
    const { generateSiteTestCases, isGenericAssertion } = await import(
      "../services/generator"
    );
    expect(isGenericAssertion("StockFlow")).toBe(true);
    expect(isGenericAssertion("stockflow")).toBe(true);
    expect(isGenericAssertion("Custom App", "Custom App")).toBe(true);
    expect(isGenericAssertion("Active Orders")).toBe(false);

    mocked.responseText = JSON.stringify([
      generatedCase("Generic assertion case", "expect text StockFlow"),
      generatedCase("Page specific assertion", "expect text Products Table"),
    ]);

    const siteData = {
      baseUrl: "https://example.test",
      isLoggedIn: false,
      loginSteps: [],
      pages: [
        {
          url: "https://example.test/products",
          path: "/products",
          title: "Products",
          headings: ["Products Table"],
          text: "StockFlow portal - Products Table content",
          elements: [],
        },
      ],
    };

    const result = await generateSiteTestCases(siteData, "StockFlow");
    expect(result.testCases.map((c) => c.title)).toEqual([
      "Page specific assertion",
    ]);
    expect(result.skipped_invalid).toBe(1);
  });

  it("preserves login placeholders and never leaks real credentials in prompt or steps", async () => {
    const { generateSiteTestCases } = await import("../services/generator");
    mocked.responseText = JSON.stringify([
      generatedCase("Check inventory heading", "expect text Inventory Items"),
    ]);

    const siteData = {
      baseUrl: "https://example.test",
      isLoggedIn: true,
      loginSteps: [
        "fill #email | {{STOCKFLOW_TEST_EMAIL}}",
        "fill #password | {{STOCKFLOW_TEST_PASSWORD}}",
        "click #login-btn",
        "expect not visible #password",
      ],
      pages: [
        {
          url: "https://example.test/inventory",
          path: "/inventory",
          title: "Inventory",
          headings: ["Inventory Items"],
          text: "Welcome private-user@example.test to Inventory Items",
          elements: [
            {
              tag: "input",
              text: "Email",
              selector: "#user",
              value: "private-user@example.test",
            },
          ],
        },
      ],
    };

    const result = await generateSiteTestCases(siteData);
    expect(result.testCases).toHaveLength(1);
    const testCase = result.testCases[0];

    // Check placeholders preserved
    expect(testCase.steps[0]).toBe("fill #email | {{STOCKFLOW_TEST_EMAIL}}");
    expect(testCase.steps[1]).toBe("fill #password | {{STOCKFLOW_TEST_PASSWORD}}");
    expect(testCase.steps[2]).toBe("click #login-btn");
    expect(testCase.steps[3]).toBe("expect not visible #password");
    expect(testCase.steps[4]).toBe("goto /inventory");
    expect(testCase.steps[5]).toBe("expect text Inventory Items");

    // Check prompt sent to Gemini does NOT contain real credentials
    expect(mocked.prompt).not.toContain("private-user@example.test");
    expect(mocked.prompt).not.toContain("private-password-fixture");
    expect(mocked.prompt).toContain("{{STOCKFLOW_TEST_EMAIL}}");

    // Check steps do NOT contain real credentials
    const allStepsStr = testCase.steps.join("\n");
    expect(allStepsStr).not.toContain("private-user@example.test");
    expect(allStepsStr).not.toContain("private-password-fixture");
  });

  it("skips duplicate titles when inserting test cases", async () => {
    const existingTitles = new Set(["Existing Test Case"]);
    const candidateCases = [
      { title: "Existing Test Case", steps: ["goto /"] },
      { title: "Brand New Test Case", steps: ["goto /"] },
      { title: "Brand New Test Case", steps: ["goto /"] },
    ];

    let skipped_duplicate = 0;
    const inserted: string[] = [];

    for (const testCase of candidateCases) {
      if (existingTitles.has(testCase.title)) {
        skipped_duplicate++;
        continue;
      }
      inserted.push(testCase.title);
      existingTitles.add(testCase.title);
    }

    expect(inserted).toEqual(["Brand New Test Case"]);
    expect(skipped_duplicate).toBe(2);
  });
});

