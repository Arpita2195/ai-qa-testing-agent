import { describe, it, expect, vi } from "vitest";
import { runLoopGeneration } from "../services/loopGenerator";
import { pool } from "../config/db";

// Mock AI provider
vi.mock("../services/ai/providerFactory", () => ({
  getAIProviderForProject: vi.fn().mockResolvedValue({
    providerType: "gemini",
    defaultModel: "gemini-3.1-flash-lite",
    generateTestCases: vi.fn().mockResolvedValue({
      rawText: "[]",
      testCases: [],
      promptTokens: 10,
      completionTokens: 10,
    }),
  }),
  isRetryableAIError: vi.fn().mockReturnValue(false),
}));

// Mock two stage review
vi.mock("../services/ai/twoStageReviewService", () => ({
  reviewCandidateBatch: vi.fn().mockResolvedValue({
    reviewedCases: [],
    rejectedCount: 0,
    diagnostics: [],
  }),
}));

// Mock AI Budget service
vi.mock("../services/ai/aiBudgetService", () => ({
  assertProjectAiBudgetAvailable: vi.fn().mockResolvedValue(undefined),
  reserveAiBudget: vi.fn().mockResolvedValue({
    id: "res-1",
    ownerToken: "token-1",
    reservedCostUsd: 0.01,
  }),
  reconcileAiBudgetReservation: vi.fn().mockResolvedValue(undefined),
  releaseAiBudgetReservation: vi.fn().mockResolvedValue(undefined),
  startReservationHeartbeat: vi.fn().mockReturnValue({ stop: vi.fn() }),
  markReservationUncertain: vi.fn().mockResolvedValue(undefined),
  isConfirmedProviderFailure: vi.fn().mockReturnValue(false),
}));

describe("Generation Resilience, Self-Healing Planning & Scope Fixes", () => {
  const projectId = "00000000-0000-0000-0000-000000000001";

  it("1. Self-heals when existing functionalities in DB have 0 planned scenarios", async () => {
    // Functionality exists but scenario_checklists is empty for it
    const mockFunc = {
      id: "func-billing-1",
      projectId,
      name: "Data Submission Form on /billing",
      category: "crud" as const,
      pageUrl: "http://localhost:3000/billing",
      pagePath: "/billing",
      elements: [
        { tag: "input", selector: "#invoice-no", type: "text" },
        { tag: "button", selector: "#submit-btn", text: "Create Invoice" },
      ],
      interactionDetails: { actionType: "form_submission" },
      status: "discovered" as const,
    };

    const siteData = {
      baseUrl: "http://localhost:3000",
      isLoggedIn: true,
      loginSteps: [],
      pages: [
        {
          url: "http://localhost:3000/billing",
          path: "/billing",
          title: "Billing Page",
          elements: mockFunc.elements,
        },
      ],
    };

    // Spy on database queries
    const querySpy = vi.spyOn(pool, "query").mockImplementation(async (sql: any, params?: any) => {
      const q = String(sql);
      if (q.includes("FROM functionality_inventory")) {
        return { rows: [mockFunc], rowCount: 1 } as any;
      }
      if (q.includes("FROM scenario_checklists sc") || q.includes("FROM scenario_checklists")) {
        return { rows: [], rowCount: 0 } as any; // 0 planned scenarios initially!
      }
      if (q.includes("FROM test_cases")) {
        return { rows: [], rowCount: 0 } as any;
      }
      if (q.includes("INSERT INTO scenario_checklists")) {
        return { rows: [{ id: "new-scen-id" }], rowCount: 1 } as any;
      }
      return { rows: [], rowCount: 1 } as any;
    });

    const result = await runLoopGeneration(siteData as any, {
      projectId,
      appName: "TestApp",
      resume: true,
      targetPath: "/billing",
    });

    // Verify scenarios were automatically planned on the fly (crud produces 4 scenarios)
    expect(result.totalScenariosPlanned).toBe(4);
    querySpy.mockRestore();
  });

  it("2. Scopes generation to targetPath and leaves other functionalities untouched", async () => {
    const billingFunc = {
      id: "func-billing",
      projectId,
      name: "Data Submission Form on /billing",
      category: "crud" as const,
      pageUrl: "http://localhost:3000/billing",
      pagePath: "/billing",
      elements: [{ tag: "button", selector: "#save", text: "Save" }],
      interactionDetails: {},
      status: "discovered" as const,
    };

    const reportsFunc = {
      id: "func-reports",
      projectId,
      name: "Navigation on /reports",
      category: "navigation" as const,
      pageUrl: "http://localhost:3000/reports",
      pagePath: "/reports",
      elements: [{ tag: "a", selector: "#rep", text: "Reports", href: "/reports" }],
      interactionDetails: {},
      status: "discovered" as const,
    };

    const siteData = {
      baseUrl: "http://localhost:3000",
      isLoggedIn: true,
      loginSteps: [],
      pages: [
        {
          url: "http://localhost:3000/billing",
          path: "/billing",
          title: "Billing",
          elements: billingFunc.elements,
        },
      ],
    };

    const updatedChecklists: any[] = [];
    const querySpy = vi.spyOn(pool, "query").mockImplementation(async (sql: any, params?: any) => {
      const q = String(sql);
      if (q.includes("FROM functionality_inventory")) {
        return { rows: [billingFunc, reportsFunc], rowCount: 2 } as any;
      }
      if (q.includes("FROM scenario_checklists")) {
        return {
          rows: [
            { functionality_id: "func-billing", scenario_id: "SCEN-BILLING-1", status: "planned", test_case_id: null },
            { functionality_id: "func-reports", scenario_id: "SCEN-REPORTS-1", status: "planned", test_case_id: null },
          ],
          rowCount: 2,
        } as any;
      }
      if (q.includes("FROM test_cases")) {
        return { rows: [], rowCount: 0 } as any;
      }
      if (q.includes("UPDATE scenario_checklists SET status = 'skipped'")) {
        updatedChecklists.push(params);
        return { rowCount: 1 } as any;
      }
      return { rows: [], rowCount: 1 } as any;
    });

    const result = await runLoopGeneration(siteData as any, {
      projectId,
      appName: "TestApp",
      resume: true,
      targetPath: "/billing",
    });

    // In-scope functionalities should only be billing functionalities (not reports)
    expect(result.totalFunctionalities).toBe(2);
    // Reports functionality must NOT be marked skipped
    expect(updatedChecklists.some((p) => p && p.includes("func-reports"))).toBe(false);

    querySpy.mockRestore();
  });
});
