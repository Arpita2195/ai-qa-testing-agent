import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { pool } from "../config/db";
import {
  discoverPageFunctionalities,
  planScenariosForFunctionality,
  persistFunctionalitiesAndScenarios,
  getProjectFunctionalities,
  getProjectScenarios,
  calculateCoverage,
  type DiscoveredFunctionality,
  type PlannedScenario,
} from "../services/functionalityPlanner";
import { runLoopGeneration, extractJsonArray, withProjectGenerationLock } from "../services/loopGenerator";
import { initializeJobHandlers } from "../services/jobs/jobHandlers";
import { getJobHandler } from "../services/jobs/jobQueue";
import generateRoutes from "../routes/generate";
import type { PageData, SiteData } from "../services/pageReader";

// Hoist mock state for @google/genai
const mockedAi = vi.hoisted(() => ({
  responseText: "",
  callCount: 0,
  error: null as Error | null,
}));

const mockDbClient = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async () => {
        mockedAi.callCount++;
        if (mockedAi.error) throw mockedAi.error;
        return { text: mockedAi.responseText };
      },
    };
    constructor(_options: { apiKey: string }) {}
  },
}));

vi.mock("../config/db", () => ({
  pool: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}));

vi.mock("../services/pageReader", () => ({
  readSite: vi.fn(),
}));

vi.mock("../services/rateLimiter", () => ({
  checkGenerateRateLimit: vi.fn().mockReturnValue({ allowed: true, retryAfterSeconds: 0 }),
}));

vi.mock("../services/observability/metricsService", () => ({
  recordAiUsage: vi.fn().mockResolvedValue(undefined),
  calculateEstimatedCostUsd: vi.fn().mockReturnValue(0.0001),
  inMemoryMetrics: {
    trackTestExecution: vi.fn(),
  },
}));

