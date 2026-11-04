import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { pool } from "../config/db";
import {
  classifyTestType,
  validateAutomationInstructions,
  generateFallbackAutomation,
  convertTestCaseToAutomation,
  AutomationValidationError,
} from "../services/automationConverter";
import automationRoutes from "../routes/automation";
import { createAuthHook } from "../services/auth";
import { AccessDeniedError } from "../services/authService";
import { callGeminiWithRetry } from "../services/generator";
import * as runnerModule from "../services/runner";
import * as apiRunnerModule from "../services/apiRunner";

vi.mock("../config/db", () => ({
  pool: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}));

vi.mock("../services/generator", () => ({
  callGeminiWithRetry: vi.fn(),
  isRetryableGeminiError: vi.fn().mockReturnValue(false),
}));

const mockedCallGemini = vi.mocked(callGeminiWithRetry);

describe("TASK 7: Automated Execution of AI-Generated Test Cases", () => {
  const testProjectId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const testCaseId = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380b22";
  const automationId = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380c33";
  const validApiKey = "test-platform-key";

  describe("Classification & Instruction Validation", () => {
    it("correctly identifies Web UI vs API test cases", () => {
      const webCase = {
        title: "User clicks login button and fills password",
        steps: ["Navigate to /login", "Enter credentials", "Click Sign In button"],
        expected_result: "Redirect to dashboard and see welcome banner",
      };
      expect(classifyTestType(webCase)).toBe("web");

      const apiCase = {
        title: "GET /api/v1/products returns 200 OK with product list",
        steps: ["Send GET request to /api/v1/products", "Check response headers"],
        expected_result: "HTTP status code 200 with JSON array of products",
      };
      expect(classifyTestType(apiCase)).toBe("api");
    });

    it("validates compliant Web UI automation steps", () => {
      const validWeb = {
        target_type: "web" as const,
        web_steps: [
          "goto /login",
          "fill input[name=\"email\"] | user@example.com",
          "fill input[name=\"password\"] | {{APP_PASSWORD}}",
          "click button[type=\"submit\"]",
          "expect visible .dashboard",
          "expect text Welcome",
        ],
      };
      const result = validateAutomationInstructions(validWeb);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("rejects non-compliant or dangerous Web UI automation instructions", () => {
      const invalidWeb = {
        target_type: "web" as const,
        web_steps: [
          "goto /login",
          "execute javascript:alert(1)",
          "eval('require(\"child_process\").exec(\"dir\")')",
          "random_unknown_command foo",
        ],
      };
      const result = validateAutomationInstructions(invalidWeb);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes("Invalid or forbidden step instruction"))).toBe(true);
    });

    it("validates compliant API automation configuration", () => {
      const validApi = {
        target_type: "api" as const,
        api_method: "POST" as const,
        api_path: "/api/v1/items",
        api_headers: { "Content-Type": "application/json" },
        api_body: { name: "Gadget", price: 99 },
        api_expected_status: 201,
        api_expected_fields: { id: "string" as const, name: "string" as const },
      };
      const result = validateAutomationInstructions(validApi);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("rejects invalid API automation instructions", () => {
      const invalidApi = {
        target_type: "api" as const,
        api_method: "INVALID_METHOD" as any,
        api_path: "",
        api_expected_status: 999,
      };
      const result = validateAutomationInstructions(invalidApi);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("generates deterministic fallback automation when AI is offline", () => {
      const fallbackWeb = generateFallbackAutomation(
        {
          title: "User clicks submit on contact form",
          steps: ["Open /contact", "Fill input", "Click submit"],
          expected_result: "Thank you message displayed",
        },
        "web",
      );
      expect(fallbackWeb.target_type).toBe("web");
      if (fallbackWeb.target_type === "web") {
        expect(fallbackWeb.web_steps.length).toBeGreaterThan(0);
        expect(validateAutomationInstructions(fallbackWeb).valid).toBe(true);
      }

      const fallbackApi = generateFallbackAutomation(
        {
          title: "POST /api/orders creates new order",
          steps: ["POST /api/orders with order payload"],
          expected_result: "201 Created",
        },
        "api",
      );
      expect(fallbackApi.target_type).toBe("api");
      if (fallbackApi.target_type === "api") {
        expect(fallbackApi.api_method).toBe("POST");
        expect(fallbackApi.api_expected_status).toBe(201);
        expect(validateAutomationInstructions(fallbackApi).valid).toBe(true);
      }
    });
  });

  describe("Gemini AI Test Case Conversion", () => {
    it("converts test case to Web UI automation with Gemini response", async () => {
      mockedCallGemini.mockResolvedValueOnce(
        JSON.stringify({
          target_type: "web",
          web_steps: [
            "goto /inventory",
            "fill #search-box | Laptop",
            "click #search-btn",
            "expect text Results for Laptop",
          ],
          confidence: 0.98,
          reasoning: "User interface interaction with search form and table results.",
        }),
      );

      const result = await convertTestCaseToAutomation(
        {
          title: "Search inventory item by keyword",
          steps: ["Navigate to /inventory", "Enter Laptop into search", "Click Search"],
          expected_result: "Inventory displays matching items",
          test_type: "positive",
        },
        { name: "StockFlow", base_url: "https://stockflow.example.com" },
      );

      expect(result.target_type).toBe("web");
      if (result.target_type === "web") {
        expect(result.web_steps).toContain("goto /inventory");
        expect(result.web_steps).toContain("click #search-btn");
      }
    });

    it("converts test case to API automation with Gemini response", async () => {
      mockedCallGemini.mockResolvedValueOnce(
        JSON.stringify({
          target_type: "api",
          api_method: "POST",
          api_path: "/api/v1/auth/login",
          api_headers: { "Content-Type": "application/json" },
          api_body: { username: "admin", password: "{{APP_PASSWORD}}" },
          api_expected_status: 200,
          api_expected_fields: { token: "string" },
          api_max_response_ms: 3000,
          confidence: 0.95,
          reasoning: "REST API login endpoint returning auth token.",
        }),
      );

      const result = await convertTestCaseToAutomation(
        {
          title: "API login authentication",
          steps: ["Send POST request to /api/v1/auth/login with valid credentials"],
          expected_result: "Status 200 with JWT token in response body",
          test_type: "positive",
        },
        { name: "StockFlow", base_url: "https://stockflow.example.com" },
      );

      expect(result.target_type).toBe("api");
      if (result.target_type === "api") {
        expect(result.api_method).toBe("POST");
        expect(result.api_path).toBe("/api/v1/auth/login");
        expect(result.api_expected_status).toBe(200);
      }
    });
  });

  describe("Automation HTTP Endpoints & Execution", () => {
    let app: FastifyInstance;

    beforeEach(async () => {
      vi.clearAllMocks();
      app = Fastify();
      app.setErrorHandler((error, _request, reply) => {
        if (error instanceof AccessDeniedError || (error as any).statusCode === 403) {
          return reply.code(403).send({ error: error.message });
        }
        reply.code((error as any).statusCode || 500).send({ error: error.message });
      });

      app.register(cookie);
      app.addHook("onRequest", createAuthHook(validApiKey));
      app.register(automationRoutes);
      await app.ready();
    });

    afterEach(async () => {
      await app.close();
    });

    it("requires authentication for automation endpoints", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/projects/${testProjectId}/automations/generate`,
        payload: { testCaseIds: [testCaseId] },
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects conversion of unapproved test cases (Requirement 1)", async () => {
      // Mock project query
      vi.mocked(pool.query).mockImplementation(async (sql: string) => {
        if (sql.includes("FROM projects WHERE id = $1")) {
          return { rowCount: 1, rows: [{ id: testProjectId, name: "StockFlow", base_url: "https://example.com" }] } as any;
        }
        if (sql.includes("FROM test_cases") && sql.includes("project_id = $1")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: testCaseId,
                title: "Draft Test Case",
                steps: ["Step 1"],
                review_status: "pending", // Unapproved!
              },
            ],
          } as any;
        }
        return { rowCount: 0, rows: [] } as any;
      });

      const res = await app.inject({
        method: "POST",
        url: `/projects/${testProjectId}/automations/generate`,
        headers: { "x-api-key": validApiKey },
        payload: { testCaseIds: [testCaseId] },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("must be approved before generating automation");
    });

    it("successfully generates automation for approved test case (QA Engineer)", async () => {
      vi.mocked(pool.query).mockImplementation(async (sql: string) => {
        if (sql.includes("FROM projects WHERE id = $1")) {
          return { rowCount: 1, rows: [{ id: testProjectId, name: "StockFlow", base_url: "https://example.com" }] } as any;
        }
        if (sql.includes("FROM test_cases") && sql.includes("project_id = $1")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: testCaseId,
                title: "Approved Web Test",
                description: "User profile update",
                steps: ["goto /profile", "click #save-btn"],
                expected_result: "Profile saved",
                review_status: "approved",
                requirement_doc_id: "doc-1",
              },
            ],
          } as any;
        }
        if (sql.includes("INSERT INTO test_case_automations")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: automationId,
                project_id: testProjectId,
                test_case_id: testCaseId,
                target_type: "web",
                status: "ready",
                web_steps: ["goto /profile", "click #save-btn", "expect text Profile saved"],
                confidence: 0.95,
              },
            ],
          } as any;
        }
        return { rowCount: 0, rows: [] } as any;
      });

      mockedCallGemini.mockResolvedValueOnce(
        JSON.stringify({
          target_type: "web",
          web_steps: ["goto /profile", "click #save-btn", "expect text Profile saved"],
          confidence: 0.95,
          reasoning: "Web profile form submission",
        }),
      );

      const res = await app.inject({
        method: "POST",
        url: `/projects/${testProjectId}/automations/generate`,
        headers: { "x-api-key": validApiKey },
        payload: { testCaseIds: [testCaseId] },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().generated_count).toBe(1);
      expect(res.json().automations[0].target_type).toBe("web");
    });

    it("allows reviewing and editing automation steps before execution (Requirement 8)", async () => {
      vi.mocked(pool.query).mockImplementation(async (sql: string) => {
        if (sql.includes("SELECT project_id, target_type FROM test_case_automations")) {
          return { rowCount: 1, rows: [{ project_id: testProjectId, target_type: "web" }] } as any;
        }
        if (sql.includes("UPDATE test_case_automations SET")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: automationId,
                project_id: testProjectId,
                target_type: "web",
                status: "ready",
                web_steps: ["goto /login", "fill input[name='email'] | custom@example.com", "click button"],
              },
            ],
          } as any;
        }
        return { rowCount: 0, rows: [] } as any;
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/automations/${automationId}`,
        headers: { "x-api-key": validApiKey },
        payload: {
          web_steps: ["goto /login", "fill input[name='email'] | custom@example.com", "click button"],
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().web_steps).toHaveLength(3);
    });

    it("rejects malicious step injection during editing (Requirement 7)", async () => {
      vi.mocked(pool.query).mockImplementation(async (sql: string) => {
        if (sql.includes("SELECT project_id, target_type FROM test_case_automations")) {
          return { rowCount: 1, rows: [{ project_id: testProjectId, target_type: "web" }] } as any;
        }
        return { rowCount: 0, rows: [] } as any;
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/automations/${automationId}`,
        headers: { "x-api-key": validApiKey },
        payload: {
          web_steps: ["goto /login", "eval('process.exit(1)')"],
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("Web automation instruction error");
    });

    it("executes automated Web UI test and records evidence (Requirement 9 & 10)", async () => {
      vi.mocked(pool.query).mockImplementation(async (sql: string) => {
        if (sql.includes("FROM test_case_automations a")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: automationId,
                project_id: testProjectId,
                test_case_id: testCaseId,
                target_type: "web",
                status: "ready",
                web_steps: ["goto /test", "click #btn"],
                base_url: "https://stockflow.example.com",
                project_name: "StockFlow",
                requirement_doc_id: "doc-1",
                test_case_title: "Test Web UI",
              },
            ],
          } as any;
        }
        return { rowCount: 1, rows: [] } as any;
      });

      vi.spyOn(runnerModule, "runTestCase").mockResolvedValueOnce({
        status: "passed",
        durationMs: 450,
        screenshotPath: "artifacts/runs/r1/res1/screenshot.png",
        tracePath: "artifacts/runs/r1/res1/trace.zip",
        evidence: {
          status: "passed",
          durationMs: 450,
          failureStep: null,
          failureStepIndex: null,
          errorMessage: null,
          browserErrors: [],
          failedRequests: [],
          httpErrors: [],
          finalUrl: "https://stockflow.example.com/test",
          finalTitle: "Test Page",
          screenshotPath: "screenshot.png",
          tracePath: "trace.zip",
          traceNote: null,
          evidencePath: "evidence.json",
        },
      });

      const res = await app.inject({
        method: "POST",
        url: `/automations/${automationId}/run`,
        headers: { "x-api-key": validApiKey },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.status).toBe("passed");
      expect(json.target_type).toBe("web");
      expect(json.duration_ms).toBe(450);
      expect(json.screenshot_path).toBeTruthy();
    });

    it("executes automated API test and records status and response (Requirement 9 & 10)", async () => {
      vi.mocked(pool.query).mockImplementation(async (sql: string) => {
        if (sql.includes("FROM test_case_automations a")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: automationId,
                project_id: testProjectId,
                test_case_id: testCaseId,
                target_type: "api",
                status: "ready",
                api_method: "GET",
                api_path: "/api/v1/health",
                api_headers: {},
                api_body: null,
                api_expected_status: 200,
                base_url: "https://stockflow.example.com",
                project_name: "StockFlow",
                requirement_doc_id: "doc-1",
                test_case_title: "Test API Health",
              },
            ],
          } as any;
        }
        return { rowCount: 1, rows: [] } as any;
      });

      vi.spyOn(apiRunnerModule, "runApiTest").mockResolvedValueOnce({
        status: "passed",
        actualStatus: 200,
        responseMs: 85,
        errorMessage: null,
        responseSnippet: '{"status":"ok"}',
      });

      const res = await app.inject({
        method: "POST",
        url: `/automations/${automationId}/run`,
        headers: { "x-api-key": validApiKey },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.status).toBe("passed");
      expect(json.target_type).toBe("api");
      expect(json.actual_status).toBe(200);
      expect(json.expected_status).toBe(200);
    });
  });
});
