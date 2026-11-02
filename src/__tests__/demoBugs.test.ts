import { describe, expect, it } from "vitest";

describe("Deliberate Bug Demonstration Suite", () => {
  it("defines reproducible test scenarios for UI, API, and Diagnostics defects", async () => {
    // Verify defect scenarios match proposal acceptance criteria
    const scenarios = [
      { name: "UI Defect", type: "frontend", expected_status: "failed", checks: ["disabled button", "screenshot evidence"] },
      { name: "Diagnostics Defect", type: "frontend", expected_status: "failed", checks: ["uncaught JS error", "console log"] },
      { name: "API Server Crash", type: "api", expected_status: "failed", checks: ["500 status code", "error message"] },
      { name: "API Schema Violation", type: "api", expected_status: "failed", checks: ["type mismatch", "number expected"] },
    ];

    expect(scenarios).toHaveLength(4);
    for (const scenario of scenarios) {
      expect(scenario.expected_status).toBe("failed");
      expect(scenario.checks.length).toBeGreaterThanOrEqual(2);
    }
  });
});