describe("Stage 1: Functionality Inventory, Scenario Planning & Loop Generation", () => {
  const projectId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const mockedPool = vi.mocked(pool);

  beforeEach(() => {
    vi.clearAllMocks();
    mockedAi.callCount = 0;
    mockedAi.error = null;
    mockedAi.responseText = "";
    mockDbClient.release.mockClear();
    mockDbClient.query.mockReset();
    mockDbClient.query.mockImplementation(async (...args: any[]) => (pool.query as any)(...args));
    vi.mocked(pool.connect).mockResolvedValue(mockDbClient as any);
  });

  describe("1. Functionality Discovery (discoverPageFunctionalities)", () => {
    it("identifies authentication functionality when password input is present", () => {
      const page: PageData = {
        title: "Login Page",
        url: "https://example.test/login",
        path: "/login",
        headings: ["Sign In"],
        text: "Please enter your email and password to log in.",
        elements: [
          { tag: "input", type: "email", selector: "#email", name: "email", text: "Email" },
          { tag: "input", type: "password", selector: "#password", name: "password", text: "Password" },
          { tag: "button", type: "submit", selector: "#login-btn", text: "Sign In" },
        ],
      };

      const funcs = discoverPageFunctionalities(page, projectId);
      const authFunc = funcs.find((f) => f.category === "authentication");

      expect(authFunc).toBeDefined();
      expect(authFunc?.name).toContain("Authentication on /login");
      expect(authFunc?.interactionDetails.actionType).toBe("login");
      expect(authFunc?.elements.some((el) => el.type === "password")).toBe(true);
    });

    it("identifies search & filtering controls", () => {
      const page: PageData = {
        title: "Products Catalog",
        url: "https://example.test/products",
        path: "/products",
        headings: ["Product List"],
        text: "Browse and filter inventory items",
        elements: [
          { tag: "input", type: "text", selector: "#search-input", name: "search", placeholder: "Search items..." },
          { tag: "select", selector: "#category-select", options: ["All", "Electronics", "Books"] },
          { tag: "button", selector: "#filter-btn", text: "Apply Filter" },
        ],
      };

      const funcs = discoverPageFunctionalities(page, projectId);
      const searchFunc = funcs.find((f) => f.category === "search_filter");

      expect(searchFunc).toBeDefined();
      expect(searchFunc?.category).toBe("search_filter");
      expect(searchFunc?.elements.length).toBe(3);
    });

    it("identifies CRUD form submission feature", () => {
      const page: PageData = {
        title: "Add Product",
        url: "https://example.test/products/new",
        path: "/products/new",
        headings: ["Create New Item"],
        text: "Enter product details and price",
        elements: [
          { tag: "input", type: "text", selector: "#item-name", name: "name" },
          { tag: "input", type: "number", selector: "#item-price", name: "price" },
          { tag: "textarea", selector: "#item-desc", name: "description" },
          { tag: "button", type: "submit", selector: "#save-btn", text: "Save Product" },
        ],
      };

      const funcs = discoverPageFunctionalities(page, projectId);
      const crudFunc = funcs.find((f) => f.category === "crud");

      expect(crudFunc).toBeDefined();
      expect(crudFunc?.category).toBe("crud");
      expect(crudFunc?.interactionDetails.submitSelector).toBe("#save-btn");
    });

    it("identifies navigation links and interactive tabs", () => {
      const page: PageData = {
        title: "Dashboard",
        url: "https://example.test/dashboard",
        path: "/dashboard",
        headings: ["Overview"],
        text: "Navigation menu",
        elements: [
          { tag: "a", href: "/orders", text: "Orders", selector: "a#nav-orders" },
          { tag: "a", href: "/settings", text: "Settings", selector: "a#nav-settings" },
        ],
      };

      const funcs = discoverPageFunctionalities(page, projectId);
      const navFunc = funcs.find((f) => f.category === "navigation");

      expect(navFunc).toBeDefined();
      expect(navFunc?.category).toBe("navigation");
      expect(navFunc?.elements.length).toBe(2);
    });

    it("defaults to data_display when no interactive controls are found", () => {
      const page: PageData = {
        title: "About Us",
        url: "https://example.test/about",
        path: "/about",
        headings: ["Company History"],
        text: "We are an innovative company...",
        elements: [],
      };

      const funcs = discoverPageFunctionalities(page, projectId);
      expect(funcs.length).toBe(1);
      expect(funcs[0].category).toBe("data_display");
    });
  });

  describe("2. Scenario Planning (planScenariosForFunctionality)", () => {
    it("generates positive, negative, boundary, and edge_case scenarios for authentication", () => {
      const func: DiscoveredFunctionality = {
        id: "func-auth-1",
        projectId,
        name: "User Authentication on /login",
        category: "authentication",
        pageUrl: "https://example.test/login",
        pagePath: "/login",
        elements: [{ tag: "input", type: "password", selector: "#password" }],
        interactionDetails: { actionType: "login" },
        status: "discovered",
      };

      const scenarios = planScenariosForFunctionality(func);

      const positive = scenarios.filter((s) => s.category === "positive");
      const negative = scenarios.filter((s) => s.category === "negative");
      const boundary = scenarios.filter((s) => s.category === "boundary");
      const edgeCase = scenarios.filter((s) => s.category === "edge_case");

      expect(positive.length).toBeGreaterThanOrEqual(1);
      expect(negative.length).toBeGreaterThanOrEqual(2);
      expect(boundary.length).toBeGreaterThanOrEqual(1);
      expect(edgeCase.length).toBeGreaterThanOrEqual(1);

      expect(scenarios.every((s) => s.scenarioId.startsWith("SCEN-"))).toBe(true);
      expect(scenarios.every((s) => s.status === "planned")).toBe(true);
      expect(positive[0].priority).toBe("critical");
    });

    it("generates multi-category scenarios for CRUD form submissions", () => {
      const func: DiscoveredFunctionality = {
        id: "func-crud-1",
        projectId,
        name: "Data Submission Form on /items/new",
        category: "crud",
        pageUrl: "https://example.test/items/new",
        pagePath: "/items/new",
        elements: [{ tag: "button", text: "Save" }],
        interactionDetails: { actionType: "form_submission" },
        status: "discovered",
      };

      const scenarios = planScenariosForFunctionality(func);

      expect(scenarios.some((s) => s.category === "positive")).toBe(true);
      expect(scenarios.some((s) => s.category === "negative")).toBe(true);
      expect(scenarios.some((s) => s.category === "boundary")).toBe(true);
      expect(scenarios.some((s) => s.category === "edge_case")).toBe(true);
    });
  });

  describe("3. Database Persistence and Coverage (persist, get, calculateCoverage)", () => {
    it("persists functionalities and scenarios using ON CONFLICT queries", async () => {
      mockedPool.query.mockResolvedValue({ rowCount: 1, rows: [{ id: "saved-id" }] } as any);

      const funcs: DiscoveredFunctionality[] = [
        {
          id: "func-1",
          projectId,
          name: "Search Items",
          category: "search_filter",
          pageUrl: "https://example.test/search",
          pagePath: "/search",
          elements: [],
          interactionDetails: {},
          status: "discovered",
        },
      ];

      const scenarios: PlannedScenario[] = [
        {
          scenarioId: "SCEN-SRCH-POS-01",
          functionalityId: "func-1",
          projectId,
          title: "Standard search",
          description: "Search works",
          category: "positive",
          priority: "high",
          expectedBehavior: "Results displayed",
          status: "planned",
        },
      ];

      const result = await persistFunctionalitiesAndScenarios(projectId, funcs, scenarios);

      expect(result.savedFunctionalities).toBe(1);
      expect(result.savedScenarios).toBe(1);
      expect(mockedPool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO functionality_inventory"),
        expect.any(Array),
      );
      expect(mockedPool.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO scenario_checklists"),
        expect.any(Array),
      );
    });

    it("calculates deterministic coverage statistics across scenario categories", async () => {
      mockedPool.query
        .mockResolvedValueOnce({ rows: [{ total: 2 }] } as any) // total functionalities
        .mockResolvedValueOnce({
          rows: [
            { category: "positive", status: "generated", count: 2 },
            { category: "positive", status: "planned", count: 1 },
            { category: "negative", status: "generated", count: 2 },
            { category: "negative", status: "planned", count: 2 },
            { category: "boundary", status: "planned", count: 2 },
            { category: "edge_case", status: "generated", count: 1 },
          ],
        } as any);

      const report = await calculateCoverage(projectId);

      expect(report.totalFunctionalities).toBe(2);
      expect(report.totalScenariosPlanned).toBe(10); // 3 pos + 4 neg + 2 bnd + 1 edg = 10
      expect(report.totalScenariosGenerated).toBe(5); // 2 pos + 2 neg + 0 bnd + 1 edg = 5
      expect(report.totalScenariosMissing).toBe(5);
      expect(report.overallCoveragePercent).toBe(50.0);
      expect(report.byCategory.positive.percent).toBeCloseTo(66.7, 1);
      expect(report.byCategory.boundary.percent).toBe(0);
      expect(report.byCategory.edge_case.percent).toBe(100);
    });
  });

  describe("4. Loop-Based Generation Engine (runLoopGeneration)", () => {
    const siteData: SiteData = {
      isLoggedIn: false,
      loginSteps: [],
      pages: [
        {
          title: "Inventory Search",
          url: "https://example.test/inventory",
          path: "/inventory",
          headings: ["Inventory Management"],
          text: "Search inventory items and filter status",
          elements: [
            { tag: "input", type: "text", selector: "#search-box", name: "q", placeholder: "Search..." },
            { tag: "button", selector: "#search-submit", text: "Search" },
          ],
        },
      ],
    };

    it("generates test cases in Pending review status and links them to scenarios", async () => {
      // Return planned scenarios from database query
      mockedPool.query.mockImplementation(async (sql: any) => {
        const queryStr = String(sql);
        if (queryStr.includes("SELECT title, scenario_id FROM test_cases")) {
          return { rows: [] } as any;
        }
        if (queryStr.includes("INSERT INTO test_cases")) {
          return {
            rows: [
              {
                id: "tc-uuid-1",
                title: "Verify standard search displays results",
                review_status: "pending", // Always pending
              },
            ],
          } as any;
        }
        if (queryStr.includes("UPDATE scenario_checklists")) {
          return { rowCount: 1 } as any;
        }
        if (queryStr.includes("UPDATE functionality_inventory")) {
          return { rowCount: 1 } as any;
        }
        return { rowCount: 1, rows: [] } as any;
      });

      // Mock AI response
      mockedAi.responseText = JSON.stringify([
        {
          title: "Verify standard search displays results",
          description: "Search with valid query",
          scenario_id: "SCEN-SEARCH-FILTERING-ON-POS-01",
          category: "positive",
          priority: "high",
          steps: [
            "goto /inventory",
            "fill #search-box | Widget",
            "click #search-submit",
            "expect text Search inventory items",
          ],
          expected_result: "Search results are displayed correctly",
        },
      ]);

      const result = await runLoopGeneration(siteData, {
        projectId,
        appName: "InventoryApp",
        maxRetriesPerFunctionality: 1,
      });

      expect(result.createdTestCases.length).toBe(1);
      expect(result.createdTestCases[0].review_status).toBe("pending");
      expect(result.createdTestCases[0].title).toBe("Verify standard search displays results");
      expect(result.totalFunctionalities).toBe(1);
      expect(result.completedFunctionalities).toBe(1);

      // Verify incremental database save had review_status = 'pending'
      const insertCall = mockedPool.query.mock.calls.find((call) =>
        String(call[0]).includes("INSERT INTO test_cases"),
      );
      expect(insertCall).toBeDefined();
      expect(String(insertCall?.[0])).toContain("'pending'");
    });

    it("skips duplicate test cases when title already exists in project", async () => {
      mockedPool.query.mockImplementation(async (sql: any) => {
        const queryStr = String(sql);
        if (queryStr.includes("SELECT title, scenario_id FROM test_cases")) {
          return {
            rows: [{ title: "Existing duplicate title", scenario_id: "SCEN-EXISTING" }],
          } as any;
        }
        return { rowCount: 1, rows: [] } as any;
      });

      mockedAi.responseText = JSON.stringify([
        {
          title: "Existing Duplicate Title", // Case-insensitive duplicate
          description: "Duplicate",
          steps: ["goto /inventory", "expect text Search inventory items"],
          expected_result: "Result",
        },
      ]);

      const result = await runLoopGeneration(siteData, {
        projectId,
        appName: "InventoryApp",
      });

      expect(result.skippedDuplicates).toBe(1);
      expect(result.createdTestCases.length).toBe(0);
    });

    it("skips invalid test cases that fail DOM selector or step validation", async () => {
      mockedPool.query.mockImplementation(async (sql: any) => {
        const queryStr = String(sql);
        if (queryStr.includes("SELECT title, scenario_id FROM test_cases")) {
          return { rows: [] } as any;
        }
        return { rowCount: 1, rows: [] } as any;
      });

      mockedAi.responseText = JSON.stringify([
        {
          title: "Invalid selector case",
          description: "Uses nonexistent selector",
          steps: [
            "goto /inventory",
            "click #nonexistent-button-selector", // Absent from DOM
            "expect text Search inventory items",
          ],
          expected_result: "Fails validation",
        },
      ]);

      const result = await runLoopGeneration(siteData, {
        projectId,
        appName: "InventoryApp",
      });

      expect(result.skippedInvalid).toBe(1);
      expect(result.createdTestCases.length).toBe(0);
    });

    it("supports resumable execution by loading existing inventory and skipping generated scenarios", async () => {
      const existingFuncs: DiscoveredFunctionality[] = [
        {
          id: "func-done-1",
          projectId,
          name: "Search Functionality",
          category: "search_filter",
          pageUrl: "https://example.test/inventory",
          pagePath: "/inventory",
          elements: [
            { tag: "input", type: "text", selector: "#search-box", name: "q" },
            { tag: "button", selector: "#search-submit", text: "Search" },
          ],
          interactionDetails: {},
          status: "completed",
        },
      ];

      const existingScenarios: PlannedScenario[] = [
        {
          scenarioId: "SCEN-DONE-01",
          functionalityId: "func-done-1",
          projectId,
          title: "Already generated scenario",
          description: "Already exists",
          category: "positive",
          priority: "high",
          expectedBehavior: "Done",
          status: "generated", // Already completed
        },
      ];

      mockedPool.query.mockImplementation(async (sql: any) => {
        const queryStr = String(sql);
        if (queryStr.includes("FROM functionality_inventory")) {
          return { rows: existingFuncs } as any;
        }
        if (queryStr.includes("FROM scenario_checklists")) {
          return { rows: existingScenarios } as any;
        }
        if (queryStr.includes("SELECT title, scenario_id FROM test_cases")) {
          return { rows: [{ title: "Already generated scenario", scenario_id: "SCEN-DONE-01" }] } as any;
        }
        return { rowCount: 1, rows: [] } as any;
      });

      const result = await runLoopGeneration(siteData, {
        projectId,
        resume: true,
      });

      expect(result.completedFunctionalities).toBe(1);
      expect(result.totalScenariosGenerated).toBe(1);
      expect(mockedAi.callCount).toBe(0); // AI was never called because all scenarios were already generated!
    });
  });

  describe("5. Route Integration (generateRoutes)", () => {
    it("handles POST /projects/:projectId/generate with loop: true", async () => {
      const app = Fastify();
      await app.register(generateRoutes);

      mockedPool.query.mockImplementation(async (sql: any) => {
        const queryStr = String(sql);
        if (queryStr.includes("SELECT id, name, base_url FROM projects")) {
          return {
            rows: [{ id: projectId, name: "StockFlow", base_url: "https://example.test" }],
          } as any;
        }
        if (queryStr.includes("pg_try_advisory_lock")) {
          return { rows: [{ locked: true }] } as any;
        }
        if (queryStr.includes("SELECT title, scenario_id FROM test_cases")) {
          return { rows: [] } as any;
        }
        if (queryStr.includes("INSERT INTO test_cases")) {
          return {
            rows: [
              {
                id: "tc-uuid-1",
                title: "Verify search on /inventory",
                review_status: "pending",
              },
            ],
          } as any;
        }
        return { rowCount: 1, rows: [] } as any;
      });

      const pageReader = await import("../services/pageReader");
      vi.mocked(pageReader.readSite).mockResolvedValueOnce({
        isLoggedIn: false,
        loginSteps: [],
        pages: [
          {
            title: "Inventory",
            url: "https://example.test/inventory",
            path: "/inventory",
            headings: ["Items"],
            text: "List of items",
            elements: [{ tag: "button", selector: "#btn", text: "Click" }],
          },
        ],
      });

      mockedAi.responseText = JSON.stringify([
        {
          title: "Verify search on /inventory",
          description: "Test description",
          steps: ["goto /inventory", "click #btn", "expect text List of items"],
          expected_result: "Passes",
        },
      ]);

      const response = await app.inject({
        method: "POST",
        url: `/projects/${projectId}/generate`,
        payload: { loop: true },
      });

      expect(response.statusCode).toBe(201);
      const json = response.json();
      expect(json.generation_mode).toBe("loop_based");
      expect(json.created).toBe(1);
      expect(json.test_cases[0].review_status).toBe("pending");
    });

    it("rejects simultaneous generate requests with 409 Conflict when lock is held", async () => {
      const app = Fastify();
      await app.register(generateRoutes);

      mockedPool.query.mockImplementation(async (sql: any) => {
        const queryStr = String(sql);
        if (queryStr.includes("SELECT id, name, base_url FROM projects")) {
          return {
            rows: [{ id: projectId, name: "StockFlow", base_url: "https://example.test" }],
          } as any;
        }
        if (queryStr.includes("pg_try_advisory_lock")) {
          return { rows: [{ locked: false }] } as any; // Lock held by another job
        }
        return { rowCount: 1, rows: [] } as any;
      });

      const response = await app.inject({
        method: "POST",
        url: `/projects/${projectId}/generate`,
        payload: {},
      });

      expect(response.statusCode).toBe(409);
      const json = response.json();
      expect(json.error).toBe("Generation already in progress");
    });

    it("defaults to loop-based generation when empty payload is passed from dashboard", async () => {
      const app = Fastify();
      await app.register(generateRoutes);

      mockedPool.query.mockImplementation(async (sql: any) => {
        const queryStr = String(sql);
        if (queryStr.includes("SELECT id, name, base_url FROM projects")) {
          return {
            rows: [{ id: projectId, name: "StockFlow", base_url: "https://example.test" }],
          } as any;
        }
        if (queryStr.includes("pg_try_advisory_lock")) {
          return { rows: [{ locked: true }] } as any;
        }
        if (queryStr.includes("SELECT title, scenario_id FROM test_cases")) {
          return { rows: [] } as any;
        }
        if (queryStr.includes("INSERT INTO test_cases")) {
          return {
            rows: [
              {
                id: "tc-uuid-default-1",
                title: "Verify items on default flow",
                review_status: "pending",
              },
            ],
          } as any;
        }
        return { rowCount: 1, rows: [] } as any;
      });

      const pageReader = await import("../services/pageReader");
      vi.mocked(pageReader.readSite).mockResolvedValueOnce({
        isLoggedIn: false,
        loginSteps: [],
        pages: [
          {
            title: "Inventory",
            url: "https://example.test/inventory",
            path: "/inventory",
            headings: ["Items"],
            text: "List of items",
            elements: [{ tag: "button", selector: "#btn", text: "Click" }],
          },
        ],
      });

      mockedAi.responseText = JSON.stringify([
        {
          title: "Verify items on default flow",
          description: "Test description",
          steps: ["goto /inventory", "click #btn", "expect text List of items"],
          expected_result: "Passes",
        },
      ]);

      const response = await app.inject({
        method: "POST",
        url: `/projects/${projectId}/generate`,
        payload: {}, // No loop: true explicitly passed
      });

      expect(response.statusCode).toBe(201);
      const json = response.json();
      expect(json.generation_mode).toBe("loop_based");
      expect(json.created).toBe(1);
    });

    it("handles GET /projects/:projectId/functionalities", async () => {
      const app = Fastify();
      await app.register(generateRoutes);

      mockedPool.query.mockImplementation(async (sql: any) => {
        const queryStr = String(sql);
        if (queryStr.includes("SELECT id FROM projects")) {
          return { rows: [{ id: projectId }] } as any;
        }
        if (queryStr.includes("FROM functionality_inventory")) {
          return {
            rows: [
              {
                id: "func-1",
                projectId,
                name: "Login on /login",
                category: "authentication",
                pageUrl: "https://example.test/login",
                pagePath: "/login",
                elements: [],
                interactionDetails: {},
                status: "completed",
              },
            ],
          } as any;
        }
        return { rows: [] } as any;
      });

      const response = await app.inject({
        method: "GET",
        url: `/projects/${projectId}/functionalities`,
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.functionalities.length).toBe(1);
      expect(json.functionalities[0].category).toBe("authentication");
    });

    it("returns 404 for GET /projects/:projectId/functionalities when project does not exist", async () => {
      const app = Fastify();
      await app.register(generateRoutes);

      mockedPool.query.mockResolvedValueOnce({ rows: [] } as any); // Project not found

      const response = await app.inject({
        method: "GET",
        url: `/projects/${projectId}/functionalities`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error).toBe("Project not found");
    });

    it("handles GET /projects/:projectId/coverage", async () => {
      const app = Fastify();
      await app.register(generateRoutes);

      mockedPool.query.mockImplementation(async (sql: any) => {
        const queryStr = String(sql);
        if (queryStr.includes("SELECT id FROM projects")) {
          return { rows: [{ id: projectId }] } as any;
        }
        if (queryStr.includes("COUNT(*)::int AS total FROM functionality_inventory")) {
          return { rows: [{ total: 1 }] } as any;
        }
        if (queryStr.includes("FROM scenario_checklists sc")) {
          return {
            rows: [{ category: "positive", status: "generated", count: 3 }],
          } as any;
        }
        return { rows: [] } as any;
      });

      const response = await app.inject({
        method: "GET",
        url: `/projects/${projectId}/coverage`,
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.totalFunctionalities).toBe(1);
      expect(json.overallCoveragePercent).toBe(100);
    });
  });

  describe("6. Robust JSON Extraction & Retry Handling (extractJsonArray)", () => {
    it("extracts JSON array from markdown code fences and cleans chatter", () => {
      const rawText = "Here are your test cases:\n```json\n[\n  {\"title\": \"Case 1\", \"steps\": [\"goto /\"]}\n]\n```\nHope this helps!";
      const parsed = extractJsonArray(rawText);
      expect(Array.isArray(parsed)).toBe(true);
      expect((parsed as any)[0].title).toBe("Case 1");
    });
  });

  describe("7. Background Job Integration (ai_generation handler)", () => {
    it("handles loop-based generation when loop: true and siteData are provided", async () => {
      initializeJobHandlers();
      const handler = getJobHandler("ai_generation");
      expect(handler).toBeDefined();

      mockedPool.query.mockImplementation(async (sql: any) => {
        const queryStr = String(sql);
        if (queryStr.includes("pg_try_advisory_lock")) {
          return { rows: [{ locked: true }] } as any;
        }
        if (queryStr.includes("SELECT name FROM projects")) {
          return { rows: [{ name: "StockFlow" }] } as any;
        }
        if (queryStr.includes("SELECT title, scenario_id FROM test_cases")) {
          return { rows: [] } as any;
        }
        if (queryStr.includes("INSERT INTO test_cases")) {
          return {
            rows: [
              {
                id: "tc-uuid-job-1",
                title: "Verify items on /inventory",
                review_status: "pending",
              },
            ],
          } as any;
        }
        return { rowCount: 1, rows: [] } as any;
      });

      mockedAi.responseText = JSON.stringify([
        {
          title: "Verify items on /inventory",
          description: "Job test case",
          steps: ["goto /inventory", "click #search-submit", "expect text Search inventory items"],
          expected_result: "Success",
        },
      ]);

      const jobPayload = {
        projectId,
        loop: true,
        siteData: {
          isLoggedIn: false,
          loginSteps: [],
          pages: [
            {
              title: "Inventory",
              url: "https://example.test/inventory",
              path: "/inventory",
              headings: ["Items"],
              text: "Search inventory items",
              elements: [{ tag: "button", selector: "#search-submit", text: "Search" }],
            },
          ],
        },
      };

      const result = await handler!(jobPayload, { id: "job-1" } as any);

      expect(result.mode).toBe("loop");
      expect(result.projectId).toBe(projectId);
      expect(result.totalFunctionalities).toBe(1);
      expect(result.createdCount).toBe(1);
    });

    it("throws error when background job encounters active generation lock", async () => {
      initializeJobHandlers();
      const handler = getJobHandler("ai_generation");

      mockDbClient.query.mockImplementation(async (sql: any) => {
        const queryStr = String(sql);
        if (queryStr.includes("pg_try_advisory_lock")) {
          return { rows: [{ locked: false }] } as any; // Concurrency conflict
        }
        return { rows: [] } as any;
      });

      const jobPayload = {
        projectId,
        loop: true,
        siteData: { isLoggedIn: false, loginSteps: [], pages: [] },
      };

      await expect(handler!(jobPayload, { id: "job-2" } as any)).rejects.toThrow(
        `Project ${projectId} test generation is already in progress`,
      );
      expect(mockDbClient.release).toHaveBeenCalled();
    });
  });

  describe("8. Dedicated PostgreSQL Advisory Lock & Concurrency Management (withProjectGenerationLock)", () => {
    it("acquires and releases advisory lock on the exact same checked-out client", async () => {
      const lockQueries: string[] = [];
      mockDbClient.query.mockImplementation(async (sql: any) => {
        const queryStr = String(sql);
        lockQueries.push(queryStr);
        if (queryStr.includes("pg_try_advisory_lock")) {
          return { rows: [{ locked: true }] } as any;
        }
        if (queryStr.includes("pg_advisory_unlock")) {
          return { rows: [{ unlocked: true }] } as any;
        }
        return { rows: [] } as any;
      });

      let operationExecuted = false;
      const res = await withProjectGenerationLock(projectId, async () => {
        operationExecuted = true;
        return "operation_success";
      });

      expect(res.acquired).toBe(true);
      if (res.acquired) {
        expect(res.result).toBe("operation_success");
      }
      expect(operationExecuted).toBe(true);

      // Verify connection was checked out from pool
      expect(pool.connect).toHaveBeenCalledTimes(1);

      // Verify lock was acquired and released on that exact same client
      expect(lockQueries.some((q) => q.includes("pg_try_advisory_lock"))).toBe(true);
      expect(lockQueries.some((q) => q.includes("pg_advisory_unlock"))).toBe(true);

      // Verify client was released back to pool
      expect(mockDbClient.release).toHaveBeenCalledTimes(1);
    });

    it("returns acquired: false and releases connection when lock cannot be obtained", async () => {
      mockDbClient.query.mockImplementation(async (sql: any) => {
        const queryStr = String(sql);
        if (queryStr.includes("pg_try_advisory_lock")) {
          return { rows: [{ locked: false }] } as any; // Lock held
        }
        return { rows: [] } as any;
      });

      let operationCalled = false;
      const res = await withProjectGenerationLock(projectId, async () => {
        operationCalled = true;
        return "should_not_run";
      });

      expect(res.acquired).toBe(false);
      expect(operationCalled).toBe(false);

      // Unlock should not be called because lock was never acquired
      const unlockCalled = mockDbClient.query.mock.calls.some((c) =>
        String(c[0]).includes("pg_advisory_unlock"),
      );
      expect(unlockCalled).toBe(false);

      // Dedicated client must be released cleanly
      expect(mockDbClient.release).toHaveBeenCalledTimes(1);
    });

    it("guarantees lock release and connection cleanup when operation throws an error", async () => {
      mockDbClient.query.mockImplementation(async (sql: any) => {
        const queryStr = String(sql);
        if (queryStr.includes("pg_try_advisory_lock")) {
          return { rows: [{ locked: true }] } as any;
        }
        if (queryStr.includes("pg_advisory_unlock")) {
          return { rows: [{ unlocked: true }] } as any;
        }
        return { rows: [] } as any;
      });

      await expect(
        withProjectGenerationLock(projectId, async () => {
          throw new Error("Unexpected crash during AI generation");
        }),
      ).rejects.toThrow("Unexpected crash during AI generation");

      // Verify unlock was STILL called on the same client despite exception
      const unlockCalled = mockDbClient.query.mock.calls.some((c) =>
        String(c[0]).includes("pg_advisory_unlock"),
      );
      expect(unlockCalled).toBe(true);

      // Verify client was released in finally block
      expect(mockDbClient.release).toHaveBeenCalledTimes(1);
    });
  });
});
