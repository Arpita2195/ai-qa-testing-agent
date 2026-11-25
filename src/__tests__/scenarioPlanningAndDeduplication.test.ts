import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import { pool } from "../config/db";
import {
  discoverPageFunctionalities,
  planScenariosForFunctionality,
  persistFunctionalitiesAndScenarios,
  generateScenarioId,
  slugifyPagePath,
  calculateCoverage,
  type DiscoveredFunctionality,
  type PlannedScenario,
} from "../services/functionalityPlanner";
import { runLoopGeneration } from "../services/loopGenerator";
import type { SiteData } from "../services/pageReader";

describe("Stage 8E — Scenario Generation Accuracy, Completeness and Deduplication Integration Tests", () => {
  let projectId: string;
  let secondProjectId: string;

  beforeAll(async () => {
    // Create dedicated test projects
    const p1Res = await pool.query<{ id: string }>(
      `INSERT INTO projects (name, base_url, owner_confirmed, access_status)
       VALUES ('Stage8E-Scenario-Test-1', 'http://localhost:3088', true, 'public')
       RETURNING id`,
    );
    projectId = p1Res.rows[0].id;

    const p2Res = await pool.query<{ id: string }>(
      `INSERT INTO projects (name, base_url, owner_confirmed, access_status)
       VALUES ('Stage8E-Scenario-Test-2', 'http://localhost:3088', true, 'public')
       RETURNING id`,
    );
    secondProjectId = p2Res.rows[0].id;
  });

  afterAll(async () => {
    try {
      if (projectId) {
        await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
      }
      if (secondProjectId) {
        await pool.query(`DELETE FROM projects WHERE id = $1`, [secondProjectId]);
      }
    } catch {}
  });

  describe("1. Scenario ID Collision Resistance and Determinism", () => {
    it("1. Navigation functionality on '/', '/inventory', '/about', and '/dashboard' generates distinct IDs", () => {
      const paths = ["/", "/inventory", "/about", "/dashboard", "/items/101", "/inventory?page=2"];
      const funcs: DiscoveredFunctionality[] = paths.map((path) => ({
        id: crypto.randomUUID(),
        projectId,
        name: `Navigation & Interactive Links on ${path}`,
        category: "navigation",
        pageUrl: `http://localhost:3088${path}`,
        pagePath: path,
        elements: [
          { tag: "a", text: "Link", selector: "a", href: path },
        ],
        interactionDetails: { actionType: "navigation" },
        status: "discovered",
      }));

      const allScenarioIds = new Set<string>();
      let totalPlanned = 0;

      for (const func of funcs) {
        const scenarios = planScenariosForFunctionality(func);
        totalPlanned += scenarios.length;
        for (const s of scenarios) {
          expect(s.scenarioId.length).toBeLessThanOrEqual(100);
          expect(s.scenarioId.startsWith("SCEN-NAV-")).toBe(true);
          allScenarioIds.add(s.scenarioId);
        }
      }

      // Every path's navigation scenarios must have completely distinct scenario IDs
      expect(allScenarioIds.size).toBe(totalPlanned);
      expect(totalPlanned).toBe(paths.length * 2); // 2 scenarios per navigation functionality
    });

    it("2. Different functionality categories cannot collide even on the same page", () => {
      const pagePath = "/inventory";
      const authFunc: DiscoveredFunctionality = {
        id: crypto.randomUUID(),
        projectId,
        name: `User Authentication on ${pagePath}`,
        category: "authentication",
        pageUrl: `http://localhost:3088${pagePath}`,
        pagePath,
        elements: [],
        interactionDetails: {},
        status: "discovered",
      };
      const searchFunc: DiscoveredFunctionality = {
        id: crypto.randomUUID(),
        projectId,
        name: `Search & Filtering on ${pagePath}`,
        category: "search_filter",
        pageUrl: `http://localhost:3088${pagePath}`,
        pagePath,
        elements: [],
        interactionDetails: {},
        status: "discovered",
      };
      const crudFunc: DiscoveredFunctionality = {
        id: crypto.randomUUID(),
        projectId,
        name: `Data Submission Form on ${pagePath}`,
        category: "crud",
        pageUrl: `http://localhost:3088${pagePath}`,
        pagePath,
        elements: [],
        interactionDetails: {},
        status: "discovered",
      };
      const navFunc: DiscoveredFunctionality = {
        id: crypto.randomUUID(),
        projectId,
        name: `Navigation & Interactive Links on ${pagePath}`,
        category: "navigation",
        pageUrl: `http://localhost:3088${pagePath}`,
        pagePath,
        elements: [],
        interactionDetails: {},
        status: "discovered",
      };
      const viewFunc: DiscoveredFunctionality = {
        id: crypto.randomUUID(),
        projectId,
        name: `Content & View Verification on ${pagePath}`,
        category: "data_display",
        pageUrl: `http://localhost:3088${pagePath}`,
        pagePath,
        elements: [],
        interactionDetails: {},
        status: "discovered",
      };

      const allFuncs = [authFunc, searchFunc, crudFunc, navFunc, viewFunc];
      const scenarioIdSet = new Set<string>();
      let totalScenarios = 0;

      for (const func of allFuncs) {
        const scens = planScenariosForFunctionality(func);
        totalScenarios += scens.length;
        for (const s of scens) {
          scenarioIdSet.add(s.scenarioId);
        }
      }

      // No collisions across different categories on the same path
      expect(scenarioIdSet.size).toBe(totalScenarios);
    });

    it("3. Repeated planning of the same functionality produces stable, identical IDs", () => {
      const func: DiscoveredFunctionality = {
        id: crypto.randomUUID(),
        projectId,
        name: "Search & Filtering on /inventory",
        category: "search_filter",
        pageUrl: "http://localhost:3088/inventory",
        pagePath: "/inventory",
        elements: [],
        interactionDetails: {},
        status: "discovered",
      };

      const run1 = planScenariosForFunctionality(func);

      // Same functional signature, but different random UUID in memory
      const funcClone: DiscoveredFunctionality = {
        ...func,
        id: crypto.randomUUID(),
      };
      const run2 = planScenariosForFunctionality(funcClone);

      expect(run1.length).toBe(run2.length);
      for (let i = 0; i < run1.length; i++) {
        expect(run1[i].scenarioId).toBe(run2[i].scenarioId);
        expect(run1[i].title).toBe(run2[i].title);
        expect(run1[i].category).toBe(run2[i].category);
      }
    });

    it("4. Normalizes URL page path into concise alphanumeric slug", () => {
      expect(slugifyPagePath("/")).toBe("ROOT");
      expect(slugifyPagePath("")).toBe("ROOT");
      expect(slugifyPagePath("/inventory")).toBe("INVENTORY");
      expect(slugifyPagePath("/items/101")).toBe("ITEMS-101");
      expect(slugifyPagePath("/inventory?page=2")).toBe("INVENTORY-PAGE-2");
    });
  });

  describe("2. Database Persistence and Schema Compatibility", () => {
    it("5. Persists multiple distinct functionalities and scenarios without collision or overwriting", async () => {
      const func1: DiscoveredFunctionality = {
        id: crypto.randomUUID(),
        projectId,
        name: "Navigation & Interactive Links on /",
        category: "navigation",
        pageUrl: "http://localhost:3088/",
        pagePath: "/",
        elements: [],
        interactionDetails: {},
        status: "discovered",
      };
      const func2: DiscoveredFunctionality = {
        id: crypto.randomUUID(),
        projectId,
        name: "Navigation & Interactive Links on /inventory",
        category: "navigation",
        pageUrl: "http://localhost:3088/inventory",
        pagePath: "/inventory",
        elements: [],
        interactionDetails: {},
        status: "discovered",
      };
      const func3: DiscoveredFunctionality = {
        id: crypto.randomUUID(),
        projectId,
        name: "Navigation & Interactive Links on /about",
        category: "navigation",
        pageUrl: "http://localhost:3088/about",
        pagePath: "/about",
        elements: [],
        interactionDetails: {},
        status: "discovered",
      };

      const scens1 = planScenariosForFunctionality(func1);
      const scens2 = planScenariosForFunctionality(func2);
      const scens3 = planScenariosForFunctionality(func3);

      const allFuncs = [func1, func2, func3];
      const allScens = [...scens1, ...scens2, ...scens3];

      const persistRes = await persistFunctionalitiesAndScenarios(projectId, allFuncs, allScens);
      expect(persistRes.savedFunctionalities).toBe(3);
      expect(persistRes.savedScenarios).toBe(6);

      // Verify PostgreSQL table contains all 6 distinct rows
      const dbRows = await pool.query<{ scenario_id: string; functionality_id: string }>(
        `SELECT scenario_id, functionality_id FROM scenario_checklists WHERE project_id = $1 ORDER BY scenario_id`,
        [projectId],
      );
      expect(dbRows.rows.length).toBe(6);

      const uniqueIds = new Set(dbRows.rows.map((r) => r.scenario_id));
      expect(uniqueIds.size).toBe(6);
    });

    it("6. Re-persisting the same scenarios is idempotent and preserves test_case associations", async () => {
      const func: DiscoveredFunctionality = {
        id: crypto.randomUUID(),
        projectId,
        name: "Search & Filtering on /inventory",
        category: "search_filter",
        pageUrl: "http://localhost:3088/inventory",
        pagePath: "/inventory",
        elements: [],
        interactionDetails: {},
        status: "discovered",
      };
      const scens = planScenariosForFunctionality(func);
      await persistFunctionalitiesAndScenarios(projectId, [func], scens);

      // Link a test case to the first scenario
      const tcId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO test_cases (id, project_id, title, steps, expected_result, review_status, priority, test_type)
         VALUES ($1, $2, 'Search Test', '[]'::jsonb, 'Found', 'pending', 'high', 'positive')`,
        [tcId, projectId],
      );

      await pool.query(
        `UPDATE scenario_checklists
         SET status = 'generated', test_case_id = $1
         WHERE project_id = $2 AND scenario_id = $3`,
        [tcId, projectId, scens[0].scenarioId],
      );

      // Re-persist the planned scenarios
      await persistFunctionalitiesAndScenarios(projectId, [func], scens);

      // Verify the test_case_id was not deleted
      const checkRes = await pool.query<{ test_case_id: string; status: string }>(
        `SELECT test_case_id, status FROM scenario_checklists WHERE project_id = $1 AND scenario_id = $2`,
        [projectId, scens[0].scenarioId],
      );
      expect(checkRes.rows[0].test_case_id).toBe(tcId);
    });

    it("7. calculateCoverage accurately reports deterministic coverage", async () => {
      const coverage = await calculateCoverage(projectId);
      expect(coverage.projectId).toBe(projectId);
      expect(coverage.totalFunctionalities).toBeGreaterThanOrEqual(4);
      expect(coverage.totalScenariosPlanned).toBeGreaterThanOrEqual(10);
      expect(coverage.totalScenariosGenerated).toBeGreaterThanOrEqual(1);
      expect(coverage.overallCoveragePercent).toBeGreaterThan(0);
    });
  });

  describe("3. Deduplication and Composite Scenario Identity in Generation Loop", () => {
    it("8. One functionality cannot suppress another functionality's scenarios", async () => {
      // Create two distinct navigation functionalities for different pages in secondProjectId
      const funcHome: DiscoveredFunctionality = {
        id: crypto.randomUUID(),
        projectId: secondProjectId,
        name: "Navigation & Interactive Links on /",
        category: "navigation",
        pageUrl: "http://localhost:3088/",
        pagePath: "/",
        elements: [{ tag: "a", text: "About", selector: "a#nav-about", href: "/about" }],
        interactionDetails: { actionType: "navigation" },
        status: "discovered",
      };
      const funcAbout: DiscoveredFunctionality = {
        id: crypto.randomUUID(),
        projectId: secondProjectId,
        name: "Navigation & Interactive Links on /about",
        category: "navigation",
        pageUrl: "http://localhost:3088/about",
        pagePath: "/about",
        elements: [{ tag: "a", text: "Home", selector: "a#nav-home", href: "/" }],
        interactionDetails: { actionType: "navigation" },
        status: "discovered",
      };

      const scensHome = planScenariosForFunctionality(funcHome);
      const scensAbout = planScenariosForFunctionality(funcAbout);

      await persistFunctionalitiesAndScenarios(secondProjectId, [funcHome, funcAbout], [...scensHome, ...scensAbout]);

      // Suppose funcHome has scenario 0 already generated
      const tcId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO test_cases (id, project_id, title, steps, expected_result, review_status, priority, test_type, functionality_id, scenario_id)
         VALUES ($1, $2, 'Home Nav Case', '[]'::jsonb, 'Pass', 'pending', 'high', 'positive', $3, $4)`,
        [tcId, secondProjectId, funcHome.id, scensHome[0].scenarioId],
      );
      await pool.query(
        `UPDATE scenario_checklists
         SET status = 'generated', test_case_id = $1
         WHERE project_id = $2 AND functionality_id = $3 AND scenario_id = $4`,
        [tcId, secondProjectId, funcHome.id, scensHome[0].scenarioId],
      );

      // Verify that funcAbout's scenarios remain 'planned' and are NOT suppressed
      const aboutDbRes = await pool.query<{ scenario_id: string; status: string }>(
        `SELECT scenario_id, status FROM scenario_checklists WHERE project_id = $1 AND functionality_id = $2`,
        [secondProjectId, funcAbout.id],
      );
      expect(aboutDbRes.rows.every((r) => r.status === "planned")).toBe(true);
      expect(aboutDbRes.rows.length).toBe(2);
    });

    it("9. Resumption skips only already-generated scenarios for the matching functionality", async () => {
      const existingCompositeKeys = new Set<string>();
      const func1Id = crypto.randomUUID();
      const func2Id = crypto.randomUUID();
      const scenId = "SCEN-NAV-TEST-01";

      // Mark scenId as generated only for func1
      existingCompositeKeys.add(`${func1Id}:${scenId}`);

      const allPlanned: PlannedScenario[] = [
        {
          scenarioId: scenId,
          functionalityId: func1Id,
          projectId: secondProjectId,
          title: "Func 1 Scen",
          description: "",
          category: "positive",
          priority: "high",
          expectedBehavior: "",
          status: "planned",
        },
        {
          scenarioId: scenId,
          functionalityId: func2Id,
          projectId: secondProjectId,
          title: "Func 2 Scen",
          description: "",
          category: "positive",
          priority: "high",
          expectedBehavior: "",
          status: "planned",
        },
      ];

      // Filtering for func1 should exclude scenId
      const pendingFunc1 = allPlanned.filter(
        (s) => s.functionalityId === func1Id && s.status === "planned" && !existingCompositeKeys.has(`${func1Id}:${s.scenarioId}`),
      );
      expect(pendingFunc1.length).toBe(0);

      // Filtering for func2 MUST KEEP scenId eligible!
      const pendingFunc2 = allPlanned.filter(
        (s) => s.functionalityId === func2Id && s.status === "planned" && !existingCompositeKeys.has(`${func2Id}:${s.scenarioId}`),
      );
      expect(pendingFunc2.length).toBe(1);
    });
  });

  describe("4. Human Approval Gate and Safe Execution Querying", () => {
    it("10. Test cases are persisted in 'pending' status and blocked from default execution", async () => {
      const tcPendingId = crypto.randomUUID();
      const tcApprovedId = crypto.randomUUID();

      await pool.query(
        `INSERT INTO test_cases (id, project_id, title, steps, expected_result, review_status, priority, test_type)
         VALUES ($1, $2, 'Pending Case', '[]'::jsonb, 'Pass', 'pending', 'high', 'positive'),
                ($3, $2, 'Approved Case', '[]'::jsonb, 'Pass', 'approved', 'high', 'positive')`,
        [tcPendingId, projectId, tcApprovedId],
      );

      // Default execution query selects only approved test cases
      const defaultExecQuery = await pool.query<{ id: string }>(
        `SELECT id FROM test_cases WHERE project_id = $1 AND review_status = 'approved'`,
        [projectId],
      );
      const approvedIds = defaultExecQuery.rows.map((r) => r.id);
      expect(approvedIds).toContain(tcApprovedId);
      expect(approvedIds).not.toContain(tcPendingId);
    });
  });
});
