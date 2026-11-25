import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateStepsAgainstDomEvidence,
  reviewCandidateBatch,
  type EvidenceContext,
} from "../services/ai/twoStageReviewService";
import { calculateEstimatedCostUsd, DEFAULT_RATES, getProviderPricing } from "../services/ai/pricing";
import { pool } from "../config/db";
import { env } from "../config/env";
import { encryptSecret, decryptSecret } from "../services/secretStore";

// Mock state for Groq SDK
const mockGroq = vi.hoisted(() => ({
  createCall: null as any,
  createHandler: null as ((params: any) => Promise<any>) | null,
  errorToThrow: null as Error | null,
}));

vi.mock("groq-sdk", () => {
  return {
    default: class MockGroq {
      chat = {
        completions: {
          create: async (params: any) => {
            mockGroq.createCall = params;
            if (mockGroq.errorToThrow) {
              throw mockGroq.errorToThrow;
            }
            if (mockGroq.createHandler) {
              return await mockGroq.createHandler(params);
            }
            // Default handler: dynamically associate candidate_id from prompt
            const rawPrompt = params.messages[1]?.content || "";
            let candId = "cand-1";
            if (rawPrompt.includes("<CANDIDATE_TEST_CASES>")) {
              const jsonSlice = rawPrompt.split("<CANDIDATE_TEST_CASES>\n")[1]?.split("\n</CANDIDATE_TEST_CASES>")[0];
              if (jsonSlice) {
                try {
                  const parsed = JSON.parse(jsonSlice);
                  if (parsed[0]?.candidate_id) candId = parsed[0].candidate_id;
                } catch {}
              }
            }
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      candidate_reviews: [
                        {
                          candidate_id: candId,
                          verdict: "approved",
                          issues: [],
                          reason: "All steps match verified evidence",
                          confidence: 1.0,
                        },
                      ],
                      missing_scenarios: [],
                      summary: "Candidate approved",
                    }),
                  },
                },
              ],
              usage: { prompt_tokens: 250, completion_tokens: 80 },
            };
          },
        },
      };
      constructor(_options: any) {}
    },
  };
});

// Mock aiBudgetService functions
vi.mock("../services/ai/aiBudgetService", () => {
  return {
    reserveAiBudget: vi.fn().mockResolvedValue({
      id: "res-test-123",
      ownerToken: "token-test-123",
      status: "active",
    }),
    reconcileAiBudgetReservation: vi.fn().mockResolvedValue(true),
    releaseAiBudgetReservation: vi.fn().mockResolvedValue(true),
    markReservationUncertain: vi.fn().mockResolvedValue(true),
    startReservationHeartbeat: vi.fn().mockReturnValue({ stop: vi.fn() }),
    isConfirmedProviderFailure: vi.fn().mockImplementation((err: any) => {
      return Boolean(err && (err.status === 401 || err.status === 400));
    }),
  };
});

