import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  normalizePageIdentity,
  isPageIdentityMatch,
  findMatchingPageForPath,
} from "../utils/urlPageMatcher";
import {
  getDefaultModelForProvider,
  DEFAULT_MODELS,
} from "../services/ai/projectAiConfigService";
import { getAIProviderForProject } from "../services/ai/providerFactory";
import {
  groqCandidateReviewSchema,
  groqReviewOutputSchema,
} from "../services/ai/twoStageReviewSchemas";
import { validatePageSteps, safePageData } from "../services/generator";
import { pool } from "../config/db";

describe("Stage 8I — Targeted Defect Fixes & Robustness Tests", () => {
  describe("FIX 1: Query-Parameter Page Matching & Identity", () => {
    const crawledPages = [
      {
        url: "http://localhost:3097/",
        path: "/",
        title: "Home",
        elements: [{ tag: "a", text: "Inventory", selector: "#nav-inv" }],
      },
      {
        url: "http://localhost:3097/inventory",
        path: "/inventory",
        title: "Inventory Base",
        elements: [
          { tag: "input", text: "", selector: "#search-input" },
          { tag: "button", text: "Search", selector: "#search-btn" },
          { tag: "a", text: "Page 2", selector: "#next-page" },
        ],
      },
      {
        url: "http://localhost:3097/inventory?page=1",
        path: "/inventory",
        title: "Inventory Page 1",
        elements: [
          { tag: "input", text: "", selector: "#search-input" },
          { tag: "button", text: "Search", selector: "#search-btn" },
        ],
      },
      {
        url: "http://localhost:3097/inventory?page=2",
        path: "/inventory",
        title: "Inventory Page 2",
        elements: [
          { tag: "table", text: "SKU-201", selector: "#inventory-table" },
          { tag: "a", text: "Prev", selector: "#prev-page" },
        ],
      },
      {
        url: "http://localhost:3097/items/101",
        path: "/items/101",
        title: "Widget Alpha",
        elements: [{ tag: "button", text: "Specs", selector: "#tab-specs" }],
      },
    ];

    it("1. Matches /inventory?page=1 to its exact crawled page and state", () => {
      const match = findMatchingPageForPath(crawledPages, "/inventory?page=1");
      expect(match.page).not.toBeNull();
      expect(match.page?.title).toBe("Inventory Page 1");
      expect(match.page?.url).toBe("http://localhost:3097/inventory?page=1");
    });

    it("2. Matches /inventory?page=2 to its exact crawled page and state", () => {
      const match = findMatchingPageForPath(crawledPages, "/inventory?page=2");
      expect(match.page).not.toBeNull();
      expect(match.page?.title).toBe("Inventory Page 2");
      expect(match.page?.url).toBe("http://localhost:3097/inventory?page=2");
    });

    it("3. Matches /inventory to the base page without query parameters", () => {
      const match = findMatchingPageForPath(crawledPages, "/inventory");
      expect(match.page).not.toBeNull();
      expect(match.page?.title).toBe("Inventory Base");
      expect(match.page?.url).toBe("http://localhost:3097/inventory");
    });

    it("4. Handles query parameter order consistently", () => {
      const pageWithMultiParams = {
        url: "http://localhost:3097/inventory?category=tools&page=2",
        path: "/inventory",
        title: "Tools Page 2",
        elements: [],
      };
      const pages = [...crawledPages, pageWithMultiParams];

      // Reverse query parameter order in target lookup
      const match = findMatchingPageForPath(pages, "/inventory?page=2&category=tools");
      expect(match.page).not.toBeNull();
      expect(match.page?.title).toBe("Tools Page 2");
    });

    it("5. Treats different query parameter values as distinct application states", () => {
      expect(
        isPageIdentityMatch("/inventory?page=1", {
          url: "http://localhost:3097/inventory?page=2",
          path: "/inventory",
        }),
      ).toBe(false);

      expect(
        isPageIdentityMatch("/inventory?page=2", {
          url: "http://localhost:3097/inventory?page=1",
          path: "/inventory",
        }),
      ).toBe(false);

      expect(
        isPageIdentityMatch("/inventory?page=1", {
          url: "http://localhost:3097/inventory",
          path: "/inventory",
        }),
      ).toBe(false);
    });

    it("6. Prevents external origins from matching internal pages", () => {
      const externalMatch = isPageIdentityMatch("https://malicious.org/inventory", {
        url: "http://localhost:3097/inventory",
        path: "/inventory",
      });
      expect(externalMatch).toBe(false);
    });

    it("7. Missing page match returns explicit diagnostic and does NOT silently select homepage", () => {
      const match = findMatchingPageForPath(crawledPages, "/non-existent-page?foo=bar");
      expect(match.page).toBeNull();
      expect(match.error).toContain("No crawled page matched functionality path");
      expect(match.error).toContain("/non-existent-page?foo=bar");
    });

    it("8. Validates goto step with query parameters correctly in validatePageSteps", () => {
      const page2 = crawledPages.find((p) => p.url === "http://localhost:3097/inventory?page=2")!;
      const validCase = {
        title: "Page 2 navigation test",
        description: "Navigates to page 2 and clicks previous",
        steps: ["goto /inventory?page=2", "click #prev-page"],
        expected_result: "Previous page link works",
      };

      // Should succeed on page2
      expect(() => validatePageSteps(page2 as any, validCase as any, "StockFlow")).not.toThrow();

      // Should throw when run against root page data
      const rootPage = crawledPages[0];
      expect(() => validatePageSteps(rootPage as any, validCase as any, "StockFlow")).toThrow(
        /goto path is not present in the page data/,
      );
    });

    it("9. Existing non-query navigation steps continue passing", () => {
      const baseInv = crawledPages.find((p) => p.url === "http://localhost:3097/inventory")!;
      const validCase = {
        title: "Search test",
        description: "Executes keyword search",
        steps: ["goto /inventory", "fill #search-input | Widget", "click #search-btn"],
        expected_result: "Results displayed",
      };
      expect(() => validatePageSteps(baseInv as any, validCase as any, "StockFlow")).not.toThrow();
    });
  });

  describe("FIX 2: Gemini Default Model Configuration & Precedence", () => {
    const originalEnvAiModel = process.env.AI_MODEL;

    afterEach(() => {
      if (originalEnvAiModel !== undefined) {
        process.env.AI_MODEL = originalEnvAiModel;
      } else {
        delete process.env.AI_MODEL;
      }
    });

    it("1. Uses configured environment model when project model is absent", () => {
      process.env.AI_MODEL = "gemini-3.1-flash-lite";
      const model = getDefaultModelForProvider("gemini");
      expect(model).toBe("gemini-3.1-flash-lite");
    });

    it("2. Falls back to documented application default when env variable is unset", () => {
      delete process.env.AI_MODEL;
      // In our env setup, env.AI_MODEL or default application model is gemini-3.1-flash-lite
      const model = getDefaultModelForProvider("gemini");
      expect(model).toMatch(/^gemini-3\.1-flash-lite/);
    });

    it("3. DEFAULT_MODELS dynamic getters reflect resolved default models", () => {
      process.env.AI_MODEL = "gemini-3.1-flash-lite";
      expect(DEFAULT_MODELS.gemini).toBe("gemini-3.1-flash-lite");
      expect(DEFAULT_MODELS.groq).toBe("openai/gpt-oss-120b");
      expect(DEFAULT_MODELS.openai).toBe("gpt-4o-mini");
      expect(DEFAULT_MODELS.ollama).toBe("llama3.2");
    });

    it("4. Resolves provider for project with explicit model taking highest precedence", async () => {
      const provider = await getAIProviderForProject(undefined, {
        model: "custom-gemini-model-explicit",
      });
      expect(provider.providerType).toBe("gemini");
      expect(provider.defaultModel).toBe("custom-gemini-model-explicit");
    });

    it("5. Resolves provider for unconfigured project using environment model without error", async () => {
      process.env.AI_MODEL = "gemini-3.1-flash-lite";
      const provider = await getAIProviderForProject();
      expect(provider.providerType).toBe("gemini");
      expect(provider.defaultModel).toBe("gemini-3.1-flash-lite");
    });
  });

  describe("FIX 3: Groq Reviewer Schema Robustness & Safe Fallback", () => {
    it("1. Accepts and normalizes null metadata fields emitted by LLM when no corrections are made", () => {
      const rawCandidateReview = {
        candidate_id: "cand-1",
        verdict: "approved",
        issues: null,
        reason: "Step sequence is valid and selector exists in DOM",
        confidence: 0.95,
        corrected_title: null,
        corrected_steps: null,
        corrected_expected_result: null,
        corrected_category: null,
        corrected_priority: null,
      };

      const parsed = groqCandidateReviewSchema.safeParse(rawCandidateReview);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.candidate_id).toBe("cand-1");
        expect(parsed.data.verdict).toBe("approved");
        expect(parsed.data.issues).toEqual([]);
        expect(parsed.data.corrected_title).toBeUndefined();
        expect(parsed.data.corrected_steps).toBeUndefined();
        expect(parsed.data.corrected_expected_result).toBeUndefined();
        expect(parsed.data.corrected_category).toBeUndefined();
        expect(parsed.data.corrected_priority).toBeUndefined();
      }
    });

    it("2. Accepts and normalizes null fields in groqReviewOutputSchema", () => {
      const rawOutput = {
        candidate_reviews: [
          {
            candidate_id: "cand-101",
            verdict: "needs_correction",
            issues: ["Assertion unverified in observed state transitions"],
            reason: null,
            confidence: null,
            corrected_title: "Corrected Title Here",
            corrected_steps: ["goto /inventory", "click #search-btn"],
            corrected_expected_result: null,
            corrected_category: "positive",
            corrected_priority: "high",
          },
        ],
        missing_scenarios: null,
        summary: null,
      };

      const parsed = groqReviewOutputSchema.safeParse(rawOutput);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.candidate_reviews).toHaveLength(1);
        expect(parsed.data.candidate_reviews[0].verdict).toBe("needs_correction");
        expect(parsed.data.candidate_reviews[0].reason).toBe("");
        expect(parsed.data.candidate_reviews[0].confidence).toBe(1);
        expect(parsed.data.candidate_reviews[0].corrected_title).toBe("Corrected Title Here");
        expect(parsed.data.candidate_reviews[0].corrected_expected_result).toBeUndefined();
        expect(parsed.data.missing_scenarios).toEqual([]);
        expect(parsed.data.summary).toBe("");
      }
    });

    it("3. Rejects truly invalid reviewer output (e.g. invalid verdict or missing candidate_id)", () => {
      const invalidReview = {
        candidate_id: "",
        verdict: "not_a_valid_verdict",
      };

      const parsed = groqCandidateReviewSchema.safeParse(invalidReview);
      expect(parsed.success).toBe(false);
    });

    it("4. Rejects malformed JSON or non-object structures", () => {
      const invalidOutputs = ["invalid string", 123, []];
      for (const inv of invalidOutputs) {
        expect(groqReviewOutputSchema.safeParse(inv).success).toBe(false);
      }
    });
  });
});
