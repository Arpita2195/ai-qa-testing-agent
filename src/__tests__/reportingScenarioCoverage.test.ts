import { describe, it, expect, afterAll } from "vitest";
import crypto from "node:crypto";
import { pool } from "../config/db";
import { reportingService } from "../services/reportingService";
import { calculateCoverage } from "../services/functionalityPlanner";

describe("Stage 8G: Reporting Scenario Coverage Regression Tests", () => {
  const createdProjectIds: string[] = [];

  afterAll(async () => {
    for (const pid of createdProjectIds) {
      try {
        await pool.query("DELETE FROM projects WHERE id = $1", [pid]);
      } catch (err) {
        console.error("Cleanup error in reportingScenarioCoverage.test:", err);
      }
    }
  });

  async function createTestProjectWithFunctionality(name: string): Promise<{ projectId: string; funcId: string }> {
    const projectId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO projects (id, name, base_url, owner_confirmed, access_status)
       VALUES ($1, $2, 'https://example.test', true, 'public')`,
      [projectId, name]
    );
    createdProjectIds.push(projectId);

    const funcId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO functionality_inventory (id, project_id, name, category, page_url, page_path, elements, interaction_details, status)
       VALUES ($1, $2, 'Core Functionality', 'navigation', 'https://example.test/', '/', '[]', '{}', 'completed')`,
      [funcId, projectId]
    );

    return { projectId, funcId };
  }

  // A. 31 planned, 6 generated, 25 skipped:
  // Planned = 31, Generated = 6, Coverage = 19.4%
  it("A. Computes accurate coverage for 31 planned, 6 generated, 25 skipped", async () => {
    const { projectId, funcId } = await createTestProjectWithFunctionality("Test-A-31-Planned-6-Gen-25-Skip");

    // Insert 6 generated test cases
    const tcIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const tcId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO test_cases (id, project_id, functionality_id, title, test_type, priority, review_status, steps, expected_result)
         VALUES ($1, $2, $3, $4, 'positive', 'high', 'approved', '[]', 'Success')`,
        [tcId, projectId, funcId, `Test Case ${i + 1}`]
      );
      tcIds.push(tcId);
    }

    // Insert 31 scenario checklists: 6 generated, 25 skipped
    for (let i = 0; i < 6; i++) {
      await pool.query(
        `INSERT INTO scenario_checklists (project_id, functionality_id, scenario_id, title, category, priority, status, test_case_id)
         VALUES ($1, $2, $3, $4, 'positive', 'high', 'generated', $5)`,
        [projectId, funcId, `SCEN-GEN-${i + 1}`, `Generated Scenario ${i + 1}`, tcIds[i]]
      );
    }
    for (let i = 6; i < 31; i++) {
      await pool.query(
        `INSERT INTO scenario_checklists (project_id, functionality_id, scenario_id, title, category, priority, status, test_case_id, error_message)
         VALUES ($1, $2, $3, $4, 'negative', 'medium', 'skipped', NULL, 'Skipped in single-batch run')`,
        [projectId, funcId, `SCEN-SKIP-${i + 1}`, `Skipped Scenario ${i + 1}`]
      );
    }

    const coverage = await reportingService.getCoverageReport(projectId);
    const scenCov = coverage.scenarioGenerationCoverage;

    expect(scenCov.plannedScenarios).toBe(31);
    expect(scenCov.generatedScenarios).toBe(6);
    expect(scenCov.coveragePercent).toBe(19.4); // 6 / 31 * 100 = 19.3548... rounded to 19.4

    // Check category coverage
    expect(coverage.categoryCoverage.positive.planned).toBe(6);
    expect(coverage.categoryCoverage.positive.generated).toBe(6);
    expect(coverage.categoryCoverage.positive.percent).toBe(100.0);

    expect(coverage.categoryCoverage.negative.planned).toBe(25);
    expect(coverage.categoryCoverage.negative.generated).toBe(0);
    expect(coverage.categoryCoverage.negative.percent).toBe(0.0);

    // Verify functionalityPlanner calculateCoverage parity
    const fpCoverage = await calculateCoverage(projectId);
    expect(fpCoverage.totalScenariosPlanned).toBe(31);
    expect(fpCoverage.totalScenariosGenerated).toBe(6);
    expect(fpCoverage.overallCoveragePercent).toBe(19.4);
  });

  // B. 31 planned, 31 generated:
  // Planned = 31, Generated = 31, Coverage = 100%
  it("B. Computes 100% coverage when all 31 planned scenarios are generated", async () => {
    const { projectId, funcId } = await createTestProjectWithFunctionality("Test-B-31-Planned-31-Gen");

    for (let i = 0; i < 31; i++) {
      const tcId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO test_cases (id, project_id, functionality_id, title, test_type, priority, review_status, steps, expected_result)
         VALUES ($1, $2, $3, $4, 'positive', 'high', 'approved', '[]', 'Success')`,
        [tcId, projectId, funcId, `Test Case B ${i + 1}`]
      );

      await pool.query(
        `INSERT INTO scenario_checklists (project_id, functionality_id, scenario_id, title, category, priority, status, test_case_id)
         VALUES ($1, $2, $3, $4, 'positive', 'high', 'generated', $5)`,
        [projectId, funcId, `SCEN-B-${i + 1}`, `Scenario B ${i + 1}`, tcId]
      );
    }

    const coverage = await reportingService.getCoverageReport(projectId);
    const scenCov = coverage.scenarioGenerationCoverage;

    expect(scenCov.plannedScenarios).toBe(31);
    expect(scenCov.generatedScenarios).toBe(31);
    expect(scenCov.coveragePercent).toBe(100.0);
  });

  // C. 31 planned, 0 generated, 31 skipped:
  // Planned = 31, Generated = 0, Coverage = 0%
  it("C. Computes 0% coverage when all 31 planned scenarios are skipped", async () => {
    const { projectId, funcId } = await createTestProjectWithFunctionality("Test-C-31-Planned-0-Gen-31-Skip");

    for (let i = 0; i < 31; i++) {
      await pool.query(
        `INSERT INTO scenario_checklists (project_id, functionality_id, scenario_id, title, category, priority, status, test_case_id, error_message)
         VALUES ($1, $2, $3, $4, 'boundary', 'low', 'skipped', NULL, 'Skipped due to provider failure')`,
        [projectId, funcId, `SCEN-C-${i + 1}`, `Scenario C ${i + 1}`]
      );
    }

    const coverage = await reportingService.getCoverageReport(projectId);
    const scenCov = coverage.scenarioGenerationCoverage;

    expect(scenCov.plannedScenarios).toBe(31);
    expect(scenCov.generatedScenarios).toBe(0);
    expect(scenCov.coveragePercent).toBe(0.0);
  });

  // D. Include failed scenarios in the denominator
  it("D. Includes failed scenarios in the planned denominator alongside skipped and generated", async () => {
    const { projectId, funcId } = await createTestProjectWithFunctionality("Test-D-Include-Failed-In-Denominator");

    // 20 total: 5 generated, 5 failed, 5 skipped, 5 planned
    const tcIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const tcId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO test_cases (id, project_id, functionality_id, title, test_type, priority, review_status, steps, expected_result)
         VALUES ($1, $2, $3, $4, 'positive', 'high', 'approved', '[]', 'Success')`,
        [tcId, projectId, funcId, `Test Case D ${i + 1}`]
      );
      tcIds.push(tcId);
    }

    for (let i = 0; i < 5; i++) {
      await pool.query(
        `INSERT INTO scenario_checklists (project_id, functionality_id, scenario_id, title, category, priority, status, test_case_id)
         VALUES ($1, $2, $3, $4, 'positive', 'high', 'generated', $5)`,
        [projectId, funcId, `SCEN-D-GEN-${i + 1}`, `Generated ${i + 1}`, tcIds[i]]
      );
    }

    for (let i = 0; i < 5; i++) {
      await pool.query(
        `INSERT INTO scenario_checklists (project_id, functionality_id, scenario_id, title, category, priority, status, test_case_id, error_message)
         VALUES ($1, $2, $3, $4, 'negative', 'high', 'failed', NULL, 'AI Provider rate limit exhausted')`,
        [projectId, funcId, `SCEN-D-FAIL-${i + 1}`, `Failed ${i + 1}`]
      );
    }

    for (let i = 0; i < 5; i++) {
      await pool.query(
        `INSERT INTO scenario_checklists (project_id, functionality_id, scenario_id, title, category, priority, status, test_case_id, error_message)
         VALUES ($1, $2, $3, $4, 'boundary', 'medium', 'skipped', NULL, 'Skipped on replenishment')`,
        [projectId, funcId, `SCEN-D-SKIP-${i + 1}`, `Skipped ${i + 1}`]
      );
    }

    for (let i = 0; i < 5; i++) {
      await pool.query(
        `INSERT INTO scenario_checklists (project_id, functionality_id, scenario_id, title, category, priority, status, test_case_id)
         VALUES ($1, $2, $3, $4, 'edge_case', 'low', 'planned', NULL)`,
        [projectId, funcId, `SCEN-D-PLAN-${i + 1}`, `Planned ${i + 1}`]
      );
    }

    const coverage = await reportingService.getCoverageReport(projectId);
    const scenCov = coverage.scenarioGenerationCoverage;

    expect(scenCov.plannedScenarios).toBe(20);
    expect(scenCov.generatedScenarios).toBe(5);
    expect(scenCov.coveragePercent).toBe(25.0); // 5 / 20 * 100 = 25.0%
  });

  // E. Ensure skipped scenarios never count as generated
  it("E. Never counts skipped scenarios as generated, even if test_case_id is populated or status varies", async () => {
    const { projectId, funcId } = await createTestProjectWithFunctionality("Test-E-Skipped-Never-Count-As-Generated");

    const dummyTcId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO test_cases (id, project_id, functionality_id, title, test_type, priority, review_status, steps, expected_result)
       VALUES ($1, $2, $3, 'Dummy Case', 'positive', 'high', 'approved', '[]', 'Success')`,
      [dummyTcId, projectId, funcId]
    );

    // Insert 10 skipped scenarios, 5 with test_case_id populated and 5 with NULL
    for (let i = 0; i < 5; i++) {
      await pool.query(
        `INSERT INTO scenario_checklists (project_id, functionality_id, scenario_id, title, category, priority, status, test_case_id, error_message)
         VALUES ($1, $2, $3, $4, 'positive', 'high', 'skipped', $5, 'Skipped')`,
        [projectId, funcId, `SCEN-E-1-${i + 1}`, `Skipped With Ref ${i + 1}`, dummyTcId]
      );
    }
    for (let i = 5; i < 10; i++) {
      await pool.query(
        `INSERT INTO scenario_checklists (project_id, functionality_id, scenario_id, title, category, priority, status, test_case_id, error_message)
         VALUES ($1, $2, $3, $4, 'positive', 'high', 'skipped', NULL, 'Skipped No Ref')`,
        [projectId, funcId, `SCEN-E-2-${i + 1}`, `Skipped No Ref ${i + 1}`]
      );
    }

    const coverage = await reportingService.getCoverageReport(projectId);
    const scenCov = coverage.scenarioGenerationCoverage;

    expect(scenCov.plannedScenarios).toBe(10);
    expect(scenCov.generatedScenarios).toBe(0); // STRICTLY 0
    expect(scenCov.coveragePercent).toBe(0.0);
  });

  // F. Ensure reporting API and executive summary show consistent figures
  it("F. Reporting API and executive summary show consistent figures", async () => {
    const { projectId, funcId } = await createTestProjectWithFunctionality("Test-F-Consistent-Reporting-API-Figures");

    // 31 planned: 6 generated, 25 skipped
    const tcIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const tcId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO test_cases (id, project_id, functionality_id, title, test_type, priority, review_status, steps, expected_result)
         VALUES ($1, $2, $3, $4, 'positive', 'high', 'approved', '[]', 'Success')`,
        [tcId, projectId, funcId, `Test Case F ${i + 1}`]
      );
      tcIds.push(tcId);
    }

    for (let i = 0; i < 6; i++) {
      await pool.query(
        `INSERT INTO scenario_checklists (project_id, functionality_id, scenario_id, title, category, priority, status, test_case_id)
         VALUES ($1, $2, $3, $4, 'positive', 'high', 'generated', $5)`,
        [projectId, funcId, `SCEN-F-GEN-${i + 1}`, `Generated ${i + 1}`, tcIds[i]]
      );
    }
    for (let i = 6; i < 31; i++) {
      await pool.query(
        `INSERT INTO scenario_checklists (project_id, functionality_id, scenario_id, title, category, priority, status, test_case_id, error_message)
         VALUES ($1, $2, $3, $4, 'negative', 'medium', 'skipped', NULL, 'Skipped')`,
        [projectId, funcId, `SCEN-F-SKIP-${i + 1}`, `Skipped ${i + 1}`]
      );
    }

    const coverageReport = await reportingService.getCoverageReport(projectId);
    const execSummary = await reportingService.getExecutiveSummary(projectId);

    // Both must report the exact same scenario coverage
    expect(coverageReport.scenarioGenerationCoverage.coveragePercent).toBe(19.4);
    expect(execSummary.coverage.scenarioCoverage).toBe(19.4);
    expect(coverageReport.scenarioGenerationCoverage.plannedScenarios).toBe(31);
    expect(coverageReport.scenarioGenerationCoverage.generatedScenarios).toBe(6);
  });
});