describe("Stage 7: Gemini + Groq Two-Stage AI Generation & Quality Review", () => {
  beforeEach(() => {
    mockGroq.createCall = null;
    mockGroq.createHandler = null;
    mockGroq.errorToThrow = null;
    vi.clearAllMocks();
  });

  // 1. Pricing and Rate Lookup for Groq openai/gpt-oss-120b
  describe("Groq Model Selection & Token Pricing", () => {
    it("should register openai/gpt-oss-120b in DEFAULT_RATES with correct rates", () => {
      const rate = DEFAULT_RATES["openai/gpt-oss-120b"];
      expect(rate).toBeDefined();
      expect(rate.promptRatePerMillion).toBe(0.15);
      expect(rate.completionRatePerMillion).toBe(0.60);
    });

    it("should calculate estimated cost correctly for openai/gpt-oss-120b", () => {
      // 1,000 prompt tokens ($0.15/1M = $0.00015) + 500 completion tokens ($0.60/1M = $0.00030) = $0.00045
      const cost = calculateEstimatedCostUsd("openai/gpt-oss-120b", 1000, 500, "groq");
      expect(cost).toBe(0.00045);
    });

    it("should return correct pricing info via getProviderPricing", () => {
      const info = getProviderPricing("groq", "openai/gpt-oss-120b");
      expect(info.provider).toBe("groq");
      expect(info.promptRatePerMillion).toBe(0.15);
      expect(info.completionRatePerMillion).toBe(0.60);
      expect(info.isFreeApi).toBe(false);
    });
  });

  // 2. DOM Evidence Validation (Pre-audit & Groq Correction Verification)
  describe("Evidence-Based Step Validation (validateStepsAgainstDomEvidence)", () => {
    const sampleEvidence: EvidenceContext = {
      source: "crawler_dom",
      appName: "StockFlow",
      pagePath: "/inventory",
      visibleText: ["Inventory Items", "Add New Product", "SKU", "In Stock"],
      elements: [
        { tag: "input", selector: "#product-name", text: "", type: "text" },
        { tag: "input", selector: "#product-sku", text: "", type: "text" },
        { tag: "button", selector: "#btn-submit", text: "Add New Product", type: "submit" },
      ],
    };

    it("should validate correct browser automation steps matching DOM evidence", () => {
      const steps = [
        "goto /inventory",
        "fill #product-name | Widget A",
        "fill #product-sku | SKU-100",
        "click #btn-submit",
        "expect text Inventory Items",
      ];
      const result = validateStepsAgainstDomEvidence(steps, sampleEvidence);
      expect(result.valid).toBe(true);
      expect(result.invalidSteps).toHaveLength(0);
    });

    it("should catch and flag unsupported click selector not present in evidence", () => {
      const steps = [
        "goto /inventory",
        "click #non-existent-button",
      ];
      const result = validateStepsAgainstDomEvidence(steps, sampleEvidence);
      expect(result.valid).toBe(false);
      expect(result.invalidSteps[0]).toContain("click selector \"#non-existent-button\" was not found");
    });

    it("should catch and flag invalid fill format without delimiter", () => {
      const steps = [
        "goto /inventory",
        "fill #product-name Widget Without Pipe",
      ];
      const result = validateStepsAgainstDomEvidence(steps, sampleEvidence);
      expect(result.valid).toBe(false);
      expect(result.invalidSteps[0]).toContain("fill step is missing delimiter");
    });

    it("should reject generic application name assertions", () => {
      const steps = [
        "goto /inventory",
        "expect text StockFlow",
      ];
      const result = validateStepsAgainstDomEvidence(steps, sampleEvidence);
      expect(result.valid).toBe(false);
      expect(result.invalidSteps[0]).toContain("generic app name assertion \"StockFlow\" is not allowed");
    });

    it("should reject assertions on text not present in visible page text", () => {
      const steps = [
        "goto /inventory",
        "expect text Completely Hallucinated Heading",
      ];
      const result = validateStepsAgainstDomEvidence(steps, sampleEvidence);
      expect(result.valid).toBe(false);
      expect(result.invalidSteps[0]).toContain("expect text \"Completely Hallucinated Heading\" is not present");
    });

    it("should reject goto paths that do not match the page path", () => {
      const steps = [
        "goto /different-page",
      ];
      const result = validateStepsAgainstDomEvidence(steps, sampleEvidence);
      expect(result.valid).toBe(false);
      expect(result.invalidSteps[0]).toContain("goto path \"/different-page\" does not match page \"/inventory\"");
    });
  });

  // 3. Two-Stage Review Flow: Disabled, Enabled, Corrections, and Fallbacks
  describe("Two-Stage Review Service (reviewCandidateBatch)", () => {
    const testProjectId = "11111111-2222-3333-4444-555555555555";
    const sampleEvidence: EvidenceContext = {
      source: "crawler_dom",
      appName: "StockFlow",
      pagePath: "/products",
      visibleText: ["Product Catalog", "Create Product", "Success: Product created"],
      elements: [
        { tag: "input", selector: "#title-field", text: "", type: "text" },
        { tag: "button", selector: "#save-btn", text: "Create Product", type: "submit" },
      ],
    };

    it("should mark candidates as 'skipped' when two_stage_review_enabled is false", async () => {
      const querySpy = vi.spyOn(pool, "query").mockImplementation(async (sql: any) => {
        if (typeof sql === "string" && sql.includes("FROM project_ai_configurations")) {
          return {
            rowCount: 1,
            rows: [
              {
                provider: "gemini",
                model: "gemini-2.5-flash",
                api_key_enc: null,
                base_url: null,
                two_stage_review_enabled: false,
                review_model: "openai/gpt-oss-120b",
              },
            ],
          } as any;
        }
        if (typeof sql === "string" && sql.includes("FROM project_ai_provider_credentials")) {
          return { rowCount: 0, rows: [] } as any;
        }
        return { rowCount: 0, rows: [] } as any;
      });

      const candidates = [
        {
          title: "Create standard product",
          description: "Verify product creation flow",
          steps: ["goto /products", "fill #title-field | Product 1", "click #save-btn", "expect text Success: Product created"],
          expected_result: "Product is created successfully",
          category: "positive",
          priority: "high",
        },
      ];

      const results = await reviewCandidateBatch({
        projectId: testProjectId,
        candidates,
        evidence: sampleEvidence,
      });

      querySpy.mockRestore();

      expect(results).toHaveLength(1);
      expect(results[0].ai_review_metadata.review_status).toBe("skipped");
      expect(results[0].ai_review_metadata.reason).toContain("not enabled");
      expect(results[0].title).toBe("Create standard product");
      expect(results[0].candidate_id).toMatch(/^cand_/);
    });

    it("should fallback gracefully with 'incomplete' status when Groq API key is missing", async () => {
      const querySpy = vi.spyOn(pool, "query").mockImplementation(async (sql: any) => {
        if (typeof sql === "string" && sql.includes("FROM project_ai_configurations")) {
          return {
            rowCount: 1,
            rows: [
              {
                provider: "gemini",
                model: "gemini-2.5-flash",
                api_key_enc: null,
                base_url: null,
                two_stage_review_enabled: true,
                review_model: "openai/gpt-oss-120b",
              },
            ],
          } as any;
        }
        if (typeof sql === "string" && sql.includes("FROM project_ai_provider_credentials")) {
          return { rowCount: 0, rows: [] } as any;
        }
        return { rowCount: 0, rows: [] } as any;
      });

      const origEnvKey = process.env.GROQ_API_KEY;
      const origConfigEnvKey = (env as any).GROQ_API_KEY;
      delete process.env.GROQ_API_KEY;
      (env as any).GROQ_API_KEY = undefined;

      const candidates = [
        {
          title: "Create standard product",
          description: "Verify product creation flow",
          steps: ["goto /products", "fill #title-field | Product 1", "click #save-btn", "expect text Success: Product created"],
          expected_result: "Product is created successfully",
        },
      ];

      const results = await reviewCandidateBatch({
        projectId: testProjectId,
        candidates,
        evidence: sampleEvidence,
      });

      if (origEnvKey) process.env.GROQ_API_KEY = origEnvKey;
      if (origConfigEnvKey) (env as any).GROQ_API_KEY = origConfigEnvKey;
      querySpy.mockRestore();

      expect(results).toHaveLength(1);
      expect(results[0].ai_review_metadata.review_status).toBe("incomplete");
      expect(results[0].ai_review_metadata.fallback_to_primary).toBe(true);
      expect(results[0].title).toBe("Create standard product");
    });

    it("should apply evidence-supported Groq corrections and preserve original_candidate", async () => {
      const encryptedKey = encryptSecret("mock-groq-key-12345");
      const querySpy = vi.spyOn(pool, "query").mockImplementation(async (sql: any) => {
        if (typeof sql === "string" && sql.includes("FROM project_ai_configurations")) {
          return {
            rowCount: 1,
            rows: [
              {
                provider: "gemini",
                model: "gemini-2.5-flash",
                api_key_enc: null,
                base_url: null,
                two_stage_review_enabled: true,
                review_model: "openai/gpt-oss-120b",
              },
            ],
          } as any;
        }
        if (typeof sql === "string" && sql.includes("FROM project_ai_provider_credentials")) {
          return {
            rowCount: 1,
            rows: [{ provider: "groq", api_key_enc: encryptedKey }],
          } as any;
        }
        return { rowCount: 0, rows: [] } as any;
      });

      mockGroq.createHandler = async (params: any) => {
        const rawPrompt = params.messages[1].content;
        const parsedPrompt = JSON.parse(
          rawPrompt.split("<CANDIDATE_TEST_CASES>\n")[1].split("\n</CANDIDATE_TEST_CASES>")[0],
        );
        const candId = parsedPrompt[0].candidate_id;
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  candidate_reviews: [
                    {
                      candidate_id: candId,
                      verdict: "needs_correction",
                      issues: ["Strengthened assertion to match visible success banner"],
                      reason: "Assertion improved against crawler evidence",
                      confidence: 0.95,
                      corrected_title: "Create product and verify success banner",
                      corrected_steps: [
                        "goto /products",
                        "fill #title-field | Product Enhanced",
                        "click #save-btn",
                        "expect text Success: Product created",
                      ],
                      corrected_expected_result: "Confirmation banner displays Success: Product created",
                      corrected_category: "positive",
                      corrected_priority: "high",
                    },
                  ],
                  missing_scenarios: [],
                  summary: "1 candidate reviewed",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 400, completion_tokens: 150 },
        };
      };

      const results = await reviewCandidateBatch({
        projectId: testProjectId,
        candidates: [
          {
            title: "Original Gemini Title",
            description: "Initial description",
            steps: ["goto /products", "click #save-btn"],
            expected_result: "Product submitted",
          },
        ],
        evidence: sampleEvidence,
      });

      querySpy.mockRestore();

      expect(results).toHaveLength(1);
      const tc = results[0];
      expect(tc.ai_review_metadata.review_status).toBe("reviewed");
      expect(tc.ai_review_metadata.corrections_applied).toBe(true);
      expect(tc.title).toBe("Create product and verify success banner");
      expect(tc.steps).toEqual([
        "goto /products",
        "fill #title-field | Product Enhanced",
        "click #save-btn",
        "expect text Success: Product created",
      ]);
      expect(tc.ai_review_metadata.original_candidate).toBeDefined();
      expect(tc.ai_review_metadata.original_candidate?.title).toBe("Original Gemini Title");
    });

    it("should reject Groq corrections that use hallucinated selectors not in crawler DOM", async () => {
      const encryptedKey = encryptSecret("mock-groq-key-12345");
      const querySpy = vi.spyOn(pool, "query").mockImplementation(async (sql: any) => {
        if (typeof sql === "string" && sql.includes("FROM project_ai_configurations")) {
          return {
            rowCount: 1,
            rows: [
              {
                provider: "gemini",
                model: "gemini-2.5-flash",
                api_key_enc: null,
                base_url: null,
                two_stage_review_enabled: true,
                review_model: "openai/gpt-oss-120b",
              },
            ],
          } as any;
        }
        if (typeof sql === "string" && sql.includes("FROM project_ai_provider_credentials")) {
          return {
            rowCount: 1,
            rows: [{ provider: "groq", api_key_enc: encryptedKey }],
          } as any;
        }
        return { rowCount: 0, rows: [] } as any;
      });

      // Groq proposes a correction with a hallucinated selector "#hallucinated-selector"
      mockGroq.createHandler = async (params: any) => {
        const rawPrompt = params.messages[1].content;
        const parsedPrompt = JSON.parse(
          rawPrompt.split("<CANDIDATE_TEST_CASES>\n")[1].split("\n</CANDIDATE_TEST_CASES>")[0],
        );
        const candId = parsedPrompt[0].candidate_id;
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  candidate_reviews: [
                    {
                      candidate_id: candId,
                      verdict: "needs_correction",
                      issues: ["Added extra confirmation click"],
                      reason: "Testing confirmation dialog",
                      confidence: 0.9,
                      corrected_title: "Hallucinated confirmation test",
                      corrected_steps: [
                        "goto /products",
                        "click #hallucinated-selector", // DOES NOT EXIST IN EVIDENCE
                      ],
                      corrected_expected_result: "Dialog confirms",
                    },
                  ],
                  missing_scenarios: [],
                  summary: "1 candidate reviewed",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 300, completion_tokens: 100 },
        };
      };

      const originalSteps = ["goto /products", "click #save-btn", "expect text Product Catalog"];
      const results = await reviewCandidateBatch({
        projectId: testProjectId,
        candidates: [
          {
            title: "Original Gemini Title",
            description: "Initial description",
            steps: originalSteps,
            expected_result: "Catalog visible",
          },
        ],
        evidence: sampleEvidence,
      });

      querySpy.mockRestore();

      expect(results).toHaveLength(1);
      const tc = results[0];
      expect(tc.ai_review_metadata.review_status).toBe("reviewed");
      // Correction must be rejected because #hallucinated-selector is not in crawler DOM
      expect(tc.ai_review_metadata.corrections_applied).toBe(false);
      expect(tc.title).toBe("Original Gemini Title");
      expect(tc.steps).toEqual(originalSteps);
      expect(tc.ai_review_metadata.issues.some((i) => i.includes("Groq corrections rejected"))).toBe(true);
    });

    it("should capture unanchored Groq missing scenarios as unsupported suggestions", async () => {
      const encryptedKey = encryptSecret("mock-groq-key-12345");
      const querySpy = vi.spyOn(pool, "query").mockImplementation(async (sql: any) => {
        if (typeof sql === "string" && sql.includes("FROM project_ai_configurations")) {
          return {
            rowCount: 1,
            rows: [
              {
                provider: "gemini",
                model: "gemini-2.5-flash",
                api_key_enc: null,
                base_url: null,
                two_stage_review_enabled: true,
                review_model: "openai/gpt-oss-120b",
              },
            ],
          } as any;
        }
        if (typeof sql === "string" && sql.includes("FROM project_ai_provider_credentials")) {
          return {
            rowCount: 1,
            rows: [{ provider: "groq", api_key_enc: encryptedKey }],
          } as any;
        }
        return { rowCount: 0, rows: [] } as any;
      });

      mockGroq.createHandler = async (params: any) => {
        const rawPrompt = params.messages[1].content;
        const parsedPrompt = JSON.parse(
          rawPrompt.split("<CANDIDATE_TEST_CASES>\n")[1].split("\n</CANDIDATE_TEST_CASES>")[0],
        );
        const candId = parsedPrompt[0].candidate_id;
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  candidate_reviews: [
                    {
                      candidate_id: candId,
                      verdict: "approved",
                      issues: [],
                      reason: "Good coverage",
                      confidence: 1.0,
                    },
                  ],
                  missing_scenarios: [
                    {
                      title: "Test Delete Product Modal",
                      category: "negative",
                      priority: "high",
                      evidence_anchor: "#delete-modal-button", // NOT IN EVIDENCE
                      reason: "Should test product deletion",
                    },
                  ],
                  summary: "Approved with missing scenario suggestion",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 300, completion_tokens: 100 },
        };
      };

      const results = await reviewCandidateBatch({
        projectId: testProjectId,
        candidates: [
          {
            title: "Original Test",
            description: "Initial description",
            steps: ["goto /products", "click #save-btn", "expect text Product Catalog"],
            expected_result: "Catalog visible",
          },
        ],
        evidence: sampleEvidence,
      });

      querySpy.mockRestore();

      expect(results).toHaveLength(1);
      const metadata = results[0].ai_review_metadata;
      expect(metadata.review_status).toBe("reviewed");
      expect(metadata.evidence_validation?.unsupported_suggestions).toBeDefined();
      expect(metadata.evidence_validation?.unsupported_suggestions.length).toBeGreaterThan(0);
      expect(metadata.evidence_validation?.unsupported_suggestions[0]).toContain(
        "evidence anchor \"#delete-modal-button\" was not found",
      );
    });

    it("should fallback gracefully to Gemini candidates when Groq API throws an error", async () => {
      const encryptedKey = encryptSecret("mock-groq-key-12345");
      const querySpy = vi.spyOn(pool, "query").mockImplementation(async (sql: any) => {
        if (typeof sql === "string" && sql.includes("FROM project_ai_configurations")) {
          return {
            rowCount: 1,
            rows: [
              {
                provider: "gemini",
                model: "gemini-2.5-flash",
                api_key_enc: null,
                base_url: null,
                two_stage_review_enabled: true,
                review_model: "openai/gpt-oss-120b",
              },
            ],
          } as any;
        }
        if (typeof sql === "string" && sql.includes("FROM project_ai_provider_credentials")) {
          return {
            rowCount: 1,
            rows: [{ provider: "groq", api_key_enc: encryptedKey }],
          } as any;
        }
        return { rowCount: 0, rows: [] } as any;
      });

      mockGroq.errorToThrow = new Error("Rate limit reached for model openai/gpt-oss-120b");
      (mockGroq.errorToThrow as any).status = 429;

      const candidates = [
        {
          title: "Standard Test Case",
          description: "Verify flow",
          steps: ["goto /products", "click #save-btn", "expect text Product Catalog"],
          expected_result: "Product catalog displayed",
        },
      ];

      const results = await reviewCandidateBatch({
        projectId: testProjectId,
        candidates,
        evidence: sampleEvidence,
      });

      querySpy.mockRestore();

      expect(results).toHaveLength(1);
      expect(results[0].ai_review_metadata.review_status).toBe("incomplete");
      expect(results[0].ai_review_metadata.fallback_to_primary).toBe(true);
      expect(results[0].ai_review_metadata.review_error).toContain("Rate limit reached");
      expect(results[0].title).toBe("Standard Test Case");
    });
  });

  // 4. Provider Credentials Schema Check: Ollama nullable check
  describe("Project AI Provider Credentials Architecture", () => {
    it("should allow encrypting and decrypting separate provider API keys", () => {
      const geminiKey = "AIzaSyGeminiKey123";
      const groqKey = "gsk_GroqReviewerKey456";

      const encGemini = encryptSecret(geminiKey);
      const encGroq = encryptSecret(groqKey);

      expect(encGemini).not.toBe(encGroq);
      expect(decryptSecret(encGemini)).toBe(geminiKey);
      expect(decryptSecret(encGroq)).toBe(groqKey);
    });

    it("should verify check constraint in project_ai_provider_credentials table", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const projRes = await client.query<{ id: string }>(
          `INSERT INTO projects (name, base_url) VALUES ('Cred Test Proj', 'http://localhost:3000') RETURNING id`,
        );
        const pId = projRes.rows[0].id;

        // 1. Ollama with NULL api_key_enc should SUCCEED
        const ollamaRes = await client.query(
          `INSERT INTO project_ai_provider_credentials (project_id, provider, api_key_enc)
           VALUES ($1, 'ollama', NULL) RETURNING id`,
          [pId],
        );
        expect(ollamaRes.rowCount).toBe(1);

        // 2. Groq with valid encrypted key should SUCCEED
        const groqRes = await client.query(
          `INSERT INTO project_ai_provider_credentials (project_id, provider, api_key_enc)
           VALUES ($1, 'groq', $2) RETURNING id`,
          [pId, encryptSecret("gsk_test_key")],
        );
        expect(groqRes.rowCount).toBe(1);

        // 3. Groq with NULL api_key_enc should FAIL check constraint
        let threwCheck = false;
        try {
          await client.query(
            `INSERT INTO project_ai_provider_credentials (project_id, provider, api_key_enc)
             VALUES ($1, 'groq', NULL)`,
            [pId],
          );
        } catch (err: any) {
          threwCheck = err.message.includes("chk_provider_key");
        }
        expect(threwCheck).toBe(true);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  });
});
